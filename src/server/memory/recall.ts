// Wave 6: memory retrieval, built on the search that already exists.
//
// No embeddings, no reranker, no second search service in this layer: candidate
// generation is the existing hybrid pipeline (exact slug/title/basename/alias,
// FTS, the structural title boost, the backlink boost) plus optional one-hop
// graph expansion. What this layer adds is the part a page search cannot do —
// resolving every hit back to canonical memory and applying status, scope and
// time filters.
//
// Two rules that are easy to get wrong and expensive to get wrong:
//   - A result is only returned if its canonical row is still `committed`. A
//     stale page that outlived its memory must never surface.
//   - Scope is never widened because a scope_id is missing. No id means no
//     match, not "everything".

import type { Db } from "../db";
import { type Store, likeLiteral } from "../store";
import type { MemoryItem, MemoryType, ScopeType } from "./items";
import { rowToMemory } from "./items";

export interface Scope {
  scopeType: ScopeType;
  scopeId?: string | null;
}

export interface RecallArgs {
  query: string;
  scopes: Scope[];
  limit?: number;
  types?: MemoryType[];
  /** Historical mode: what was true at this instant. Must be explicit. */
  asOf?: string;
  /** Follow declared edges one hop out from the matched projections. */
  expandGraph?: boolean;
}

export interface RecalledMemory {
  memory: MemoryItem;
  /** How the memory was found, for debugging and for the eval harness. */
  via: "search" | "key" | "graph";
  score: number;
}

// Scope predicate + params. Written once so current and historical recall cannot
// drift apart on the thing that matters most.
function scopeClause(scopes: Scope[], startIndex: number): { sql: string; params: unknown[] } {
  const pairs = scopes.map((s) => [s.scopeType, s.scopeId ?? ""] as const);
  return {
    sql: `(m.scope_type, coalesce(m.scope_id, '')) IN (
            SELECT * FROM unnest($${startIndex}::text[], $${startIndex + 1}::text[])
          )`,
    params: [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  };
}

// Active = committed right now. Everything the lifecycle retired is excluded,
// which is what makes a supersede or a revoke take effect immediately.
const ACTIVE_SQL = `m.status = 'committed'
  AND (m.expires_at IS NULL OR m.expires_at > now())`;

// What was true at $asOf: the row was valid then, whatever happened since. A
// superseded value is reachable here and only here.
const AS_OF_SQL = `m.valid_from <= $ASOF
  AND (m.valid_to IS NULL OR m.valid_to > $ASOF)
  AND m.status IN ('committed', 'superseded', 'expired')`;

async function memoriesForPages(
  db: Db,
  slugs: string[],
  args: RecallArgs,
): Promise<Map<string, MemoryItem>> {
  if (slugs.length === 0) return new Map();
  const scope = scopeClause(args.scopes, 2);
  const params: unknown[] = [slugs, ...scope.params];
  let temporal = ACTIVE_SQL;
  if (args.asOf) {
    params.push(args.asOf);
    temporal = AS_OF_SQL.replaceAll("$ASOF", `$${params.length}`);
  }
  let typeFilter = "";
  if (args.types?.length) {
    params.push(args.types);
    typeFilter = `AND m.memory_type = ANY($${params.length}::text[])`;
  }
  const res = await db.query(
    `SELECT m.*, p.slug AS page_slug
     FROM memory_items m
     JOIN pages p ON p.id = m.projection_page_id
     WHERE p.slug = ANY($1::text[]) AND ${scope.sql} AND ${temporal} ${typeFilter}`,
    params,
  );
  const out = new Map<string, MemoryItem>();
  for (const row of res.rows) out.set(String(row.page_slug), rowToMemory(row));
  return out;
}

// Historical recall CANNOT go through the page projection: retiring a memory
// removes its page (correct, so a superseded value leaves active search), which
// means a superseded row has nothing left to search. So as_of queries read
// canonical memory directly — which also makes them work when a projection has
// failed. Lexical arms mirror the store's: FTS for segmented text, ILIKE for CJK.
async function recallHistorical(db: Db, args: RecallArgs): Promise<RecalledMemory[]> {
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  const scope = scopeClause(args.scopes, 2);
  const params: unknown[] = [args.query.trim(), ...scope.params, args.asOf];
  const temporal = AS_OF_SQL.replaceAll("$ASOF", `$${params.length}`);
  let typeFilter = "";
  if (args.types?.length) {
    params.push(args.types);
    typeFilter = `AND m.memory_type = ANY($${params.length}::text[])`;
  }
  // The ILIKE arm needs its own param: unescaped, a query of "%" is a wildcard
  // that returns every memory in scope, which for as_of recall means handing back
  // superseded values nobody asked for. Same escaping the store's CJK arm uses.
  params.push(likeLiteral(args.query.trim()));
  const like = `$${params.length}`;
  params.push(limit);
  const res = await db.query(
    `SELECT m.* FROM memory_items m
     WHERE ${scope.sql} AND ${temporal} ${typeFilter}
       AND (
         to_tsvector('simple', m.content || ' ' || coalesce(m.memory_key, ''))
           @@ websearch_to_tsquery('simple', $1)
         OR m.content ILIKE '%' || ${like} || '%' ESCAPE '\\'
         OR coalesce(m.memory_key, '') ILIKE '%' || ${like} || '%' ESCAPE '\\'
       )
     ORDER BY m.valid_from DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((row) => ({ memory: rowToMemory(row), via: "key" as const, score: 0 }));
}

// Current recall: only what is true now.
export async function recallMemory(
  db: Db,
  store: Store,
  args: RecallArgs,
): Promise<RecalledMemory[]> {
  if (args.scopes.length === 0) return [];
  if (args.asOf) return recallHistorical(db, args);
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  const hits = await store.search({ query: args.query, limit: limit * 4 });
  const bySlug = await memoriesForPages(
    db,
    hits.map((h) => h.slug),
    args,
  );

  const out: RecalledMemory[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const memory = bySlug.get(hit.slug);
    if (!memory || seen.has(memory.id)) continue;
    seen.add(memory.id);
    out.push({ memory, via: "search", score: hit.score ?? 0 });
  }

  // One hop along DECLARED edges from the matched projections. The auto lane is
  // deliberately not followed: an inferred edge should not pull memory into a
  // context window.
  if (args.expandGraph && out.length > 0) {
    const matched = out.map((r) => r.memory.projection_page_id).filter((id): id is number => !!id);
    if (matched.length) {
      const scope = scopeClause(args.scopes, 2);
      const params: unknown[] = [matched, ...scope.params];
      let temporal = ACTIVE_SQL;
      if (args.asOf) {
        params.push(args.asOf);
        temporal = AS_OF_SQL.replaceAll("$ASOF", `$${params.length}`);
      }
      const near = await db.query(
        `SELECT DISTINCT m.* FROM edges e
         JOIN memory_items m ON m.projection_page_id IN (e.from_page_id, e.to_page_id)
         WHERE e.lane = 'declared'
           AND (e.from_page_id = ANY($1::bigint[]) OR e.to_page_id = ANY($1::bigint[]))
           AND ${scope.sql} AND ${temporal}
         LIMIT 50`,
        params,
      );
      for (const row of near.rows) {
        const memory = rowToMemory(row);
        if (seen.has(memory.id)) continue;
        seen.add(memory.id);
        // Graph neighbours rank below direct matches: they are context, not the
        // answer.
        out.push({ memory, via: "graph", score: 0 });
      }
    }
  }
  return out.slice(0, limit);
}

// Historical recall. Deliberately a separate entry point rather than a flag with
// a default: reading the past is something a caller has to ask for.
export function recallHistoricalMemory(
  db: Db,
  store: Store,
  args: RecallArgs & { asOf: string },
): Promise<RecalledMemory[]> {
  return recallMemory(db, store, args);
}

// Direct lookup for a known logical fact — no search involved, so it works even
// when a projection has failed.
export async function searchMemoryByKey(
  db: Db,
  args: { memoryKey: string; scopes: Scope[]; asOf?: string },
): Promise<MemoryItem[]> {
  if (args.scopes.length === 0) return [];
  const scope = scopeClause(args.scopes, 2);
  const params: unknown[] = [args.memoryKey, ...scope.params];
  let temporal = ACTIVE_SQL;
  if (args.asOf) {
    params.push(args.asOf);
    temporal = AS_OF_SQL.replaceAll("$ASOF", `$${params.length}`);
  }
  const res = await db.query(
    `SELECT m.* FROM memory_items m
     WHERE m.memory_key = $1 AND ${scope.sql} AND ${temporal}
     ORDER BY m.valid_from DESC`,
    params,
  );
  return res.rows.map(rowToMemory);
}

// --- the retrieval gate ------------------------------------------------------

export interface GateDecision {
  retrieve: boolean;
  reason: string;
  /** Historical intent detected: the caller should use as_of recall. */
  historical: boolean;
}

// Durable memory is NOT fetched for every model call. Deterministic on purpose:
// a rule that can be read is a rule that can be argued with, and this is the
// first implementation rather than the last.
const PRIOR_STATE =
  /\b(?:before|previously|earlier|last time|we (?:discussed|agreed|decided)|as (?:i|we) (?:said|mentioned)|remind me|did i (?:say|tell)|what did i)\b/i;
// Two shapes, both genuinely about stored personal state:
//   a QUESTION about something of the user's — "what is my billing email?"
//   an instruction to apply their stored way — "use my preferred format"
// A literal list of attribute words was tried first and was wrong: it missed
// "my billing email" because `email` was not the word right after `my`.
const PERSONALIZATION =
  /\b(?:what|which|where|who|when|how)\b[^?]*\b(?:my|our)\b|\b(?:my|our)\b[^?]*\?|\b(?:my|our)\s+(?:preferred|usual|default|standard|normal)\b|\bprefer\b|\bas usual\b|\blike (?:i|we) always\b/i;
const CONTINUATION =
  /\b(?:continue|resume|pick up|carry on|the (?:previous|earlier|last) (?:workflow|procedure|process|run))\b/i;
const HISTORICAL =
  /\b(?:used to be|was (?:it|the)|previous(?:ly)? (?:value|email|setting)|before (?:it|that) changed|what was)\b/i;
const PROCEDURE = /\b(?:how do (?:i|we)|steps to|procedure for|runbook|the usual way)\b/i;
// Self-contained work with no dependence on stored state.
const STATELESS =
  /^(?:\s*(?:what is|calculate|compute|convert|format|sum|add|multiply)\b|\s*\d+\s*[-+*/]\s*\d+)/i;

export function shouldRetrieveMemory(userInput: string, opts?: { force?: boolean }): GateDecision {
  const text = (userInput ?? "").trim();
  if (opts?.force) return { retrieve: true, reason: "caller forced retrieval", historical: false };
  if (!text) return { retrieve: false, reason: "empty input", historical: false };
  const historical = HISTORICAL.test(text);
  if (historical)
    return { retrieve: true, reason: "asks about a previous value", historical: true };
  if (PRIOR_STATE.test(text))
    return { retrieve: true, reason: "references prior interaction", historical: false };
  if (PERSONALIZATION.test(text))
    return { retrieve: true, reason: "needs personalization", historical: false };
  if (CONTINUATION.test(text))
    return { retrieve: true, reason: "continues earlier work", historical: false };
  if (PROCEDURE.test(text))
    return { retrieve: true, reason: "asks for a stored procedure", historical: false };
  if (STATELESS.test(text))
    return { retrieve: false, reason: "self-contained request", historical: false };
  return { retrieve: false, reason: "no memory dependency detected", historical: false };
}
