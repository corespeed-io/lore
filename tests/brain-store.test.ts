import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Db, Query } from "../src/server/db.js";
import { initSchema } from "../src/server/db.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { chunkBody, extractWikilinks } from "../src/server/pipeline.js";
import type { Store } from "../src/server/store.js";
import { createStore } from "../src/server/store.js";

const DIM = 8;

// Deterministic fake embeddings: identical text → identical vector, so the
// vector arm's mechanics are testable without a provider.
function fakeVec(text: string): number[] {
  const v = new Array(DIM).fill(0.01);
  for (let i = 0; i < text.length; i++) v[i % DIM] += (text.charCodeAt(i) % 97) / 97;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

let embedCalls = 0;
const embed: EmbedFn = async (texts) => {
  embedCalls++;
  return texts.map(fakeVec);
};

let pg: PGlite;
let store: Store;

function pgliteDb(lite: PGlite): Db {
  const q: Query = async (text, params) => {
    const res = await lite.query(text, params as unknown[]);
    return { rows: res.rows as Record<string, unknown>[] };
  };
  return {
    query: q,
    async tx(fn) {
      const out = await lite.transaction((t) =>
        fn(async (text, params) => {
          const res = await t.query(text, params as unknown[]);
          return { rows: res.rows as Record<string, unknown>[] };
        }),
      );
      return out as Awaited<ReturnType<typeof fn>>;
    },
  };
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  store = createStore(db, embed);
});

afterAll(async () => {
  await pg.close();
});

test("chunkBody splits on paragraphs and hard-splits oversized ones", () => {
  expect(chunkBody("")).toEqual([]);
  expect(chunkBody("one para")).toEqual(["one para"]);
  const chunks = chunkBody(`${"a".repeat(1000)}\n\n${"b".repeat(1000)}`);
  expect(chunks.length).toBe(2);
  expect(chunkBody("x".repeat(5000)).length).toBeGreaterThan(1);
});

test("extractWikilinks handles targets, sections, aliases, and skips fences", () => {
  const body =
    "See [[people/jane]] and [[Acme Corp|the client]] and [[notes#sec]].\n```\n[[not-a-link]]\n```";
  expect(extractWikilinks(body).sort()).toEqual(["Acme Corp", "notes", "people/jane"]);
});

test("initSchema fails loud on an embedding-space change", async () => {
  const db = pgliteDb(pg);
  await expect(
    initSchema(db, { embeddingModel: "other-model", embeddingDim: DIM }),
  ).rejects.toThrow(/embedding space mismatch/);
});

test("putPage + getPage round-trip; title derived from heading", async () => {
  await store.putPage({
    slug: "people/jane",
    body: "# Jane Doe\n\nJane leads the memory system work at Acme.",
  });
  const page = await store.getPage({ slug: "people/jane" });
  expect(page.title).toBe("Jane Doe");
  expect(String(page.body)).toContain("memory system");
  expect(page.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("unchanged content skips embedding (content_hash short-circuit)", async () => {
  const before = embedCalls;
  const res = await store.putPage({
    slug: "people/jane",
    body: "# Jane Doe\n\nJane leads the memory system work at Acme.",
  });
  expect(res.unchanged).toBe(true);
  expect(embedCalls).toBe(before);
});

test("wikilinks become edges; backlinks resolve by slug and by title", async () => {
  await store.putPage({
    slug: "projects/memory",
    body: "Owned by [[people/jane]]. Related to [[Jane Doe]] as well.",
  });
  const backlinks = await store.getBacklinks({ slug: "people/jane" });
  expect(backlinks.map((b) => b.slug)).toContain("projects/memory");
});

test("forward references resolve when the target page appears", async () => {
  await store.putPage({ slug: "notes/early", body: "Mentions [[future-page]] before it exists." });
  expect(await store.getBacklinks({ slug: "future-page" })).toEqual([]);
  await store.putPage({ slug: "future-page", body: "Now I exist." });
  const backlinks = await store.getBacklinks({ slug: "future-page" });
  expect(backlinks.map((b) => b.slug)).toContain("notes/early");
});

test("related_ids in frontmatter become declared edges", async () => {
  await store.putPage({
    slug: "notes/linked",
    body: "no wikilinks here",
    frontmatter: { related_ids: ["people/jane"] },
  });
  const backlinks = await store.getBacklinks({ slug: "people/jane" });
  expect(backlinks.map((b) => b.slug)).toContain("notes/linked");
});

test("getPage fuzzy falls back to title; missing page throws not_found", async () => {
  const page = await store.getPage({ slug: "Jane Doe", fuzzy: true });
  expect(page.slug).toBe("people/jane");
  await expect(store.getPage({ slug: "nope/missing" })).rejects.toThrow(/not_found/);
});

test("listPages: newest first, lore PageHit shape", async () => {
  const pages = await store.listPages({ limit: 100 });
  expect(pages.length).toBeGreaterThan(0);
  expect(pages[0]).toHaveProperty("slug");
  expect(pages[0]).toHaveProperty("title");
  expect(pages[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const times = pages.map((p) => p.updated_at);
  expect([...times].sort().reverse()).toEqual(times);
});

test("search finds English via FTS and reports evidence + score + chunk_text", async () => {
  const hits = await store.search({ query: "memory system", limit: 10 });
  expect(hits.map((h) => h.slug)).toContain("people/jane");
  const hit = hits.find((h) => h.slug === "people/jane");
  expect(hit?.evidence).toMatch(/vector|keyword/);
  expect(typeof hit?.score).toBe("number");
  expect(hit?.chunk_text?.length).toBeGreaterThan(0);
});

test("search finds CJK exact substrings (ILIKE floor of the trigram arm)", async () => {
  await store.putPage({ slug: "notes/cjk", body: "我们决定自研记忆系统,替换掉外部引擎。" });
  const hits = await store.search({ query: "记忆系统", limit: 10 });
  expect(hits.map((h) => h.slug)).toContain("notes/cjk");
});

test("search survives an embeddings outage (lexical arms only)", async () => {
  const db = pgliteDb(pg);
  const broken = createStore(db, async () => {
    throw new Error("provider down");
  });
  const hits = await broken.search({ query: "memory system", limit: 10 });
  expect(hits.map((h) => h.slug)).toContain("people/jane");
});

test("traverse_graph returns {from_slug,to_slug} rows across the neighborhood", async () => {
  const edges = await store.traverseGraph({ slug: "people/jane", depth: 5, direction: "both" });
  expect(edges.length).toBeGreaterThan(0);
  for (const e of edges) {
    expect(typeof e.from_slug).toBe("string");
    expect(typeof e.to_slug).toBe("string");
  }
  expect(edges.some((e) => e.from_slug === "projects/memory" && e.to_slug === "people/jane")).toBe(
    true,
  );
});

test("remember creates a mem- page of kind memory", async () => {
  const { slug } = await store.remember({
    memory: "Yunpeng prefers ruthless minimal UI.",
    metadata: { category: "preference" },
  });
  expect(slug).toMatch(/^mem-[0-9a-f-]{36}$/);
  const page = await store.getPage({ slug });
  expect(page.type).toBe("memory");
});

test("soft delete hides a page everywhere and its edges from the graph", async () => {
  await store.putPage({ slug: "notes/tmp", body: "links [[people/jane]]" });
  await store.deletePage({ slug: "notes/tmp" });
  await expect(store.getPage({ slug: "notes/tmp" })).rejects.toThrow(/not_found/);
  const pages = await store.listPages({ limit: 200 });
  expect(pages.map((p) => p.slug)).not.toContain("notes/tmp");
  const backlinks = await store.getBacklinks({ slug: "people/jane" });
  expect(backlinks.map((b) => b.slug)).not.toContain("notes/tmp");
  await expect(store.deletePage({ slug: "notes/tmp" })).rejects.toThrow(/not_found/);
});

test("putPage revives a soft-deleted slug", async () => {
  await store.putPage({ slug: "notes/tmp", body: "back again" });
  const page = await store.getPage({ slug: "notes/tmp" });
  expect(page.body).toBe("back again");
});

test("invalid slugs are rejected", async () => {
  await expect(store.putPage({ slug: "has space", body: "x" })).rejects.toThrow(/invalid slug/);
  await expect(store.putPage({ slug: "bad[slug]", body: "x" })).rejects.toThrow(/invalid slug/);
});

test("every page reports a type (lore filters by strict equality)", async () => {
  await store.putPage({ slug: "notes/plain", body: "A note with no type at all." });
  const pages = await store.listPages({ limit: 200 });
  for (const p of pages) expect(p.type, `${p.slug} has no type`).toBeTruthy();
  const byslug = new Map(pages.map((p) => [p.slug, p.type]));
  expect(byslug.get("notes/plain")).toBe("note");
  expect(byslug.get("people/jane")).toBe("person");
  expect((await store.getPage({ slug: "people/jane" })).type).toBe("person");
});

test("LIKE metacharacters in a query are matched literally, not as wildcards", async () => {
  await store.putPage({ slug: "notes/pct", body: "Conversion was 50% last quarter." });
  // Lexical arms only: the vector arm has no similarity floor, so it returns
  // its nearest pages for ANY query and would mask what ILIKE matched.
  const lexical = createStore(pgliteDb(pg), async () => {
    throw new Error("vector arm off");
  });
  const wildcard = await lexical.search({ query: "%", limit: 50 });
  expect(wildcard.map((h) => h.slug)).not.toContain("notes/plain");
  const literal = await lexical.search({ query: "50%", limit: 10 });
  expect(literal.map((h) => h.slug)).toContain("notes/pct");
});

test("changing a page from note to memory is not skipped as unchanged", async () => {
  const body = "This text does not change.";
  await store.putPage({ slug: "notes/flip", body });
  const second = await store.putPage({ slug: "notes/flip", body, kind: "memory" });
  expect(second.unchanged).toBe(false);
  expect((await store.getPage({ slug: "notes/flip" })).type).toBe("memory");
});
