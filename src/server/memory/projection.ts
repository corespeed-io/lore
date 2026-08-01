// Layer 4: the page projection.
//
// A committed memory is projected into the existing pages/edges/FTS system so it
// is browseable and searchable with everything else. The page is a DERIVED,
// REBUILDABLE artifact — the canonical record stays in memory_items, and a
// failed or deleted projection loses nothing. That is why projection_status is a
// field on the memory rather than an exception: canonical commit succeeds even
// when projection does not.
//
// Reserved slug namespace, so an imported user note can never collide with (or be
// overwritten by) a generated memory page:
//   memory/thread/<thread-id>/<memory-id>
//   memory/agent/<agent-id>/<memory-id>
//   memory/vault/<memory-id>

import type { Db } from "../db";
import type { Store } from "../store";
import type { MemoryItem } from "./items";
import { rowToMemory } from "./items";

export const MEMORY_SLUG_PREFIX = "memory/";

// A user page can never live under this prefix: the import path and put_page both
// go through here to check.
export function isMemorySlug(slug: string): boolean {
  return slug.startsWith(MEMORY_SLUG_PREFIX);
}

// Stable: the same memory always projects to the same slug, which is what makes
// a retry an update instead of a duplicate.
export function projectionSlug(memory: MemoryItem): string {
  const id = memory.id;
  if (memory.scope_type === "vault") return `${MEMORY_SLUG_PREFIX}vault/${id}`;
  const scope = (memory.scope_id ?? "unknown").replace(/[^\w-]/g, "-").toLowerCase();
  return `${MEMORY_SLUG_PREFIX}${memory.scope_type}/${scope}/${id}`;
}

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
    `- scope: ${memory.scope_type}${memory.scope_id ? ` (${memory.scope_id})` : ""}`,
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

// The page this memory OWNS, addressed by the id the memory row already stores.
// The slug is only where the page started: a page moved off it (a rename from
// before the namespace guard, or an older database) is invisible to a slug lookup,
// so retraction would silently skip it and a forgotten memory would keep
// answering search forever.
async function ownedPage(
  db: Db,
  memory: MemoryItem,
): Promise<{ slug: string; deleted: boolean } | null> {
  // Page ids are bigserial, so falsy means "no page recorded" with no ambiguity.
  if (!memory.projection_page_id) return null;
  const res = await db.query("SELECT slug, deleted_at FROM pages WHERE id = $1", [
    memory.projection_page_id,
  ]);
  const row = res.rows[0];
  return row ? { slug: String(row.slug), deleted: row.deleted_at !== null } : null;
}

// Project one memory. Committed memories get an active page; everything the
// lifecycle has retired is removed from active search immediately (the canonical
// row keeps the history, so nothing is lost by deleting the projection).
export async function projectMemory(
  db: Db,
  store: Store,
  memory: MemoryItem,
): Promise<ProjectResult> {
  const slug = projectionSlug(memory);
  const active = memory.status === "committed";

  try {
    const owned = await ownedPage(db, memory);

    if (!active) {
      // Superseded / revoked / expired / candidate: must not appear in active
      // search. Soft delete keeps the row (and its chunks are dropped), and a
      // later re-commit revives it through the same stable slug.
      // By id first: that is the page this memory owns wherever it now lives.
      if (owned && !owned.deleted) await store.deletePage({ slug: owned.slug });
      // Then by slug, for a memory whose page id was never recorded — a projection
      // that died between the put and the UPDATE below still left a live page.
      const existing = await db.query(
        "SELECT id FROM pages WHERE slug = $1 AND deleted_at IS NULL",
        [slug],
      );
      if (existing.rows.length) await store.deletePage({ slug });
      await db.query(
        "UPDATE memory_items SET projection_status = 'removed', projection_error = NULL, updated_at = now() WHERE id = $1",
        [memory.id],
      );
      return { memoryId: memory.id, slug, status: "removed" };
    }

    const { body, refs } = renderProjection(memory);
    // A page that drifted off the canonical slug is retracted, not left live: two
    // live pages for one memory is exactly how a stale copy survives the next
    // forget, and the page is derived, so nothing is lost by dropping it.
    if (owned && !owned.deleted && owned.slug !== slug) {
      await store.deletePage({ slug: owned.slug });
    }
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
        scope_id: memory.scope_id,
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

// Drain whatever needs projecting: newly committed memories, and anything the
// lifecycle retired since its page was written. Bounded and idempotent, so it is
// safe to call from the maintenance sweep as often as a scheduler likes.
export async function runProjections(
  db: Db,
  store: Store,
  limit = 50,
): Promise<{ projected: number; failed: number; results: ProjectResult[] }> {
  const n = Math.min(Math.max(limit, 1), 200);
  const due = await db.query(
    `SELECT m.* FROM memory_items m
     WHERE m.projection_status IN ('pending', 'failed')
        OR (m.status = 'committed' AND m.projection_status = 'removed')
        OR (m.status <> 'committed' AND m.projection_status = 'ok')
        -- A committed memory whose page was deleted out from under it (delete_page
        -- on a projection, or a page hard-deleted by hand). The page is a
        -- rebuildable retrieval projection and Postgres is canonical, so the delete
        -- is allowed to stand for one sweep and then repaired — without this arm it
        -- matched no arm at all, and the memory stayed silently unsearchable.
        OR (m.status = 'committed' AND m.projection_status = 'ok'
            AND NOT EXISTS (SELECT 1 FROM pages p
                            WHERE p.id = m.projection_page_id AND p.deleted_at IS NULL))
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
    results,
  };
}
