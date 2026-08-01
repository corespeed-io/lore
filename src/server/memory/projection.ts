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
//
// WHERE THE REPAIR RUNS, and why there is no read-time filter left in this file.
// There used to be a predicate here (isScopedProjection) whose comment claimed
// mcp.ts's dispatcher applied it "while a database is still mid-migration". It
// had ZERO callers in src/ — its only caller was the test that asserted its
// return values — so the mid-migration window was guarded by nothing at all, and
// the only thing that closed it was POST /api/maintenance, which needs the write
// bearer and which nothing calls on its own. Every holder of the shared
// BRAIN_READ_TOKEN could read every thread's memories until an operator wired a
// cron. That predicate is deleted rather than wired: a read-time filter over
// content that IS there is the shape round 2 lost with, and the repair belongs
// where no reader can get in front of it. `migrateMemoryNamespace` below runs
// from initSchema (src/server/db.ts), which is on the ONE path to a Store, and it
// refuses to open the brain if the namespace is still readable. So the window is
// not "until the cron runs"; it is closed before the first request is served.

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

// Which memory an ADDRESS names. Every projection slug this codebase has ever
// written ends in the memory id — memory/vault/<id>, memory/scoped/<id> from
// 2befdf4, memory/thread/<scope>/<id> from 86abe92 — so the last segment is the
// whole hint, and it is spelled HERE and nowhere else in this file. Two spellings
// of "which memory does this slug name" is the shape of every bug this file has
// had; the guard read the raw slug while the store trimmed it, a JS-computed key
// disagreed with a SQL-computed one, and so on.
//
// A miss is not a pass: verdictFor reads "no memory named" as "retract".
function addressedMemoryId(slug: string): string {
  return slug.split("/").at(-1) ?? "";
}

// --- SQL mirrors of the two predicates above ---------------------------------
//
// Interpolated from the SAME constant, so they cannot be edited apart from
// projectionSlug. Almost everywhere they are candidate filters only: every row
// they select is re-judged in JS by projectionSlug/verdictFor before anything is
// written or deleted, so a drift there can only delay a repair.
//
// ONE exception, and it is worth naming rather than burying: migrateMemoryNamespace's
// exit check reads ADDRESS_SQL as an AUTHORITY — it decides whether the brain is
// allowed to open — because there is nothing left to re-judge at that point, the
// question being "is anything still readable". A drift that made the mirror answer
// a WIDER address than projectionSlug would let the brain open on a leak, so
// tests/memory-projection-scope.test.ts pins the two against each other over every
// scope AND status rather than trusting this paragraph.
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

// HOW a page came to be judged against a memory — evidence, never the shape of
// the page's name. The distinction is the fix for a real defect: the rule used to
// be `slug.endsWith('/' + owner.id)`, so a page positively identified as memory
// M's projection by M's OWN recorded projection_page_id was downgraded from
// "purge" to "retract" whenever its slug happened not to end in the id — which is
// exactly the projection-renamed-out-of-the-namespace case. Retract is soft, and a
// soft-deleted page whose slug is no longer under memory/ is revived by an
// ordinary restore_page call, because the store's reserved-namespace guard does
// not fire on it. So the weaker verdict handed the content back.
//
//   "link"    memory_items.projection_page_id points at this row: the memory
//             itself says this page is its projection. Shape-independent, which
//             is the whole reason that column is addressed instead of a slug.
//   "address" the address names the memory (addressedMemoryId).
//   "none"    nothing ties this page to any memory.
//
// Both handles are read by BOTH halves of the reconciliation (pagesOwnedBy for
// memory -> page, sweepMemoryNamespace for page -> memory), so the same page
// cannot be judged one way from one side and another way from the other.
type Attribution = "link" | "address" | "none";

interface PageRow {
  id: number;
  slug: string;
  live: boolean;
  attribution: Attribution;
}

// keep    the address is the canonical slug of a committed shared memory
// retract the page must not be READ (it may still be revived, or it may not be
//         ours to destroy)
// purge   the ROW must not exist at all
type Verdict = "keep" | "retract" | "purge";

// The single question every page is judged by, and the only consumer of
// projectionSlug's answer besides the writer below. `owner` is the memory the
// EVIDENCE names — the recorded link or the address — never who is asking.
function verdictFor(page: PageRow, owner: MemoryItem | null): Verdict {
  // Nothing claims this page. It must not be read (the namespace is reserved,
  // and no reader can tell it from a projection), but its bytes are not ours to
  // destroy: a database written before the namespace guard existed could have a
  // real user note here, and a personal brain does not trade data loss for
  // tidiness. That justification is about a page NOBODY claims, which is why it
  // is keyed on the evidence and not on the slug's shape.
  if (!owner || page.attribution === "none") return "retract";
  // The address is this memory's canonical one: keep it while the memory is
  // committed, retract when it is not — the same stable slug is how a re-commit
  // revives it.
  if (projectionSlug(owner) === page.slug) return owner.status === "committed" ? "keep" : "retract";
  // Attributable to a memory that may not own this address — every thread/agent
  // projection ever written, under every slug shape (memory/thread/<scope>/<id>
  // from 86abe92, memory/scoped/<id> from 2befdf4), a vault page sitting at a
  // stale address, and a projection renamed out of the namespace by a release
  // whose rename guard was missing.
  return "purge";
}

// Carry out one verdict. Retract is soft (the page stays revivable through the
// same stable slug when its memory re-commits); purge deletes the ROW, because
// this address may never hold a page and a soft delete would leave private
// content in pages.body, one forgotten `deleted_at IS NULL` away from every
// reader. chunks / edges / pending_links cascade, and
// memory_items.projection_page_id is ON DELETE SET NULL.
//
// Db-only, and that is load-bearing rather than tidiness: this is the function
// initSchema's boot repair runs, where there is no Store and no embeddings
// provider to build one with. Giving that caller its own soft delete would be a
// SECOND implementation of "retract" — the two-readers bug this round is about —
// so there is one, here, and it is the same two statements store.deletePage
// runs (the pages row survives so a restore can rebuild from it; the chunks go
// because the vector arm's inner query must stay a bare ORDER BY/LIMIT, so its
// candidates are filtered by deleted_at only AFTER the LIMIT and dead chunks
// would permanently steal ANN slots). By ID, not by slug: the row is in hand,
// and a projection may be sitting at any slug at all — including one outside
// memory/ that store.deletePage's own guards would treat as an ordinary page.
async function applyVerdict(db: Db, page: PageRow, verdict: Verdict): Promise<Verdict> {
  if (verdict === "purge") {
    await db.query("DELETE FROM pages WHERE id = $1", [page.id]);
  } else if (verdict === "retract" && page.live) {
    await db.tx(async (q) => {
      await q(
        "UPDATE pages SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
        [page.id],
      );
      await q("DELETE FROM chunks WHERE page_id = $1", [page.id]);
    });
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
  const linkedId = memory.projection_page_id === null ? -1 : Number(memory.projection_page_id);
  const res = await db.query(
    `SELECT id, slug, (deleted_at IS NULL) AS live FROM pages
     WHERE id = $1 OR (slug LIKE $2 AND right(slug, $3::int) = $4)`,
    // Page ids are bigserial, so -1 stands in for "no page recorded" with no
    // ambiguity and no second query.
    [linkedId, `${MEMORY_SLUG_PREFIX}%`, tail.length, tail],
  );
  return res.rows.map((r) => {
    const id = Number(r.id);
    const slug = String(r.slug);
    // The evidence is decided in JS, from values already in hand, so the SQL
    // above stays what this file's SQL is everywhere else: a candidate filter.
    // Were the WHERE clause taken as the evidence, `right(slug, n) = tail` would
    // become a second reader of addressedMemoryId — the exact shape that has bitten
    // this repo four times. It cannot authorise anything now: a drift can only fail
    // to OFFER a page, and sweepMemoryNamespace enumerates the namespace itself.
    const attribution: Attribution =
      id === linkedId ? "link" : addressedMemoryId(slug) === memory.id ? "address" : "none";
    return { id, slug, live: r.live === true, attribution };
  });
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
      await applyVerdict(db, page, verdictFor(page, memory));
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

// ONE candidate set, asked two ways.
//
// Two arms, because a projection is reachable by two handles and a repair that
// knows only one of them is not a repair:
//   1. the reserved namespace, driven by the PAGES table, so it sees every page
//      under memory/ however it got there — written by a release with a different
//      slug scheme, left behind by a projection that died before it recorded its
//      page id, resurrected by `UPDATE pages SET deleted_at = NULL` in psql. The
//      predicate is the exact negation of "healthy": some memory's canonical
//      ADDRESS is this slug, and the page's liveness already matches that memory's
//      committed-ness. The previous sweep could only see rows a memory pointed at,
//      so a committed memory with projection_status='ok' and a live page matched no
//      arm and the migration returned [].
//   2. pages a memory's OWN recorded link claims that are not at that memory's
//      canonical address. Not restricted to memory/, because that is precisely the
//      page the namespace arm cannot see: a projection renamed OUT of the reserved
//      prefix by a release whose rename guard was missing. Driven from
//      memory_items (small, and projection_page_id is indexed), not as an OR on
//      arm 1, so it costs a pk join rather than a probe per page in the vault.
//
// `liveOnly` restricts the set to pages that are READABLE right now, which is the
// leak itself — and it is exactly the invariant, not a second spelling of it:
// every live candidate is a page verdictFor takes off every read, and every
// readable page the rule forbids is a live candidate (a live page whose address no
// committed shared memory owns fails arm 1's NOT EXISTS by construction). So
// migrateMemoryNamespace's exit check below is this same predicate.
function candidateSql(order: string, liveOnly: boolean): string {
  const live = liveOnly ? "AND p.deleted_at IS NULL" : "";
  return `SELECT p.id AS id, p.slug AS slug, (p.deleted_at IS NULL) AS live
            FROM pages p
           WHERE p.id > $3 AND p.slug LIKE $1 ${live}
             AND NOT EXISTS (
               SELECT 1 FROM memory_items m
                WHERE ${ADDRESS_SQL} = p.slug
                  AND (p.deleted_at IS NULL) = (m.status = 'committed'))
           UNION
          SELECT p.id AS id, p.slug AS slug, (p.deleted_at IS NULL) AS live
            FROM memory_items m JOIN pages p ON p.id = m.projection_page_id
           WHERE p.id > $3 ${live}
             AND p.slug IS DISTINCT FROM ${ADDRESS_SQL}
           ORDER BY ${order}
           LIMIT $2`;
}

// Two schedules over that one set, and neither is a rule — getting the order wrong
// can only slow convergence, never authorise a page.
//   FAIR   live pages first: the bounded maintenance sweep may not get a second
//          batch this minute, and a retracted page can no longer leak, so it must
//          never crowd a live one out.
//   CURSOR by id: what makes migrateMemoryNamespace judge every page exactly once
//          and terminate.
const FAIR_ORDER = "live DESC, id";
const CURSOR_ORDER = "id";

// The page -> memory half of the biconditional. Bounded: one batch.
async function sweepMemoryNamespace(
  db: Db,
  limit: number,
  // -1 means "no cursor", i.e. the fair schedule. >= 0 resumes past that page id.
  after = -1,
): Promise<NamespaceSweep & { seen: number; lastId: number }> {
  const candidates = await db.query(
    // ponytail: prefix LIKE over slug; a seq scan is fine at this size, and the
    // NOT EXISTS keeps the healthy majority out of the result either way.
    candidateSql(after < 0 ? FAIR_ORDER : CURSOR_ORDER, false),
    [`${MEMORY_SLUG_PREFIX}%`, limit, after],
  );
  const out = { retracted: 0, purged: 0, failed: 0, seen: candidates.rows.length, lastId: after };
  if (!candidates.rows.length) return out;

  // BOTH handles, the same two pagesOwnedBy reads, so the two halves cannot
  // disagree about the same page:
  //   - the recorded link: positive identification, shape-independent
  //   - the address: names the memory under every slug shape ever written
  // A miss is not a pass — verdictFor reads a missing owner as "retract".
  const pageIds = candidates.rows.map((r) => Number(r.id));
  const addressed = candidates.rows.map((r) => addressedMemoryId(String(r.slug)));
  const owners = await db.query(
    `SELECT * FROM memory_items
      WHERE id = ANY($1::text[]) OR projection_page_id = ANY($2::bigint[])`,
    [addressed, pageIds],
  );
  const byId = new Map<string, MemoryItem>();
  const byPage = new Map<number, MemoryItem>();
  for (const r of owners.rows) {
    const memory = rowToMemory(r);
    byId.set(memory.id, memory);
    if (memory.projection_page_id !== null) byPage.set(Number(memory.projection_page_id), memory);
  }

  for (const row of candidates.rows) {
    const id = Number(row.id);
    const slug = String(row.slug);
    // The link wins when both handles answer: a memory saying "this page is mine"
    // outranks a name that merely ends in an id.
    const linked = byPage.get(id) ?? null;
    const owner = linked ?? byId.get(addressedMemoryId(slug)) ?? null;
    const page: PageRow = {
      id,
      slug,
      live: row.live === true,
      attribution: linked ? "link" : owner ? "address" : "none",
    };
    out.lastId = Math.max(out.lastId, id);
    try {
      // One bad page must not stop the sweep, or a single wedged row keeps every
      // other leak alive.
      const verdict = await applyVerdict(db, page, verdictFor(page, owner));
      if (verdict === "purge") out.purged++;
      else if (verdict === "retract" && page.live) out.retracted++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

// Round trips are the cost here, not rows, so take a big bite.
const MIGRATION_BATCH = 200;

// THE REPAIR, run from initSchema (src/server/db.ts) — the one place every reader
// is already behind, because there is no way to obtain a Store without crossing
// it.
//
// Why not left to the maintenance sweep: POST /api/maintenance needs the write
// bearer and its own header says nothing calls it on its own. A namespace left
// dirty by an older release therefore stayed READABLE by every holder of the
// shared BRAIN_READ_TOKEN until an operator wired a cron, which is not a
// boundary, it is a hope.
//
// Why not a `from < N` step in db.ts's version-keyed migration list: a version
// integer is a second path to the same bad state, and "the chokepoint is not the
// only path" is how the last three rounds were refuted. A dump restored into a
// database whose meta row already reads the new version, a hand-set
// schema_version, a page written by psql the day after the step ran — each skips a
// keyed step FOREVER. This is a convergence sweep, not a schema change: it is
// idempotent, and on a clean brain it costs exactly TWO queries that return no
// rows — the first batch (which exits early) and the leak check — so keying it on a
// MEASURED, because "it is cheap" is the kind of claim that should carry a number,
// and because per-cold-start cost is the one real objection to doing this at boot
// (on Workers cold starts are frequent). Against PGlite, 5,000 ordinary pages:
//   clean brain                     18ms   — every cold start, the common case
//   first boot, 5,000 legacy strays  7.3s  — ONCE, and it is an upgrade
//   every cold start after that     ~285ms — re-judging strays it has retracted
// The candidate scan is index-assisted (Index Scan using pages_pkey), not a seq
// scan. The steady-state 285ms is the honest cost of the paragraph below: a
// retracted page nothing claims stays a candidate forever, because there is
// nothing left to do to it and destroying it is the one thing this design refuses.
// It is proportional to how many private projections the brain ONCE had, not to
// its size, and a brain that never ran an older release pays the 18ms.
// version buys nothing but a way to miss it. That is two anti-joins over the
// memory/ prefix per process boot on a single-tenant personal brain. The leak check
// is deliberately NOT skipped when the first batch came back empty, even though it
// is provably vacuous then: a branch that turns a security check off is worth more
// than one query.
//
// BOUNDED WORK. A migration must finish. This pages by id and resumes past the
// highest id it judged, so every candidate is judged exactly once and the loop
// ends after at most ceil(candidates / MIGRATION_BATCH) round trips. It is
// deliberately NOT "loop until the candidate set is empty": a retracted page that
// nothing claims stays a candidate forever (there is nothing left to do to it, and
// destroying it is the one thing this design refuses), so that loop would never
// end. It is also not "loop until a pass changes nothing", which stops early and
// silently whenever a batch fills up with those inert rows.
//
// REMOVAL ONLY. It never writes a page: re-projecting needs an embeddings
// provider, and opening a brain must not depend on a network call. A committed
// shared memory whose page is missing is a search gap that the next maintenance
// pass closes — not a leak — so it is the half that can wait.
export async function migrateMemoryNamespace(db: Db): Promise<NamespaceSweep> {
  const total: NamespaceSweep = { retracted: 0, purged: 0, failed: 0 };
  for (let after = 0; ; ) {
    const batch = await sweepMemoryNamespace(db, MIGRATION_BATCH, after);
    total.retracted += batch.retracted;
    total.purged += batch.purged;
    total.failed += batch.failed;
    if (batch.seen === 0) break;
    // Strictly increasing: every candidate had p.id > after, so this terminates
    // even if every verdict in the batch failed to apply.
    after = batch.lastId;
  }

  // Ask the invariant directly. A leak that survives the sweep means a wedged row
  // — a delete that keeps failing, a lock, a trigger — and the only safe answer is
  // to refuse to open the brain: initSchema is on the one path to a Store, so
  // throwing here fails every read closed instead of serving one thread's memories
  // to another. `failed` alone is not the test, because a failure on an already
  // retracted row is not a leak.
  const leak = await db.query(candidateSql(CURSOR_ORDER, true), [`${MEMORY_SLUG_PREFIX}%`, 1, -1]);
  if (leak.rows.length) {
    throw new Error(
      `memory namespace not repaired: page '${String(leak.rows[0].slug)}' is readable and no committed ${SHARED_SCOPE} memory owns that address (${total.failed} page(s) failed this pass)`,
    );
  }
  return total;
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
  const { retracted, purged, failed } = await sweepMemoryNamespace(db, n);
  const namespace: NamespaceSweep = { retracted, purged, failed };

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
