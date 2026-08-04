// The second background job: semantic neighbours into the `auto` edge lane.
//
// The mention sweep beside this one links pages that NAME each other. This one
// links pages that are ABOUT the same thing without ever saying so — which is
// the only kind of edge a knowledge graph can offer that the source system
// cannot. A GitHub import's declared edges are GitHub's own cross-references
// (`#123` in a body): real, but you already had them, one click away, rendered
// better. Measured on this brain: lore#51 (a scope refactor) has no reference
// to hermes-cluster#88 or corespeed-haas#215, and all three are the same work
// by three teams.
//
// Deterministic and zero-LLM, like the mention sweep: the vectors were computed
// at write time and this only reads them.
//
// Four choices carry the safety, and none is a tuned weight:
//
//   MUTUAL k-NN. A is linked to B only when each is in the other's top-k. A hub
//   page — a long design doc that is vaguely near everything — otherwise
//   collects an edge from every page in the brain and becomes the centre of a
//   star that means nothing. Mutuality costs one extra lookup and removes the
//   whole failure mode.
//
//   A FLOOR, and it is high. Cosine similarity between two chunks of the same
//   corpus is rarely below 0.5 even for unrelated text, so a low floor links
//   everything to everything. 0.6 is where, on this corpus, the neighbours stop
//   being "same project" and start being "same subject".
//
//   A CAP PER PAGE. Without it a dense cluster is O(n²) edges and the graph is
//   a hairball again — the exact thing the containment edges were removed for.
//
//   ONE LANE. Everything written here is lane='auto', so
//   `DELETE FROM edges WHERE lane='auto'` undoes every inference this ever made,
//   and the ranking boost in store.ts counts only the 'declared' lane — an
//   inferred edge must never be able to promote a page.
import type { Db, Query } from "./db";

export interface SemanticSweepArgs {
  /** Pages to consider per call. The sweep is resumable, not all-or-nothing. */
  limit?: number;
  /** Cosine similarity below which two pages are not neighbours. */
  floor?: number;
  /** Most neighbours to keep for one page. */
  perPage?: number;
  /** Report what it would link, write nothing. */
  dryRun?: boolean;
}

export interface SemanticSweepResult {
  scanned: number;
  edgesAdded: number;
  pairs: { from: string; to: string; score: number }[];
}

const FLOOR = 0.6;
const PER_PAGE = 6;
const LIMIT = 200;

// One page's nearest neighbours, page-grained: a page is as near as its NEAREST
// chunk, which is what a reader means by "these two are related" — a single
// matching section is enough, and averaging would bury it.
const NEIGHBOURS = `
  WITH mine AS (
    SELECT embedding FROM chunks WHERE page_id = $1
  )
  SELECT c.page_id AS id, MAX(1 - (c.embedding <=> mine.embedding)) AS score
  FROM mine, chunks c
  JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL
  WHERE c.page_id <> $1
  GROUP BY c.page_id
  HAVING MAX(1 - (c.embedding <=> mine.embedding)) >= $2
  ORDER BY score DESC
  LIMIT $3`;

async function neighboursOf(
  q: Query,
  pageId: number,
  floor: number,
  k: number,
): Promise<{ id: number; score: number }[]> {
  const res = await q(NEIGHBOURS, [pageId, floor, k]);
  return res.rows.map((r) => ({ id: Number(r.id), score: Number(r.score) }));
}

export async function runSemanticSweep(
  db: Db,
  args: SemanticSweepArgs = {},
): Promise<SemanticSweepResult> {
  // Clamped like limit and perPage: floor 0 links near-everything to
  // everything, and nothing upstream validates it (write-token only, so a
  // footgun rather than a hole — but a cheap one to close).
  const floor = Math.min(Math.max(args.floor ?? FLOOR, 0.3), 0.99);
  const k = Math.min(Math.max(args.perPage ?? PER_PAGE, 1), 20);
  const limit = Math.min(Math.max(args.limit ?? LIMIT, 1), 1000);

  // Pages the sweep has not considered yet, same shape as the mention sweep's
  // mentions_scanned_at. The marker is a COLUMN on pages, deliberately not a
  // row in `edges`: the first version marked progress with a self-edge
  // (from=to) in the shared edge table, and every edge reader believed it —
  // find_orphans answered [] forever after one sweep, get_backlinks listed
  // each page as its own backlink, traverse_graph returned self-loops.
  // Progress state never belongs in the data it measures.
  const todo = await db.query(
    `SELECT p.id, p.slug FROM pages p
     WHERE p.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM chunks c WHERE c.page_id = p.id)
       AND p.semantic_swept_at IS NULL
     ORDER BY p.id
     LIMIT $1`,
    [limit],
  );

  const pairs: SemanticSweepResult["pairs"] = [];
  let edgesAdded = 0;

  // Memoised per sweep: the mutual check re-asks for a candidate's neighbours
  // once per page that names it, and in a dense cluster that is the same
  // GROUP BY/MAX(<=>) scan (which defeats HNSW) hundreds of times over —
  // ~1,400 sequential scans per default-sized call. Within one sweep the
  // vectors cannot change, so the answer cannot either.
  const memo = new Map<number, Promise<{ id: number; score: number }[]>>();
  const neighbours = (pageId: number) => {
    let hit = memo.get(pageId);
    if (!hit) {
      hit = neighboursOf(db.query, pageId, floor, k);
      memo.set(pageId, hit);
    }
    return hit;
  };

  for (const row of todo.rows) {
    const id = Number(row.id);
    const slug = String(row.slug);
    const near = await neighbours(id);

    for (const n of near) {
      // MUTUAL: B must also have A among ITS neighbours. Without this a page
      // that is vaguely near everything collects an edge from everything.
      const back = await neighbours(n.id);
      if (!back.some((b) => b.id === id)) continue;

      const to = await db.query("SELECT slug FROM pages WHERE id = $1", [n.id]);
      pairs.push({ from: slug, to: String(to.rows[0]?.slug ?? n.id), score: n.score });
      if (args.dryRun) continue;

      // Undirected in meaning, so write the pair once in a stable order and let
      // the graph read it both ways — the same shape declared edges use.
      const [a, b] = id < n.id ? [id, n.id] : [n.id, id];
      // RETURNING, or the count is always zero: ON CONFLICT DO NOTHING yields no
      // rows either way, so `rows.length` cannot tell "inserted" from "already
      // there" without it. The sweep reported 0 edges added while adding 418.
      const ins = await db.query(
        `INSERT INTO edges (from_page_id, to_page_id, lane, kind)
         VALUES ($1, $2, 'auto', 'semantic')
         ON CONFLICT (from_page_id, to_page_id, lane) DO NOTHING
         RETURNING from_page_id`,
        [a, b],
      );
      edgesAdded += ins.rows.length ? 1 : 0;
    }

    // EVERY page gets the marker, not just the ones that gained an edge — a
    // page whose candidates all failed the mutual test must not be re-selected
    // forever (that shipped once: fifteen consecutive batches re-swept the same
    // hundred pages while 781 were never reached). The marker means "this page
    // has been considered", not "this page is alone".
    if (!args.dryRun) {
      await db.query("UPDATE pages SET semantic_swept_at = now() WHERE id = $1", [id]);
    }
  }

  return { scanned: todo.rows.length, edgesAdded, pairs: pairs.slice(0, 50) };
}
