// Layer 4: the page projection.
//
// ONE rule. Everything in this file is its enforcement:
//
//   A page under memory/ exists IF AND ONLY IF a committed, VAULT-scoped memory
//   owns that exact address.
//
// Why the biconditional and not a filter. Two rounds tried the other shape: put
// every memory's content in the shared page graph and hide the private ones on
// the way out. pages/edges/FTS carry no principal — /api/mcp authenticates one
// shared BRAIN_READ_TOKEN for every agent and every thread — so hiding meant a
// predicate applied at read time, and a read-time predicate over content that IS
// there loses to the first path nobody listed: a fuzzy-title substring oracle,
// score arithmetic, page_count arithmetic, an unmigrated database, a tool that
// carries no slug. `vault` is the only scope that MEANS "every reader", so it is
// the only scope whose content is written to the shared graph at all. Thread- and
// agent-scoped memories are never projected; there is nothing to hide, so there
// is no filter to have a bug in. They are retrieved from canonical memory instead
// (recall.ts's canonical arm), which is where their scope is checked anyway.
//
// The rule is enforced at ONE decision, `projectionSlug()`, and reconciled from
// BOTH ends:
//   - memory -> page: runProjections' due query selects every memory whose page
//     state disagrees with what projectionSlug says it may own.
//   - page -> memory: sweepMemoryNamespace walks the pages table itself, so a
//     page written under ANY slug shape this codebase ever used, by a release
//     that predates this rule or by a hand-repair in psql, is still judged. A
//     sweep that can only see rows some bookkeeping column points at cannot
//     migrate a database; this one enumerates the pages, so nothing about a
//     memory row can hide a page from it.
//
// store.ts asks projectionSlug the same question before it will write anything
// under memory/ (projectionOwner), so narrowing this function narrowed the write
// door in the same edit: no memory outside vault scope owns any address, so no
// put_page, /api/import or restore_page can create one.

import type { Db } from "../db";
import type { Store } from "../store";
import type { MemoryItem, ScopeType } from "./items";
import { rowToMemory } from "./items";

export const MEMORY_SLUG_PREFIX = "memory/";

// The one scope a principal-less page can honour. Every "shared" answer in this
// file — the JS predicates AND the SQL mirrors below — is derived from this
// constant, so they cannot drift onto different answers.
const SHARED_SCOPE: ScopeType = "vault";
export const SHARED_SLUG_PREFIX = `${MEMORY_SLUG_PREFIX}${SHARED_SCOPE}/`;

// A user page can never live under this prefix: the import path and put_page both
// go through here to check.
export function isMemorySlug(slug: string): boolean {
  return slug.startsWith(MEMORY_SLUG_PREFIX);
}

// `vault` is the only scope a principal-less page can honour, so it is the only
// one whose content belongs in the shared graph. One place decides it.
export function isSharedScope(memory: Pick<MemoryItem, "scope_type">): boolean {
  return memory.scope_type === SHARED_SCOPE;
}

// THE CHOKEPOINT. Which page this memory owns — and `null` means it owns none,
// ever. Every write path (projectMemory here, putPage/restorePage in store.ts via
// projectionOwner) and every removal path (verdictFor below) asks this one
// function, so "may this content be in the shared graph?" has exactly one answer
// in exactly one place.
//
// Stable for the scope that does get a page: the same memory always projects to
// the same slug, which is what makes a retry an update instead of a duplicate.
export function projectionSlug(memory: Pick<MemoryItem, "id" | "scope_type">): string | null {
  return isSharedScope(memory) ? `${SHARED_SLUG_PREFIX}${memory.id}` : null;
}

// Belt-and-braces for the shared read surface (mcp.ts's dispatcher) while a
// database is still mid-migration. Deliberately broader than the one namespace it
// replaced: ANY memory/ address that is not a vault projection is content the
// shared surface must not hand back, whatever slug shape wrote it.
export function isScopedProjection(slug: string): boolean {
  return isMemorySlug(slug) && !slug.startsWith(SHARED_SLUG_PREFIX);
}

// --- SQL mirrors of the two predicates above ---------------------------------
//
// Interpolated from the SAME constant, and used ONLY as candidate filters: every
// row they select is re-judged in JS by projectionSlug/verdictFor before anything
// is written or deleted. So the worst a drift here can do is delay a repair — it
// can never authorise a page.
const ADDRESS_SQL = `(CASE WHEN m.scope_type = '${SHARED_SCOPE}' THEN '${SHARED_SLUG_PREFIX}' || m.id END)`;
const WANTS_PAGE_SQL = `(m.status = 'committed' AND ${ADDRESS_SQL} IS NOT NULL)`;

function titleFor(memory: MemoryItem): string {
  const key = memory.memory_key ? `${memory.memory_key}: ` : "";
  const oneLine = memory.content.split("\n")[0].trim();
  const text = `${key}${oneLine}`;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

// The rendered body. Declared references come from structured fields, so the
// memory's own links land in the DECLARED edge lane — mention-derived links stay
// in the auto lane, and the two never merge.
export function renderProjection(memory: MemoryItem): { body: string; refs: string[] } {
  const refs: string[] = [];
  const declared = memory.structured_value?.references;
  if (Array.isArray(declared)) {
    for (const r of declared) if (typeof r === "string" && r.trim()) refs.push(r.trim());
  }
  const lines = [`# ${titleFor(memory)}`, ""];
  lines.push(memory.content, "");
  const meta: string[] = [
    `- type: ${memory.memory_type}`,
    // Always `vault` now — only a shared memory is ever rendered. Kept as a line
    // rather than dropped so an exported page still says what it is.
    `- scope: ${memory.scope_type}`,
    `- status: ${memory.status}`,
    `- effective: ${memory.valid_from}${memory.valid_to ? ` — ${memory.valid_to}` : ""}`,
    `- memory id: ${memory.id}`,
  ];
  if (memory.memory_key) meta.push(`- key: ${memory.memory_key}`);
  if (memory.confidence < 0.8) meta.push(`- confidence: ${memory.confidence.toFixed(2)}`);
  lines.push("## Record", ...meta);
  if (refs.length) {
    lines.push("", "## References", ...refs.map((r) => `- [[${r}]]`));
  }
  return { body: lines.join("\n"), refs };
}

export interface ProjectResult {
  memoryId: string;
  slug: string | null;
  status: "ok" | "failed" | "removed" | "skipped";
  error?: string;
}

interface PageRow {
  id: number;
  slug: string;
  live: boolean;
}

// keep    the address is the canonical slug of a committed shared memory
// retract the page must not be READ (it may still be revived, or it may not be
//         ours to destroy)
// purge   the ROW must not exist at all
type Verdict = "keep" | "retract" | "purge";

// The single question every page is judged by, and the only consumer of
// projectionSlug's answer besides the writer below. `owner` is the memory the
// ADDRESS names — resolved from the address, never from who is asking.
function verdictFor(slug: string, owner: MemoryItem | null): Verdict {
  // Nothing claims this address. It must not be read (the namespace is reserved,
  // and no reader can tell it from a projection), but its bytes are not ours to
  // destroy: a database written before the namespace guard existed could have a
  // real user note here, and a personal brain does not trade data loss for
  // tidiness. Same answer for a projection renamed OUT of the namespace, which is
  // how this branch is reached with a slug that is not under memory/.
  if (!owner || !slug.endsWith(`/${owner.id}`)) return "retract";
  // Attributable to a memory that may not own this address — every thread/agent
  // projection ever written, under every slug shape (memory/thread/<scope>/<id>
  // from 86abe92, memory/scoped/<id> from 2befdf4), plus a vault page sitting at
  // a stale address.
  if (projectionSlug(owner) !== slug) return "purge";
  return owner.status === "committed" ? "keep" : "retract";
}

// Carry out one verdict. Retract is soft (the page stays revivable through the
// same stable slug when its memory re-commits); purge deletes the ROW, because
// this address may never hold a page and a soft delete would leave private
// content in pages.body, one forgotten `deleted_at IS NULL` away from every
// reader. chunks / edges / pending_links cascade, and
// memory_items.projection_page_id is ON DELETE SET NULL.
async function applyVerdict(
  db: Db,
  store: Store,
  page: PageRow,
  verdict: Verdict,
): Promise<Verdict> {
  if (verdict === "purge") {
    await db.query("DELETE FROM pages WHERE id = $1", [page.id]);
  } else if (verdict === "retract" && page.live) {
    await store.deletePage({ slug: page.slug });
  }
  return verdict;
}

// Every page this memory could own, by BOTH handles — and neither is a slug
// SHAPE this release happens to know:
//   - projection_page_id: the link the projection recorded, shape-independent.
//   - the last slug segment: every projection slug this codebase has ever written
//     ends in the memory id. Over-broad on purpose — a page found here is only
//     ever judged by verdictFor, so a false positive costs a rebuildable
//     artifact, while a false negative is content that outlives its memory.
async function pagesOwnedBy(db: Db, memory: MemoryItem): Promise<PageRow[]> {
  const tail = `/${memory.id}`;
  const res = await db.query(
    `SELECT id, slug, (deleted_at IS NULL) AS live FROM pages
     WHERE id = $1 OR (slug LIKE $2 AND right(slug, $3::int) = $4)`,
    // Page ids are bigserial, so -1 stands in for "no page recorded" with no
    // ambiguity and no second query.
    [memory.projection_page_id ?? -1, `${MEMORY_SLUG_PREFIX}%`, tail.length, tail],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    slug: String(r.slug),
    live: r.live === true,
  }));
}

// Project one memory. A committed VAULT memory gets an active page; everything
// else — retired, or simply not shared — loses whatever page it has.
export async function projectMemory(
  db: Db,
  store: Store,
  memory: MemoryItem,
): Promise<ProjectResult> {
  const slug = projectionSlug(memory);
  const active = slug !== null && memory.status === "committed";

  try {
    // Reconcile every page this memory touches BEFORE writing: two live pages for
    // one memory is exactly how a stale copy survives the next forget.
    for (const page of await pagesOwnedBy(db, memory)) {
      await applyVerdict(db, store, page, verdictFor(page.slug, memory));
    }

    if (!active) {
      await db.query(
        "UPDATE memory_items SET projection_status = 'removed', projection_error = NULL, updated_at = now() WHERE id = $1",
        [memory.id],
      );
      return { memoryId: memory.id, slug, status: "removed" };
    }
    // `active` already proves it; TypeScript needs it said.
    if (slug === null) throw new Error("unreachable: active projection with no address");

    const { body, refs } = renderProjection(memory);
    // Revive a soft-deleted projection rather than leaving it hidden: the same
    // slug is reused deliberately, which is what makes a retry idempotent.
    const dead = await db.query("SELECT id FROM pages WHERE slug = $1 AND deleted_at IS NOT NULL", [
      slug,
    ]);
    if (dead.rows.length) await store.restorePage({ slug });

    const put = await store.putPage({
      slug,
      title: titleFor(memory),
      body,
      kind: "memory",
      frontmatter: {
        type: memory.memory_type,
        memory_id: memory.id,
        memory_key: memory.memory_key,
        scope_type: memory.scope_type,
        // scope_id is NOT written: get_page and /api/export return frontmatter
        // verbatim. It is always the vault here — one instance, nothing to
        // attribute — but writing it would put the field back on the surface.
        effective_from: memory.valid_from,
        // Declared refs are also surfaced as related_ids so they resolve through
        // the existing declared-edge path.
        related_ids: refs,
      },
    });
    const pageRow = await db.query("SELECT id FROM pages WHERE slug = $1", [put.slug]);
    await db.query(
      `UPDATE memory_items
       SET projection_page_id = $2, projection_status = 'ok', projection_error = NULL, updated_at = now()
       WHERE id = $1`,
      [memory.id, Number(pageRow.rows[0].id)],
    );
    return { memoryId: memory.id, slug, status: "ok" };
  } catch (e) {
    // Canonical memory stays valid and committed; only the projection failed.
    const error = e instanceof Error ? e.message : "projection failed";
    await db.query(
      "UPDATE memory_items SET projection_status = 'failed', projection_error = $2, updated_at = now() WHERE id = $1",
      [memory.id, error],
    );
    return { memoryId: memory.id, slug, status: "failed", error };
  }
}

export interface NamespaceSweep {
  retracted: number;
  purged: number;
  failed: number;
}

// The page -> memory half of the biconditional, and the migration.
//
// Driven by the PAGES table, so it sees every page in the reserved namespace
// however it got there: written by a release with a different slug scheme, left
// behind by a projection that died before it recorded its page id, resurrected by
// `UPDATE pages SET deleted_at = NULL` in psql. That is the whole point — the
// previous sweep could only see rows a memory row pointed at, so a committed
// memory with projection_status='ok' and a live page matched no arm and the
// migration returned [].
//
// The candidate filter is the exact negation of "healthy": some memory's canonical
// ADDRESS is this slug, and the page's liveness already matches that memory's
// committed-ness. Everything else is looked at. Live pages first, because a
// retracted page can no longer leak and must never crowd a live one out of the
// batch.
async function sweepMemoryNamespace(db: Db, store: Store, limit: number): Promise<NamespaceSweep> {
  const candidates = await db.query(
    `SELECT p.id, p.slug, (p.deleted_at IS NULL) AS live
     FROM pages p
     WHERE p.slug LIKE $1
       AND NOT EXISTS (
         SELECT 1 FROM memory_items m
         WHERE ${ADDRESS_SQL} = p.slug
           AND (p.deleted_at IS NULL) = (m.status = 'committed')
       )
     ORDER BY (p.deleted_at IS NULL) DESC, p.id
     LIMIT $2`,
    // ponytail: prefix LIKE over slug; a seq scan is fine at this size, and the
    // NOT EXISTS keeps the healthy majority out of the result either way.
    [`${MEMORY_SLUG_PREFIX}%`, limit],
  );
  const out: NamespaceSweep = { retracted: 0, purged: 0, failed: 0 };
  if (!candidates.rows.length) return out;

  // The address names its owner: the last segment is the memory id under every
  // slug shape this codebase has written. A miss is not a pass — verdictFor reads
  // a missing owner as "retract".
  const ids = candidates.rows.map((r) => String(r.slug).split("/").at(-1) ?? "");
  const owners = await db.query("SELECT * FROM memory_items WHERE id = ANY($1::text[])", [ids]);
  const byId = new Map(owners.rows.map((r) => [String(r.id), rowToMemory(r)]));

  for (const row of candidates.rows) {
    const page: PageRow = { id: Number(row.id), slug: String(row.slug), live: row.live === true };
    const owner = byId.get(page.slug.split("/").at(-1) ?? "") ?? null;
    try {
      // One bad page must not stop the sweep, or a single wedged row keeps every
      // other leak alive.
      const verdict = await applyVerdict(db, store, page, verdictFor(page.slug, owner));
      if (verdict === "purge") out.purged++;
      else if (verdict === "retract" && page.live) out.retracted++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

// Drain whatever needs projecting: newly committed memories, anything the
// lifecycle retired since its page was written, and anything sitting in the
// reserved namespace that no longer belongs there. Bounded and idempotent, so it
// is safe to call from the maintenance sweep as often as a scheduler likes.
export async function runProjections(
  db: Db,
  store: Store,
  limit = 50,
): Promise<{
  projected: number;
  failed: number;
  namespace: NamespaceSweep;
  results: ProjectResult[];
}> {
  const n = Math.min(Math.max(limit, 1), 200);
  // Pages first: purging a page clears memory_items.projection_page_id, so the
  // due query below picks the same memory up and its bookkeeping converges in
  // this same pass.
  const namespace = await sweepMemoryNamespace(db, store, n);

  // Due = the projection does not agree with what this memory may own, judged by
  // BOTH halves of the bookkeeping and by the PAGE itself, at the ADDRESS rather
  // than through the recorded link — the link is the thing that goes missing.
  // Written as one XOR per half against WANTS_PAGE_SQL rather than as a list of
  // (status, projection_status) pairs, so the arms mirror the invariant instead of
  // enumerating states and missing one. The arms, in order:
  //   1. never projected, or the last attempt failed
  //   2. the bookkeeping column disagrees with what it may own — the arm the
  //      migration rides in on: a committed THREAD memory with
  //      projection_status='ok' now disagrees, where before it looked healthy and
  //      the sweep returned []
  //   3. the page at its address disagrees (retracted-then-resurrected, or a
  //      committed memory whose page was evicted by delete_page)
  //   4. a live page it recorded that is NOT at its address (a projection renamed
  //      out of the namespace by a release whose rename guard was missing)
  const due = await db.query(
    `SELECT m.* FROM memory_items m
     WHERE m.projection_status IN ('pending', 'failed')
        OR ${WANTS_PAGE_SQL} <> (m.projection_status = 'ok')
        OR ${WANTS_PAGE_SQL} <> EXISTS (
             SELECT 1 FROM pages p WHERE p.slug = ${ADDRESS_SQL} AND p.deleted_at IS NULL)
        OR EXISTS (
             SELECT 1 FROM pages p
             WHERE p.id = m.projection_page_id AND p.deleted_at IS NULL
               AND p.slug IS DISTINCT FROM ${ADDRESS_SQL})
     ORDER BY m.updated_at LIMIT $1`,
    [n],
  );
  const results: ProjectResult[] = [];
  for (const row of due.rows) {
    results.push(await projectMemory(db, store, rowToMemory(row)));
  }
  return {
    projected: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "failed").length,
    namespace,
    results,
  };
}
