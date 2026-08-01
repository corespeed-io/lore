// Wave 6: memory retrieval, over TWO stores, because a memory lives in one of
// two places and which one is decided by scope.
//
//   SHARED (vault) memories are projected into pages/edges/FTS, so recall for a
//   vault scope is the existing hybrid pipeline (exact slug/title/basename/alias,
//   FTS, trigram, vector, the structural title boost, the backlink boost) plus
//   optional one-hop graph expansion, with every hit resolved back to canonical
//   memory and re-checked for status, scope and time.
//
//   THREAD- and AGENT-scoped memories are never written to the shared graph at
//   all (projection.ts explains why), so there is no page to search. They are
//   retrieved from memory_items directly — the CANONICAL arm below.
//
// The canonical arm is the shape the as_of path already had, generalized to both
// temporal modes rather than a second retrieval invented alongside it: ONE
// haystack, ONE lexical pair, ONE scope clause. Current and historical recall
// cannot drift apart on the thing that matters most.
//
// HONEST ABOUT QUALITY. The projected arm ranks with the full pipeline; the
// canonical arm has no page, so it has no chunk embeddings and no graph, and it
// does not pretend otherwise. It ranks on lexical evidence only: FTS over the
// same text the projection body used to expose (content + key + type) scored by
// ts_rank_cd, plus an escaped exact-substring arm that also carries CJK, which
// 'simple' tsvector cannot segment. That is strictly less than hybrid ranking —
// the cost of not putting private content in a shared index — and the two things
// it loses (vector recall for a paraphrase, graph expansion) are named here so
// nobody has to rediscover them. Salience and confidence are deliberately NOT in
// the formula: context.ts already weighs those when it packs a window, and
// scoring them twice would double-count.
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
import { isSharedScope } from "./projection";

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

// The text a canonical memory is matched against — the same three fields the
// projection body put in front of page search (its H1 is key + content, its
// Record block carries the type), so moving a scope out of the graph does not
// silently change WHAT is searchable, only where the search runs.
// structured_value is left out: it holds references and artifacts, which are
// metadata, and a query should not match a memory because of an id inside it.
const MEMORY_TEXT_SQL = `(m.content || ' ' || coalesce(m.memory_key, '') || ' ' || m.memory_type)`;
// Matching is OR over the query's terms, ranked by cover density — a page search
// could answer "billing email preference convention" from three different pages,
// and canonical retrieval has to be able to answer it from three different
// memories rather than requiring one row to contain every word. websearch_to_
// tsquery only builds AND, and to_tsquery cannot be handed raw user text (it
// throws on syntax), so the AND query's own sanitized text is rewritten to OR.
// Known widening: a negated term ("-foo bar") ORs its negation, so it matches
// more than websearch would; it is still ranked and still capped by the limit.
const ANY_TERM_SQL = `replace(websearch_to_tsquery('simple', $1)::text, '&', '|')::tsquery`;
// Two bonuses, deliberately the same order of magnitude as ts_rank_cd's output on
// this corpus (0.1 per matched term), so "contains every term I asked for" and
// "contains my phrase verbatim" outrank a one-term hit without erasing the
// density signal underneath them.
const ALL_TERMS_BONUS = 0.2;
const LITERAL_BONUS = 0.1;

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Number(limit) || 10, 1), 50);
}

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

// The CANONICAL arm: retrieval straight out of memory_items, for scopes that have
// no projection to search and for as_of, which never had one either (retiring a
// memory removes its page, so a superseded row has nothing left in the graph).
// Also the arm that keeps working when a projection has failed.
async function recallCanonical(db: Db, args: RecallArgs, limit: number): Promise<RecalledMemory[]> {
  const query = (args.query ?? "").trim();
  // An empty query is not "everything": ILIKE '%%' matches every memory in scope,
  // which in as_of mode means handing back superseded values nobody asked for.
  // store.search answers an empty query with [], and so does this.
  if (!query || args.scopes.length === 0) return [];
  const scope = scopeClause(args.scopes, 2);
  const params: unknown[] = [query, ...scope.params];
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
  // The ILIKE arm needs its own param: unescaped, a query of "%" is a wildcard
  // that returns every memory in scope. Same escaping the store's CJK arm uses.
  params.push(likeLiteral(query));
  const like = `${MEMORY_TEXT_SQL} ILIKE '%' || $${params.length} || '%' ESCAPE '\\'`;
  params.push(limit);
  // ponytail: to_tsvector is recomputed per row per reference — no index to use
  // on memory_items and no expression index worth a schema bump until a brain
  // holds enough memories for it to show up in a trace.
  const res = await db.query(
    `WITH q AS (
       SELECT websearch_to_tsquery('simple', $1) AS all_terms, ${ANY_TERM_SQL} AS any_term
     )
     SELECT m.*,
            ts_rank_cd(to_tsvector('simple', ${MEMORY_TEXT_SQL}), q.any_term)
              + CASE WHEN to_tsvector('simple', ${MEMORY_TEXT_SQL}) @@ q.all_terms
                     THEN ${ALL_TERMS_BONUS} ELSE 0 END
              + CASE WHEN ${like} THEN ${LITERAL_BONUS} ELSE 0 END AS rank
     FROM memory_items m, q
     WHERE ${scope.sql} AND ${temporal} ${typeFilter}
       AND (to_tsvector('simple', ${MEMORY_TEXT_SQL}) @@ q.any_term OR ${like})
     ORDER BY rank DESC, m.valid_from DESC
     LIMIT $${params.length}`,
    params,
  );
  // Normalized to this arm's own best hit, exactly like store.search's
  // score/max — so a caller merging the two arms is comparing "how good for this
  // arm", which is the only honest comparison between two ranking regimes.
  const max = Number(res.rows[0]?.rank) || 1;
  return res.rows.map((row) => ({
    memory: rowToMemory(row),
    via: "search" as const,
    score: Number(row.rank) / max,
  }));
}

// The PROJECTED arm: candidate generation is store.search over the shared graph,
// then every hit is resolved back to canonical memory. Only ever called with
// shared scopes — the graph contains nothing else.
async function recallProjected(
  db: Db,
  store: Store,
  args: RecallArgs,
  limit: number,
): Promise<RecalledMemory[]> {
  const hits = await store.search({ query: args.query, limit: limit * 4 });
  const bySlug = await memoriesForPages(
    db,
    hits.map((h) => h.slug),
    args,
  );
  const out: RecalledMemory[] = [];
  for (const hit of hits) {
    const memory = bySlug.get(hit.slug);
    if (memory) out.push({ memory, via: "search", score: hit.score ?? 0 });
  }
  return out;
}

// Current recall: only what is true now.
export async function recallMemory(
  db: Db,
  store: Store,
  args: RecallArgs,
): Promise<RecalledMemory[]> {
  if (args.scopes.length === 0) return [];
  const limit = clampLimit(args.limit);
  // Historical recall CANNOT go through the page projection for ANY scope:
  // retiring a memory removes its page, so a superseded row has nothing left to
  // search. One arm, canonical, for every scope.
  if (args.asOf) return recallCanonical(db, args, limit);

  // The split is made by the SAME predicate that decides what gets projected, so
  // a scope cannot be searched somewhere its memories were never written. It is
  // total over ScopeType: every scope lands in exactly one arm.
  const shared = args.scopes.filter((s) => isSharedScope({ scope_type: s.scopeType }));
  const canonical = args.scopes.filter((s) => !isSharedScope({ scope_type: s.scopeType }));

  const out: RecalledMemory[] = [];
  const seen = new Set<string>();
  const add = (r: RecalledMemory) => {
    if (seen.has(r.memory.id)) return;
    seen.add(r.memory.id);
    out.push(r);
  };
  if (shared.length) {
    for (const r of await recallProjected(db, store, { ...args, scopes: shared }, limit)) add(r);
  }
  if (canonical.length) {
    for (const r of await recallCanonical(db, { ...args, scopes: canonical }, limit)) add(r);
  }
  // Both arms normalize to their own best hit, so this orders by relative
  // strength within each arm. Stable, so an arm's own order breaks ties.
  out.sort((a, b) => b.score - a.score);

  // One hop along DECLARED edges from the matched projections. The auto lane is
  // deliberately not followed: an inferred edge should not pull memory into a
  // context window. Only shared memories are in the graph, so this arm is
  // vault-only by construction — a private memory has no edges, which is the
  // retrieval this design gives up in exchange for never writing it to the
  // shared graph.
  if (args.expandGraph && shared.length && out.length > 0) {
    // Seeded from SHARED results only. A private memory has no page after a
    // sweep, but it still has a stale projection_page_id in the window between
    // deploying this and the first maintenance pass, and a seed is a place a
    // private id would otherwise enter a graph query.
    const matched = out
      .filter((r) => isSharedScope(r.memory))
      .map((r) => r.memory.projection_page_id)
      .filter((id): id is number => !!id);
    if (matched.length) {
      const scope = scopeClause(shared, 2);
      const near = await db.query(
        `SELECT DISTINCT m.* FROM edges e
         JOIN memory_items m ON m.projection_page_id IN (e.from_page_id, e.to_page_id)
         WHERE e.lane = 'declared'
           AND (e.from_page_id = ANY($1::bigint[]) OR e.to_page_id = ANY($1::bigint[]))
           AND ${scope.sql} AND ${ACTIVE_SQL}
         LIMIT 50`,
        [matched, ...scope.params],
      );
      for (const row of near.rows) {
        // Graph neighbours rank below direct matches: they are context, not the
        // answer — so they are appended after the sort, never mixed into it.
        add({ memory: rowToMemory(row), via: "graph", score: 0 });
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
