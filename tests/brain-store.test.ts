import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Db, Query } from "../src/server/db.js";
import { initSchema } from "../src/server/db.js";
import { rowToMemory } from "../src/server/memory/items.js";
import { renderProjection } from "../src/server/memory/projection.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { chunkBody, extractRefs, normalizeRef } from "../src/server/pipeline.js";
import type { Store } from "../src/server/store.js";
import { createStore, normalizePageSlug } from "../src/server/store.js";
import { refAddress } from "../src/server/vault.js";

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

test("extractRefs handles targets, sections, aliases, and skips fences", () => {
  const body =
    "See [[people/jane]] and [[Acme Corp|the client]] and [[notes#sec]].\n```\n[[not-a-link]]\n```";
  expect(extractRefs(body).sort()).toEqual(["Acme Corp", "notes", "people/jane"]);
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

test("put_page keeps kind and frontmatter the caller omitted", async () => {
  const { slug } = await store.remember({
    memory: "v1 text",
    metadata: { category: "preference", related_ids: ["people/jane"] },
  });
  // The natural "update this memory" call: slug + new body, nothing else.
  await store.putPage({ slug, body: "v2 text" });
  const after = await store.getPage({ slug });
  expect(after.body).toBe("v2 text");
  expect(after.type).toBe("memory");
  expect((after.frontmatter as Record<string, unknown>).category).toBe("preference");
  // related_ids are graph edges — losing them would silently unlink the page.
  expect((await store.getBacklinks({ slug: "people/jane" })).map((b) => b.slug)).toContain(slug);
  // Clearing is still possible, but only by asking for it.
  await store.putPage({ slug, body: "v3 text", frontmatter: {} });
  expect((await store.getPage({ slug })).frontmatter).toEqual({});
});

test("list_pages can narrow to memories or notes", async () => {
  const memories = await store.listPages({ limit: 200, kind: "memory" });
  expect(memories.length).toBeGreaterThan(0);
  expect(memories.every((p) => p.type === "memory")).toBe(true);
  const notes = await store.listPages({ limit: 200, kind: "note" });
  expect(notes.some((p) => p.slug.startsWith("mem-"))).toBe(false);
  const all = await store.listPages({ limit: 200 });
  expect(all.length).toBeGreaterThan(memories.length);
});

test("soft delete drops the chunks so they stop eating ANN candidate slots", async () => {
  await store.putPage({ slug: "notes/bulky", body: "para one\n\npara two\n\npara three" });
  const before = await pg.query("SELECT count(*)::int AS n FROM chunks");
  await store.deletePage({ slug: "notes/bulky" });
  const after = await pg.query("SELECT count(*)::int AS n FROM chunks");
  const rows = (r: unknown) => Number((r as { rows: { n: number }[] }).rows[0].n);
  expect(rows(after)).toBeLessThan(rows(before));
  const kept = await pg.query("SELECT body FROM pages WHERE slug = 'notes/bulky'");
  expect((kept as { rows: { body: string }[] }).rows[0].body).toContain("para one");
});

test("restore_page brings a page back AND re-indexes it for search", async () => {
  await store.putPage({ slug: "notes/oops", body: "Uniquewordzephyr appears only here." });
  expect(
    (await store.search({ query: "Uniquewordzephyr", limit: 5 })).map((h) => h.slug),
  ).toContain("notes/oops");
  await store.deletePage({ slug: "notes/oops" });
  expect(
    (await store.search({ query: "Uniquewordzephyr", limit: 5 })).map((h) => h.slug),
  ).not.toContain("notes/oops");
  await store.restorePage({ slug: "notes/oops" });
  const page = await store.getPage({ slug: "notes/oops" });
  expect(page.body).toContain("Uniquewordzephyr");
  // The trap: restoring through the normal put path without clearing
  // content_hash short-circuits as "unchanged" and leaves zero chunks.
  const chunks = await pg.query(
    "SELECT count(*)::int AS n FROM chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'notes/oops'",
  );
  expect(Number((chunks as { rows: { n: number }[] }).rows[0].n)).toBeGreaterThan(0);
  expect(
    (await store.search({ query: "Uniquewordzephyr", limit: 5 })).map((h) => h.slug),
  ).toContain("notes/oops");
  await expect(store.restorePage({ slug: "notes/never-deleted" })).rejects.toThrow(/not_found/);
});

test("restore keeps kind and frontmatter", async () => {
  const { slug } = await store.remember({ memory: "restore me", metadata: { category: "c" } });
  await store.deletePage({ slug });
  await store.restorePage({ slug });
  const page = await store.getPage({ slug });
  expect(page.type).toBe("memory");
  expect((page.frontmatter as Record<string, unknown>).category).toBe("c");
});

test("an identical remember retry returns the same page instead of duplicating", async () => {
  const a = await store.remember({ memory: "exactly the same", metadata: { category: "z" } });
  const b = await store.remember({ memory: "exactly the same", metadata: { category: "z" } });
  expect(b.slug).toBe(a.slug);
  const dupes = await pg.query(
    "SELECT count(*)::int AS n FROM pages WHERE body = 'exactly the same' AND deleted_at IS NULL",
  );
  expect(Number((dupes as { rows: { n: number }[] }).rows[0].n)).toBe(1);
  // Different metadata is a different memory, not a retry.
  const c = await store.remember({ memory: "exactly the same", metadata: { category: "other" } });
  expect(c.slug).not.toBe(a.slug);
});

test("traversal does not step through a soft-deleted page", async () => {
  await store.putPage({ slug: "chain/a", body: "to [[chain/b]]" });
  await store.putPage({ slug: "chain/b", body: "to [[chain/c]]" });
  await store.putPage({ slug: "chain/c", body: "to [[chain/d]]" });
  await store.putPage({ slug: "chain/d", body: "end" });
  expect(
    (await store.traverseGraph({ slug: "chain/a", depth: 5, direction: "both" })).length,
  ).toBeGreaterThanOrEqual(3);
  await store.deletePage({ slug: "chain/b" });
  const edges = await store.traverseGraph({ slug: "chain/a", depth: 5, direction: "both" });
  // c-d is a real edge, but it is only reachable from a THROUGH the dead page.
  const slugs = new Set(edges.flatMap((e) => [e.from_slug, e.to_slug]));
  expect(slugs.has("chain/d")).toBe(false);
});

test("an absurdly large body is refused before it becomes thousands of chunks", async () => {
  await expect(store.putPage({ slug: "notes/huge", body: "x".repeat(1_000_001) })).rejects.toThrow(
    /body too large/,
  );
});

test("normalizeRef folds width, case, quotes and whitespace", () => {
  expect(normalizeRef("  Some   Note  ")).toBe("some note");
  expect(normalizeRef('"Quoted"')).toBe("quoted");
  // NFKC: fullwidth CJK-keyboard latin must fold to ASCII, or a ref typed in a
  // CJK IME never matches the page it names.
  expect(normalizeRef("ＭＯＣ")).toBe("moc");
});

test("extractRefs: markdown links, frontmatter values, embeds and inline code", () => {
  expect(extractRefs("see [Acme](notes/acme.md) and [x](./other)")).toEqual(
    expect.arrayContaining(["notes/acme", "other"]),
  );
  // external, mailto, anchors and non-markdown files are not page refs
  expect(extractRefs("[a](https://x.com) [b](mailto:a@b.c) [c](#sec) [d](img.png)")).toEqual([]);
  // image embeds are attachments, not links
  expect(extractRefs("![[Pasted image.png]] and ![alt](pic.md)")).toEqual([]);
  // structure lives in Properties for a lot of real vaults
  expect(
    extractRefs("body has none", { up: "[[MOC]]", related: ["[[A]]", "[[B]]"] }).sort(),
  ).toEqual(["A", "B", "MOC"]);
  // a note documenting the syntax must not grow an edge
  expect(extractRefs("write `[[example]]` to link")).toEqual([]);
  // A stray '%' is malformed percent-encoding and decodeURIComponent throws on
  // it. Thrown here, it would propagate out of putPage and abort the import of
  // an entire vault over one sloppy link, so the odd link degrades and its
  // neighbours still resolve.
  expect(() => extractRefs("[a](report-100%.md) [b](notes/ok.md)")).not.toThrow();
  expect(extractRefs("[a](report-100%.md) [b](notes/ok.md)").sort()).toEqual([
    "notes/ok",
    "report-100%",
  ]);

  // THREE READERS OF "IS THIS A PAGE". isMarkdown (the import filter) and
  // NOTE_EXT (the slug stripper) both accepted `.markdown`; this parser accepted
  // only `md`. So the file imported, [[Notes/Other.markdown]] linked to it, and
  // the Markdown-link spelling produced NO ref — which is worse than a broken
  // one, because list_broken_links reports refs that resolved to nothing, not
  // refs that were never extracted. All three now read one exported NOTE_EXT.
  expect(extractRefs("[Other](Notes/Other.markdown)")).toEqual(["Notes/Other"]);
  expect(extractRefs("[Other](Notes/Other.MARKDOWN)")).toEqual(["Notes/Other"]);
  // ...and the negative half is unchanged: a non-page extension is still not a ref.
  expect(extractRefs("[d](img.png) [e](doc.pdf) [f](sheet.markdownx)")).toEqual([]);
});

// The end-to-end half of the same finding: the ref has to become a real edge,
// not merely be extracted.
test("a .markdown Markdown-link target makes an edge like its .md sibling", async () => {
  await store.putPage({ slug: "notes/target-md", body: "# Target" });
  await store.putPage({ slug: "notes/target-markdown", body: "# Target" });
  const md = await store.putPage({
    slug: "notes/from-md",
    body: "see [T](notes/target-md.md)",
  });
  const markdown = await store.putPage({
    slug: "notes/from-markdown",
    body: "see [T](notes/target-markdown.markdown)",
  });
  expect(md.pending, "control: the .md spelling resolves").toEqual([]);
  expect(markdown.pending, "the .markdown spelling resolves too").toEqual([]);
  expect(
    (await store.getBacklinks({ slug: "notes/target-markdown" })).map((b) => b.slug),
  ).toContain("notes/from-markdown");
});

// P1: put_page on a SOFT-DELETED slug destroyed user data. The prior-row read
// filtered `deleted_at IS NULL` while the upsert sets `deleted_at = NULL`, so the
// write resurrected a page the read could not see — bringing it back with `kind`
// reset to 'note' and `frontmatter` reset to {}, silently dropping the category
// and the related_ids EDGES, and reporting unchanged:false as though all was
// well. This is verbatim the harm AGENTS.md gives as the reason "omitted fields
// are preserved" exists, on the sibling path that fix missed.
test("editing a soft-deleted page preserves the fields it did not mention", async () => {
  await store.putPage({ slug: "notes/target-x", body: "# Target X" });
  await store.putPage({
    slug: "notes/rich",
    body: "original body",
    kind: "memory",
    frontmatter: { category: "work", related_ids: ["notes/target-x"] },
  });
  const edges = async () =>
    (await store.getBacklinks({ slug: "notes/target-x" })).map((b) => b.slug);
  expect(await edges(), "control: the edge exists before the delete").toEqual(["notes/rich"]);

  await store.deletePage({ slug: "notes/rich" });
  // A body-only edit, exactly what an agent sends when changing prose.
  const res = await store.putPage({ slug: "notes/rich", body: "revised body" });
  expect(res.unchanged).toBe(false);

  const back = await store.getPage({ slug: "notes/rich" });
  expect(back.body).toContain("revised body");
  expect(back.type, "kind was reset to note").toBe("memory");
  expect((back.frontmatter as Record<string, unknown>).category, "frontmatter was cleared").toBe(
    "work",
  );
  expect(await edges(), "the related_ids edge was destroyed").toEqual(["notes/rich"]);
});

// ...and the other direction of the same read: the content_hash short-circuit
// must not fire for a DELETED page, or an identical re-put answers unchanged:true
// and silently leaves it deleted.
test("re-putting identical bytes over a soft-deleted page brings it back", async () => {
  await store.putPage({ slug: "notes/same", body: "identical body" });
  await store.deletePage({ slug: "notes/same" });
  const res = await store.putPage({ slug: "notes/same", body: "identical body" });
  expect(res.unchanged, "reported unchanged and left the page deleted").toBe(false);
  expect((await store.getPage({ slug: "notes/same" })).body).toContain("identical body");
  // MIRROR: on a LIVE page the short-circuit still works, which is what makes
  // re-ingest free.
  expect((await store.putPage({ slug: "notes/same", body: "identical body" })).unchanged).toBe(
    true,
  );
});

// mcp.ts's put_page promises "Omitted fields are left as they were". Title was the
// one it did not keep: the prior-row read never selected it, so a body-only edit on
// a page whose title came from frontmatter, or from an H1 the edit removed, silently
// renamed it to the slug-derived fallback. Title is half the FTS vector and the
// whole input to the title boost, so that is a ranking change with no diff.
test("an omitted title is preserved, and an explicit empty one re-derives", async () => {
  await store.putPage({ slug: "notes/titled", title: "Q3 Board Review", body: "no heading here" });
  expect((await store.getPage({ slug: "notes/titled" })).title).toBe("Q3 Board Review");

  // The ordinary edit: body only, nothing else mentioned.
  await store.putPage({ slug: "notes/titled", body: "revised, still no heading" });
  expect(
    (await store.getPage({ slug: "notes/titled" })).title,
    "a body-only edit renamed the page",
  ).toBe("Q3 Board Review");

  // MIRROR 1: an explicit title still wins.
  await store.putPage({ slug: "notes/titled", title: "Renamed", body: "x" });
  expect((await store.getPage({ slug: "notes/titled" })).title).toBe("Renamed");
  // MIRROR 2: an explicit EMPTY title means "derive it", which is how a caller
  // clears one.
  await store.putPage({ slug: "notes/titled", title: "", body: "# From The Heading" });
  expect((await store.getPage({ slug: "notes/titled" })).title).toBe("From The Heading");
});

// A control character in a QUERY is not a reason to fail the call. Postgres
// rejects a NUL inside a text parameter, and the FTS arm runs outside the try
// that lets the vector arm degrade — so one NUL threw out of the whole search.
test("a control character in a search query degrades instead of throwing", async () => {
  await store.putPage({ slug: "notes/searchable", body: "# Searchable\n\nthe quick brown fox" });
  const hits = await store.search({ query: "quick\u0000 brown" });
  expect(hits.map((h) => h.slug)).toContain("notes/searchable");
  // ...and a query that is ONLY control characters is empty, not an error.
  expect(await store.search({ query: "\u0000\u000b" })).toEqual([]);
});

// Sibling of the search-door fix: a NUL reaching Postgres as a text parameter
// threw a raw driver error. Refused here with a message that says what to do —
// refused rather than stripped, because a body is the user's content and a query
// is only a request.
test("a NUL in a body, title or frontmatter is refused with a readable message", async () => {
  for (const args of [
    { slug: "notes/n1", body: "hello\u0000world" },
    { slug: "notes/n2", body: "ok", title: "bad\u0000title" },
    { slug: "notes/n3", body: "ok", frontmatter: { note: "bad\u0000value" } },
  ]) {
    await expect(store.putPage(args), JSON.stringify(args.slug)).rejects.toThrow(
      /contains a NUL byte/,
    );
  }
  expect(
    (await store.listPages({ limit: 200 })).filter((p) => p.slug.startsWith("notes/n")),
  ).toEqual([]);
  // MIRROR: other control characters are storable and must still work.
  await store.putPage({ slug: "notes/ok", body: "tab\there and a vertical\u000btab" });
  expect((await store.getPage({ slug: "notes/ok" })).body).toContain("tab");
});

test("a ref resolves by filename even when the title differs", async () => {
  // The real Obsidian case: the H1 is not the filename, so the title arm cannot
  // match and only the basename arm can. (A page with no H1 derives its title
  // FROM the slug tail, which would make this pass for the wrong reason.)
  await store.putPage({
    slug: "notes/deep-note-xyz",
    body: "# Completely Different Heading\n\ntarget",
  });
  const res = await store.putPage({ slug: "notes/refers", body: "see [[Deep Note Xyz]]" });
  expect(res.pending).toEqual([]);
  expect((await store.getBacklinks({ slug: "notes/deep-note-xyz" })).map((b) => b.slug)).toContain(
    "notes/refers",
  );
});

test("a ref resolves by declared alias", async () => {
  await store.putPage({
    slug: "people/robert-smith",
    body: "# Robert Smith\n\nbio",
    frontmatter: { aliases: ["Bob", "Bobby S"] },
  });
  const res = await store.putPage({ slug: "notes/mentions-bob", body: "asked [[Bob]] about it" });
  expect(res.pending).toEqual([]);
  expect((await store.getBacklinks({ slug: "people/robert-smith" })).map((b) => b.slug)).toContain(
    "notes/mentions-bob",
  );
  // and the page is findable by its own alias
  expect((await store.search({ query: "Bobby S", limit: 10 })).map((h) => h.slug)).toContain(
    "people/robert-smith",
  );
});

test("put_page reports refs that resolved to nothing", async () => {
  const res = await store.putPage({
    slug: "notes/has-broken",
    body: "points at [[No Such Page At All]]",
  });
  expect(res.pending).toEqual(["No Such Page At All"]);
  const broken = await store.brokenLinks({ limit: 50 });
  expect(broken).toEqual(
    expect.arrayContaining([{ from_slug: "notes/has-broken", ref: "No Such Page At All" }]),
  );
  // an unchanged re-put still reports it
  const again = await store.putPage({
    slug: "notes/has-broken",
    body: "points at [[No Such Page At All]]",
  });
  expect(again.unchanged).toBe(true);
  expect(again.pending).toEqual(["No Such Page At All"]);
});

test("a forward ref resolves through any arm, not just exact slug", async () => {
  await store.putPage({ slug: "notes/early-alias-ref", body: "waits for [[Nickname]]" });
  await store.putPage({ slug: "notes/early-base-ref", body: "waits for [[Late Note]]" });
  await store.putPage({
    slug: "vault/late-note",
    body: "# Late Note\n\narrived",
    frontmatter: { aliases: ["Nickname"] },
  });
  const backlinks = (await store.getBacklinks({ slug: "vault/late-note" })).map((b) => b.slug);
  expect(backlinks).toContain("notes/early-alias-ref");
  expect(backlinks).toContain("notes/early-base-ref");
  expect(await store.brokenLinks({ limit: 50 })).not.toContainEqual({
    from_slug: "notes/early-alias-ref",
    ref: "Nickname",
  });
});

test("rename_page keeps stale [[old-slug]] refs working and rejects collisions", async () => {
  await store.putPage({ slug: "old/place", body: "content" });
  await store.putPage({ slug: "notes/points-old", body: "see [[old/place]]" });
  await store.renamePage({ slug: "old/place", to: "new/place" });
  await expect(store.getPage({ slug: "old/place" })).rejects.toThrow(/not_found/);
  expect((await store.getPage({ slug: "new/place" })).body).toBe("content");
  // CHANGED IN ROUND 3, deliberately. [[old/place]] is an ADDRESS and that
  // address is now vacant, so the alias the rename leaves behind may not answer
  // it: an alias is a name. Honouring it would also mean a page later created AT
  // old/place could never take its own inbound links — the same permanent
  // mis-attachment the address rule exists to stop (see resolveRef). The ref is
  // reported broken instead of silently redirected.
  const res = await store.putPage({ slug: "notes/points-old", body: "see [[old/place]] again" });
  expect(res.pending).toEqual(["old/place"]);
  expect((await store.getBacklinks({ slug: "new/place" })).map((b) => b.slug)).not.toContain(
    "notes/points-old",
  );
  // What the rename alias is actually for, and what still works: a NAME-shaped
  // old slug, and the page's own basename/title — Obsidian's default link style.
  await store.putPage({ slug: "oldname", body: "movable" });
  await store.renamePage({ slug: "oldname", to: "new/spot" });
  const byName = await store.putPage({ slug: "notes/points-name", body: "see [[oldname]]" });
  expect(byName.pending).toEqual([]);
  expect((await store.getBacklinks({ slug: "new/spot" })).map((b) => b.slug)).toContain(
    "notes/points-name",
  );
  // ...and a page that later moves INTO the vacated address takes those links.
  await store.putPage({ slug: "old/place", body: "new tenant" });
  expect((await store.getBacklinks({ slug: "old/place" })).map((b) => b.slug)).toContain(
    "notes/points-old",
  );
  await expect(store.renamePage({ slug: "new/place", to: "people/jane" })).rejects.toThrow(
    /already taken/,
  );
  await expect(store.renamePage({ slug: "nope/gone", to: "x/y" })).rejects.toThrow(/not_found/);
});

test("find_orphans lists pages nothing points to", async () => {
  await store.putPage({ slug: "notes/lonely", body: "nobody links here" });
  const orphans = (await store.findOrphans({ limit: 200 })).map((o) => o.slug);
  expect(orphans).toContain("notes/lonely");
  expect(orphans).not.toContain("people/jane");
});

test("the mention sweep writes only auto edges, is idempotent, and is reversible", async () => {
  await store.putPage({ slug: "people/wanda-ford", body: "# Wanda Ford\n\nbio" });
  await store.putPage({ slug: "notes/mentions-wanda", body: "Talked to Wanda Ford about it." });

  // Nothing inferred yet: naming a page is not a link.
  expect(
    (await store.getBacklinks({ slug: "people/wanda-ford" })).map((b) => b.slug),
  ).not.toContain("notes/mentions-wanda");

  const dry = await store.sweepMentions({ limit: 200, dryRun: true });
  expect(dry.pairs).toEqual(
    expect.arrayContaining([{ from_slug: "notes/mentions-wanda", to_slug: "people/wanda-ford" }]),
  );
  expect(dry.edgesAdded).toBe(0); // a dry run writes nothing
  expect(
    (await store.getBacklinks({ slug: "people/wanda-ford" })).map((b) => b.slug),
  ).not.toContain("notes/mentions-wanda");

  const first = await store.sweepMentions({ limit: 200 });
  expect(first.edgesAdded).toBeGreaterThan(0);
  expect((await store.getBacklinks({ slug: "people/wanda-ford" })).map((b) => b.slug)).toContain(
    "notes/mentions-wanda",
  );
  // The inferred edge lives in its own lane, so a person can tell it from theirs.
  const lanes = await pg.query(
    `SELECT DISTINCT lane FROM edges e
     JOIN pages f ON f.id = e.from_page_id WHERE f.slug = 'notes/mentions-wanda'`,
  );
  expect((lanes as { rows: { lane: string }[] }).rows.map((r) => r.lane)).toEqual(["auto"]);

  // Idempotent: a second sweep of the same pages adds nothing.
  const second = await store.sweepMentions({ limit: 200 });
  expect(second.edgesAdded).toBe(0);

  // Reversible: one delete undoes every inference it ever made.
  const cleared = await store.clearAutoEdges();
  expect(cleared.removed).toBeGreaterThan(0);
  expect(
    (await store.getBacklinks({ slug: "people/wanda-ford" })).map((b) => b.slug),
  ).not.toContain("notes/mentions-wanda");
  // ...and a declared link to the same page is untouched by the clear.
  await store.putPage({ slug: "notes/declares-wanda", body: "see [[people/wanda-ford]]" });
  await store.clearAutoEdges();
  expect((await store.getBacklinks({ slug: "people/wanda-ford" })).map((b) => b.slug)).toContain(
    "notes/declares-wanda",
  );
});

test("a forward ref lands whatever spelling it was written in", async () => {
  // Vault import walks files in directory order, so the referring note is
  // normally written BEFORE its target: forward references are the common case.
  // All three spellings resolve fine when the target already exists; parked,
  // only the one that happens to be spelled like the target's basename did.
  await store.putPage({ slug: "notes/fwd-slug", body: "waits for [[late-note-a]]" });
  await store.putPage({ slug: "notes/fwd-path", body: "waits for [[Maps/Late Note B]]" });
  await store.putPage({ slug: "notes/fwd-md", body: "waits for [the note](Maps/Late Note C.md)" });
  // The H1 is deliberately not the filename, so only the basename arm can match.
  for (const [slug, heading] of [
    ["maps/late-note-a", "Totally Other Heading"],
    ["maps/late-note-b", "Another Heading"],
    ["maps/late-note-c", "Third Heading"],
  ]) {
    await store.putPage({ slug, body: `# ${heading}\n\narrived` });
  }
  const backlinks = (slug: string) =>
    store.getBacklinks({ slug }).then((rows) => rows.map((r) => r.slug));
  expect(await backlinks("maps/late-note-a")).toContain("notes/fwd-slug");
  expect(await backlinks("maps/late-note-b")).toContain("notes/fwd-path");
  expect(await backlinks("maps/late-note-c")).toContain("notes/fwd-md");
  // ...and the parked rows are consumed, so list_broken_links stops accusing them.
  const broken = (await store.brokenLinks({ limit: 200 })).map((b) => b.from_slug);
  expect(broken).not.toContain("notes/fwd-slug");
  expect(broken).not.toContain("notes/fwd-path");
  expect(broken).not.toContain("notes/fwd-md");
});

test("a ref resolves to a macOS NFD filename typed composed", async () => {
  // macOS hands the directory picker decomposed filenames while the ref inside
  // the note is composed, so an accented filename in a real Mac vault imports
  // as an orphan unless both forms are compared.
  // Escaped on purpose: the two forms look identical on screen, and the whole
  // point is that they are different strings.
  const nfd = "notes/cafe\u0301-plan"; // café-plan, decomposed the way macOS stores it
  await store.putPage({ slug: nfd, body: "# Unrelated Heading\n\nnotes" });
  const res = await store.putPage({
    slug: "notes/refers-cafe",
    body: "see [[Caf\u00e9 Plan]]", // composed, the way the ref is typed
  });
  expect(res.pending).toEqual([]);
  expect((await store.getBacklinks({ slug: nfd })).map((b) => b.slug)).toContain(
    "notes/refers-cafe",
  );
});

test("a failed re-embed leaves a restore retryable, not a live zero-chunk page", async () => {
  await store.putPage({ slug: "notes/atomic", body: "Uniquewordquokka appears only here." });
  await store.deletePage({ slug: "notes/atomic" });
  const broken = createStore(pgliteDb(pg), async () => {
    throw new Error("provider down");
  });
  await expect(broken.restorePage({ slug: "notes/atomic" })).rejects.toThrow(/provider down/);
  // Un-deleting before the embed left the page LIVE with zero chunks and no
  // deleted row to restore from: invisible to the vector arm, unrecoverable.
  await expect(store.getPage({ slug: "notes/atomic" })).rejects.toThrow(/not_found/);
  await store.restorePage({ slug: "notes/atomic" });
  expect(
    (await store.search({ query: "Uniquewordquokka", limit: 5 })).map((h) => h.slug),
  ).toContain("notes/atomic");
});

test("getPage fuzzy matches '%' literally instead of as a wildcard", async () => {
  await store.putPage({
    slug: "notes/margin-target",
    body: "# Gross margin of 50% for the quarter\n\nbody",
  });
  // The bait: an unescaped '%' matches every title, and the fuzzy arm returns
  // the SHORTEST one — which is this page, never the one the caller named.
  await store.putPage({ slug: "notes/ab", body: "unrelated" });
  expect((await store.getPage({ slug: "50%", fuzzy: true })).slug).toBe("notes/margin-target");
  expect((await store.getPage({ slug: "%", fuzzy: true })).slug).toBe("notes/margin-target");
});

test("a slug cannot escape the export tar", async () => {
  // Export writes `${slug}.md` into a USTAR archive, so a slug that is not a
  // relative path is a traversal on extraction — and GNU tar refuses the whole
  // archive (exit 2), taking the user's own restore with it.
  for (const bad of [
    "../escaped",
    "notes/../../etc/passwd",
    "/abs/note",
    "notes//double",
    ".",
    "notes/.",
  ]) {
    await expect(store.putPage({ slug: bad, body: "x" })).rejects.toThrow(/invalid slug/);
  }
  await store.putPage({ slug: "notes/renameable", body: "x" });
  await expect(store.renamePage({ slug: "notes/renameable", to: "../escaped" })).rejects.toThrow(
    /invalid slug/,
  );
  // A dot INSIDE a segment is an ordinary slug and stays one.
  expect((await store.putPage({ slug: "notes/v1.2-plan", body: "x" })).slug).toBe(
    "notes/v1.2-plan",
  );
});

test("the mention sweep reads the typed pages it needs, not the whole vault", async () => {
  // Its own database: the assertion is how many rows one query returns, which
  // only means something for a known vault.
  const lite = new PGlite({ extensions: { vector, pg_trgm } });
  const base = pgliteDb(lite);
  await initSchema(base, { embeddingModel: "fake", embeddingDim: DIM });
  let maxRows = 0;
  const counted: Db = {
    query: async (text, params) => {
      const res = await base.query(text, params);
      maxRows = Math.max(maxRows, res.rows.length);
      return res;
    },
    tx: base.tx,
  };
  const isolated = createStore(counted, embed);
  await isolated.putPage({ slug: "people/nadia-quill", body: "# Nadia Quill\n\nbio" });
  for (let i = 0; i < 40; i++) {
    await isolated.putPage({ slug: `notes/bulk-${i}`, body: "Talked to Nadia Quill about it." });
  }

  maxRows = 0;
  const swept = await isolated.sweepMentions({ limit: 5 });
  expect(swept.scanned).toBe(5);
  // One typed page in the gazetteer plus a 5-page batch. Reading all 41 live
  // pages to build a one-name gazetteer is unbounded memory on a real vault.
  expect(maxRows).toBeLessThanOrEqual(10);
  // ...and the pairs still name pages, not raw ids.
  expect(swept.pairs.length).toBeGreaterThan(0);
  expect(swept.pairs.every((p) => p.from_slug.startsWith("notes/bulk-"))).toBe(true);
  expect(swept.pairs[0].to_slug).toBe("people/nadia-quill");
  await lite.close();
});

test("the reserved memory/ namespace is closed at the store, whitespace and all", async () => {
  // The hole a guard outside the store cannot close: it read the CALLER's string
  // while the row was written from slug.trim(), so " memory/vault/x" does not
  // start with "memory/" and still upserts memory/vault/x — deleted_at = NULL,
  // re-chunked, searchable, and no arm of runProjections' due query repairs it.
  for (const slug of [
    " memory/vault/squat",
    "\tmemory/vault/w1",
    "\nmemory/vault/w2",
    "memory/vault/w3",
    "  memory/thread/t1/w4  ",
  ]) {
    await expect(store.putPage({ slug, body: "squatting" })).rejects.toThrow(/reserved/);
  }
  const live = await pg.query("SELECT slug FROM pages WHERE slug LIKE 'memory/%'");
  expect((live as { rows: unknown[] }).rows).toEqual([]);

  // A rename's destination is the same door, decided on the same string.
  await store.putPage({ slug: "notes/squatter", body: "mine" });
  await expect(
    store.renamePage({ slug: "notes/squatter", to: " memory/vault/squat" }),
  ).rejects.toThrow(/reserved/);
  expect((await store.getPage({ slug: "notes/squatter" })).slug).toBe("notes/squatter");
});

test("only a committed memory's own projection may live under memory/", async () => {
  const id = crypto.randomUUID();
  const slug = `memory/vault/${id}`;
  await pg.query(
    `INSERT INTO memory_items (id, scope_type, memory_type, content, status, fingerprint)
     VALUES ($1, 'vault', 'semantic', 'Zanzibar espresso is the house roast.', 'committed', $1)`,
    [id],
  );
  const row = (await pg.query("SELECT * FROM memory_items WHERE id = $1", [id])) as {
    rows: Record<string, unknown>[];
  };
  const memory = rowToMemory(row.rows[0]);
  const canonical = renderProjection(memory).body;
  // Ownership is read from DATA, so the projection layer's own write needs no
  // exemption and no caller identity — this is projectMemory's exact call.
  await store.putPage({ slug, title: "ignored", body: canonical, kind: "memory" });
  expect((await store.getPage({ slug })).slug).toBe(slug);
  // The title is derived from the canonical body, never taken from the caller:
  // a forged title on an honest body is half the fts vector.
  expect((await store.getPage({ slug })).title).not.toBe("ignored");

  // Owning the slug is not enough — the page is a pure function of the memory.
  // A forged body at the canonical slug of a STILL-COMMITTED memory used to
  // replace the searchable text for good: memory_items kept the true value,
  // projection_status stayed 'ok', and nothing ever re-rendered it.
  await expect(store.putPage({ slug: ` ${slug}`, body: "Zanzibar is decaf." })).rejects.toThrow(
    /reserved/,
  );
  expect(String((await store.getPage({ slug })).body)).toBe(canonical);
  // A slug nothing owns is refused even with a well-formed id...
  await expect(
    store.putPage({ slug: `memory/vault/${crypto.randomUUID()}`, body: "x" }),
  ).rejects.toThrow(/reserved/);
  // ...and so is the wrong scope shape for a real committed memory.
  await expect(store.putPage({ slug: `memory/thread/t1/${id}`, body: "x" })).rejects.toThrow(
    /reserved/,
  );

  // The refutation verbatim: capture the projected body, let the lifecycle retire
  // the memory (page soft-deleted), then re-put the captured body under the slug
  // with a leading space. That resurrected a REVOKED memory's page permanently.
  const captured = String((await store.getPage({ slug })).body);
  await store.deletePage({ slug });
  await pg.query("UPDATE memory_items SET status = 'revoked' WHERE id = $1", [id]);
  await expect(store.putPage({ slug: ` ${slug}`, body: captured })).rejects.toThrow(/reserved/);
  await expect(store.restorePage({ slug: ` ${slug}` })).rejects.toThrow(/reserved/);
  await expect(store.getPage({ slug })).rejects.toThrow(/not_found/);
});

test("an evicted projection can always be revived, even from a stale body", async () => {
  // The store's own restore re-writes the row it just read, so it is exempt from
  // the body rule. Without that exemption a page whose memory moved on while it
  // was evicted could never come back: restore would throw, the projection would
  // fail, and the retry would throw again — a memory unsearchable forever.
  const id = crypto.randomUUID();
  const slug = `memory/vault/${id}`;
  await pg.query(
    `INSERT INTO memory_items (id, scope_type, memory_type, content, status, fingerprint)
     VALUES ($1, 'vault', 'semantic', 'Lisbon cortado is the afternoon pour.', 'committed', $1)`,
    [id],
  );
  const render = async () => {
    const row = (await pg.query("SELECT * FROM memory_items WHERE id = $1", [id])) as {
      rows: Record<string, unknown>[];
    };
    return renderProjection(rowToMemory(row.rows[0])).body;
  };
  await store.putPage({ slug, body: await render(), kind: "memory" });
  await store.deletePage({ slug });
  await pg.query("UPDATE memory_items SET content = $2 WHERE id = $1", [
    id,
    "Lisbon cortado is the morning pour.",
  ]);
  await store.restorePage({ slug });
  expect(String((await store.getPage({ slug })).body)).toContain("afternoon");
  // ...and the sweep's fresh render then lands on the live page.
  await store.putPage({ slug, body: await render(), kind: "memory" });
  expect(String((await store.getPage({ slug })).body)).toContain("morning");
  await store.deletePage({ slug });
});

test("a path-shaped forward ref is not satisfied by a page in another directory", async () => {
  // Parking [[deep/steal-a]] and then writing zz/steal-a made the parked ref a
  // CANDIDATE, and resolveRef fell through to its basename arm while the real page
  // did not exist yet: a wrong edge, the pending row consumed, and nothing repairs
  // it — an idempotent re-put of the real target returns unchanged.
  await store.putPage({ slug: "src/a", body: "the real one is [[deep/steal-a]]" });
  await store.putPage({ slug: "zz/steal-a", body: "# Decoy Heading" });
  expect((await store.getBacklinks({ slug: "zz/steal-a" })).map((b) => b.slug)).not.toContain(
    "src/a",
  );
  // The miss stays VISIBLE instead of turning into a wrong edge.
  expect(await store.brokenLinks({ limit: 200 })).toContainEqual({
    from_slug: "src/a",
    ref: "deep/steal-a",
  });
  await store.putPage({ slug: "deep/steal-a", body: "the real target" });
  expect((await store.getBacklinks({ slug: "deep/steal-a" })).map((b) => b.slug)).toContain(
    "src/a",
  );
  expect(await store.brokenLinks({ limit: 200 })).not.toContainEqual({
    from_slug: "src/a",
    ref: "deep/steal-a",
  });
});

test("a path-shaped ref lands in the directory it names, forward and backward", async () => {
  await store.putPage({ slug: "notes/wants-maps", body: "waits for [[Maps/Dated Note]]" });
  // Written FIRST and sharing the last segment: this is the page the coarse
  // candidate key used to hand the ref to.
  await store.putPage({ slug: "archive/2019/dated-note", body: "# Old One" });
  expect(
    (await store.getBacklinks({ slug: "archive/2019/dated-note" })).map((b) => b.slug),
  ).not.toContain("notes/wants-maps");
  await store.putPage({ slug: "maps/dated-note", body: "# Real One" });
  expect((await store.getBacklinks({ slug: "maps/dated-note" })).map((b) => b.slug)).toContain(
    "notes/wants-maps",
  );
  // CHANGED IN ROUND 3, deliberately. This used to assert that a vault PREFIX on
  // the slug still satisfies the ref (folded slug ends with the ref's path). That
  // suffix rule is what let archive/maps/dated-note steal [[Maps/Dated Note]] —
  // and it is self-defeating besides, because a path-shaped ref is written
  // precisely when the basename is ambiguous, so resolving it by suffix hands it
  // back to whichever colliding page was written first. An address now means one
  // page, and a prefixed import's path-shaped refs are REPORTED broken instead of
  // silently attached to a same-named page in another directory.
  await store.putPage({ slug: "vault/maps/deep-note", body: "# Deep Heading" });
  const res = await store.putPage({ slug: "notes/wants-deep", body: "see [[Maps/Deep Note]]" });
  expect(res.pending).toEqual(["Maps/Deep Note"]);
  expect(
    (await store.getBacklinks({ slug: "vault/maps/deep-note" })).map((b) => b.slug),
  ).not.toContain("notes/wants-deep");
  expect(await store.brokenLinks({ limit: 200 })).toContainEqual({
    from_slug: "notes/wants-deep",
    ref: "Maps/Deep Note",
  });
  // ...and the bare NAME still reaches it, which is Obsidian's default link
  // style: a name asserts no location, so any page answering to it may take it.
  const byName = await store.putPage({ slug: "notes/wants-deep-name", body: "see [[Deep Note]]" });
  expect(byName.pending).toEqual([]);
  expect((await store.getBacklinks({ slug: "vault/maps/deep-note" })).map((b) => b.slug)).toContain(
    "notes/wants-deep-name",
  );
});

test("a rename lands the refs already parked on the name it moves to", async () => {
  await store.putPage({ slug: "notes/awaits-moved", body: "waits for [[moved/here]]" });
  expect(await store.brokenLinks({ limit: 200 })).toContainEqual({
    from_slug: "notes/awaits-moved",
    ref: "moved/here",
  });
  await store.putPage({ slug: "elsewhere/thing", body: "content" });
  // Only putPage swept pending_links, so a name made resolvable by a RENAME left
  // the parked ref parked forever with list_broken_links still accusing it.
  await store.renamePage({ slug: "elsewhere/thing", to: "moved/here" });
  expect((await store.getBacklinks({ slug: "moved/here" })).map((b) => b.slug)).toContain(
    "notes/awaits-moved",
  );
  expect(await store.brokenLinks({ limit: 200 })).not.toContainEqual({
    from_slug: "notes/awaits-moved",
    ref: "moved/here",
  });
});

test("a separators-only name resolves forward, not only backward", async () => {
  // Its coarse key is '', which the filter used to disable rather than match —
  // the one arm where a ref resolvable once the page exists could never land.
  await store.putPage({ slug: "notes/awaits-seps", body: "waits for [[-_-]]" });
  await store.putPage({ slug: "sep/-_-", body: "arrived" });
  expect((await store.getBacklinks({ slug: "sep/-_-" })).map((b) => b.slug)).toContain(
    "notes/awaits-seps",
  );
});

test("an inferred edge cannot promote a page in search", async () => {
  // The backlink boost counts the declared lane only: a heuristic must not be
  // able to change ranking.
  await store.putPage({
    slug: "concepts/zylophone-topic",
    body: "# Zylophone topic\n\nabout zylophone",
  });
  for (const i of [1, 2, 3, 4, 5]) {
    await store.putPage({ slug: `notes/auto-ref-${i}`, body: "Discussing Zylophone topic here." });
  }
  const before = (await store.search({ query: "zylophone", limit: 5 })).find(
    (h) => h.slug === "concepts/zylophone-topic",
  );
  await store.sweepMentions({ limit: 200 });
  const after = (await store.search({ query: "zylophone", limit: 5 })).find(
    (h) => h.slug === "concepts/zylophone-topic",
  );
  expect(after?.score).toBe(before?.score);
  await store.clearAutoEdges();
});

// --- the address rule ------------------------------------------------------
// A ref containing '/' names a LOCATION: only the page at that location may
// satisfy it, through any arm. Round 2 guarded the basename arm alone and the
// title arm, the alias arm and an "ends with the ref's path" escape each reached
// the same wrong edge. Each of these tests fails if the rule is applied to
// fewer than all four arms.

const backlinkSlugs = (slug: string) =>
  store.getBacklinks({ slug }).then((rows) => rows.map((r) => r.slug));

test("no arm may satisfy an address with a page that does not live there", async () => {
  await store.putPage({ slug: "src/wants-a", body: "the real one is [[Maps/Dated Note X]]" });
  await store.putPage({ slug: "src/wants-b", body: "the real one is [[deep/steal-b]]" });
  await store.putPage({ slug: "src/wants-c", body: "the real one is [[deep/steal-c]]" });

  // A — one directory deeper: its folded slug ENDS with the ref's path.
  await store.putPage({ slug: "archive/maps/dated-note-x", body: "# Decoy A" });
  // B — the title arm: an H1 that is literally the ref.
  await store.putPage({ slug: "zz/decoy-b", body: "# deep/steal-b" });
  // C — the alias arm: frontmatter claiming the address as one of its names.
  await store.putPage({
    slug: "zz/decoy-c",
    body: "decoy c",
    frontmatter: { aliases: ["deep/steal-c"] },
  });

  for (const [decoy, from] of [
    ["archive/maps/dated-note-x", "src/wants-a"],
    ["zz/decoy-b", "src/wants-b"],
    ["zz/decoy-c", "src/wants-c"],
  ]) {
    expect(await backlinkSlugs(decoy), decoy).not.toContain(from);
  }
  // The miss stays VISIBLE. A stolen ref is worse than a broken one precisely
  // because landing deletes the pending row, so nothing reports it any more.
  const broken = await store.brokenLinks({ limit: 200 });
  expect(broken).toContainEqual({ from_slug: "src/wants-a", ref: "Maps/Dated Note X" });
  expect(broken).toContainEqual({ from_slug: "src/wants-b", ref: "deep/steal-b" });
  expect(broken).toContainEqual({ from_slug: "src/wants-c", ref: "deep/steal-c" });

  // ...and the real pages, arriving last, still take their links.
  await store.putPage({ slug: "maps/dated-note-x", body: "# Real A" });
  await store.putPage({ slug: "deep/steal-b", body: "# Real B" });
  await store.putPage({ slug: "deep/steal-c", body: "# Real C" });
  expect(await backlinkSlugs("maps/dated-note-x")).toContain("src/wants-a");
  expect(await backlinkSlugs("deep/steal-b")).toContain("src/wants-b");
  expect(await backlinkSlugs("deep/steal-c")).toContain("src/wants-c");
  const after = await store.brokenLinks({ limit: 200 });
  for (const from of ["src/wants-a", "src/wants-b", "src/wants-c"]) {
    expect(after.map((b) => b.from_slug)).not.toContain(from);
  }
});

test("a rename cannot steal an address either", async () => {
  // renamePage sweeps pending_links too, so it is a second door into the same
  // landing. It resolves through resolveRef, so it answers to the same rule.
  await store.putPage({ slug: "src/wants-moved", body: "waits for [[Maps/Moved Note]]" });
  await store.putPage({ slug: "tmp/holding", body: "# Holding" });
  await store.renamePage({ slug: "tmp/holding", to: "archive/maps/moved-note" });
  expect(await backlinkSlugs("archive/maps/moved-note")).not.toContain("src/wants-moved");
  expect(await store.brokenLinks({ limit: 200 })).toContainEqual({
    from_slug: "src/wants-moved",
    ref: "Maps/Moved Note",
  });
  await store.putPage({ slug: "maps/moved-note", body: "# Real Moved" });
  expect(await backlinkSlugs("maps/moved-note")).toContain("src/wants-moved");
});

test("the address rule holds for CJK and for a ref carrying #section|alias", async () => {
  await store.putPage({ slug: "src/wants-cjk", body: "等待 [[地图/日期笔记]]" });
  await store.putPage({ slug: "src/wants-sect", body: "see [[Maps/Sect Note#Heading|the note]]" });
  await store.putPage({ slug: "存档/地图/日期笔记", body: "# 诱饵" });
  await store.putPage({ slug: "archive/maps/sect-note", body: "# Decoy Sect" });
  expect(await backlinkSlugs("存档/地图/日期笔记")).not.toContain("src/wants-cjk");
  expect(await backlinkSlugs("archive/maps/sect-note")).not.toContain("src/wants-sect");
  await store.putPage({ slug: "地图/日期笔记", body: "# 真的" });
  await store.putPage({ slug: "maps/sect-note", body: "# Real Sect" });
  expect(await backlinkSlugs("地图/日期笔记")).toContain("src/wants-cjk");
  expect(await backlinkSlugs("maps/sect-note")).toContain("src/wants-sect");
});

test("a root-relative markdown link resolves instead of being broken forever", async () => {
  // Docusaurus/mkdocs write [Note](/maps/root-note.md). Keeping the leading '/'
  // left an empty first segment, which invalidSlug forbids on every page — so
  // the ref was unsatisfiable by construction and sat in list_broken_links.
  await store.putPage({ slug: "maps/root-note", body: "# Root Note" });
  const back = await store.putPage({
    slug: "src/root-back",
    body: "see [Note](/maps/root-note.md)",
  });
  expect(back.pending).toEqual([]);
  expect(await backlinkSlugs("maps/root-note")).toContain("src/root-back");
  // ...forward too, and it is still an ADDRESS: a same-named page elsewhere
  // cannot take it while it waits.
  await store.putPage({ slug: "src/root-fwd", body: "see [Later](/maps/root-late.md)" });
  await store.putPage({ slug: "zz/root-late", body: "# Decoy Late" });
  expect(await backlinkSlugs("zz/root-late")).not.toContain("src/root-fwd");
  await store.putPage({ slug: "maps/root-late", body: "# Later" });
  expect(await backlinkSlugs("maps/root-late")).toContain("src/root-fwd");
  expect((await store.brokenLinks({ limit: 200 })).map((b) => b.from_slug)).not.toContain(
    "src/root-fwd",
  );
});

test("a path-shaped related_id is an address too", async () => {
  // The other ref loop in putPage. Same resolveRef, so the same rule — this
  // pins that the frontmatter door was not left open.
  await store.putPage({
    slug: "src/rel-wants",
    body: "no body links",
    frontmatter: { related_ids: ["deep/rel-target"] },
  });
  await store.putPage({ slug: "zz/rel-decoy", body: "# deep/rel-target" });
  expect(await backlinkSlugs("zz/rel-decoy")).not.toContain("src/rel-wants");
  await store.putPage({ slug: "deep/rel-target", body: "the real one" });
  expect(await backlinkSlugs("deep/rel-target")).toContain("src/rel-wants");
});

test("a relative link resolves against the page it is written on", async () => {
  // `./` and `../` mean what they mean in Markdown: relative to the REFERRING
  // file's folder. They used to be stripped, which read as "../Maps/Note names
  // the same page as Maps/Note" — harmless only while ref matching fell back to
  // bare filenames. Once a ref containing a separator became an ADDRESS naming
  // exactly one page, flattening turned every relative link into either a wrong
  // edge or a permanently broken one. A vault imported under a folder prefix
  // (the `/import` default) is where it bites: `../Maps/Reading MOC.md` written
  // in `v/notes/x` means `v/maps/reading-moc`, and stripping the prefix made it
  // mean a top-level `maps/reading-moc` that does not exist.
  await store.putPage({ slug: "vault/maps/rel-target", body: "# Rel Target" });
  await store.putPage({ slug: "vault/notes/rel-sibling", body: "# Sibling" });

  // ../ climbs out of notes/ and back down into maps/
  const up = await store.putPage({
    slug: "vault/notes/rel-up",
    body: "see [t](../maps/Rel Target.md)",
  });
  expect(up.pending).toEqual([]);
  expect(await backlinkSlugs("vault/maps/rel-target")).toContain("vault/notes/rel-up");

  // ./ stays in the referrer's own folder
  const here = await store.putPage({
    slug: "vault/notes/rel-here",
    body: "see [s](./rel-sibling.md)",
  });
  expect(here.pending).toEqual([]);
  expect(await backlinkSlugs("vault/notes/rel-sibling")).toContain("vault/notes/rel-here");

  // ...and a relative link that climbs past the root resolves to what is left,
  // rather than throwing or silently naming the wrong page.
  const past = await store.putPage({
    slug: "vault/notes/rel-past",
    body: "see [t](../../vault/maps/Rel Target.md)",
  });
  expect(past.pending).toEqual([]);
  expect(await backlinkSlugs("vault/maps/rel-target")).toContain("vault/notes/rel-past");
});

test("one address, many spellings — and never two pages", async () => {
  // Everything the ref->slug transform is for: case, fullwidth (a CJK IME types
  // ＭＡＰＳ), the ../ prefix Logseq and Foam emit, and the .md a Markdown link
  // carries. All name ONE page.
  // `./maps/…` is NOT in this list and must not be: written on `src/spell-N` it
  // resolves against that page's own folder and names `src/maps/…`, a different
  // page. See the relative-resolution test below.
  //
  // CHANGED IN ROUND 4, deliberately, and it is a TIGHTENING: [[maps/spelled_note]]
  // used to be in this list. Folding '-' and '_' together is what let two real
  // sibling files share one address (see the underscore test below), so the
  // underscore spelling now names a different page and is REPORTED broken rather
  // than silently landing here.
  await store.putPage({ slug: "maps/spelled-note", body: "# Spelled" });
  const refs = [
    "[[Maps/Spelled Note]]",
    "[[Maps/Spelled Note.md]]",
    "[[ＭＡＰＳ/Spelled Note]]",
    "[x](../maps/Spelled Note.md)",
  ];
  for (let i = 0; i < refs.length; i++) {
    const res = await store.putPage({ slug: `src/spell-${i}`, body: `see ${refs[i]}` });
    expect(res.pending, refs[i]).toEqual([]);
    expect(await backlinkSlugs("maps/spelled-note"), refs[i]).toContain(`src/spell-${i}`);
  }
  // A resolved ref is never ALSO reported broken: landing and parking are the
  // two branches of one decision inside one transaction.
  const broken = (await store.brokenLinks({ limit: 200 })).map((b) => b.from_slug);
  for (let i = 0; i < refs.length; i++) expect(broken).not.toContain(`src/spell-${i}`);
  // ...and it lands on exactly one page: one declared edge out of each referrer.
  const edges = await pg.query(
    `SELECT count(*)::int AS n FROM edges e JOIN pages p ON p.id = e.from_page_id
     WHERE p.slug LIKE 'src/spell-%' AND e.lane = 'declared'`,
  );
  expect(Number((edges as { rows: { n: number }[] }).rows[0].n)).toBe(refs.length);
});

test("two pages sharing a basename: an address picks its own, a bare name is a name", async () => {
  // Both refs are parked, and the page that is NOT wanted is written first.
  await store.putPage({ slug: "src/addr-x", body: "[[alpha/twin-note]]" });
  await store.putPage({ slug: "src/addr-y", body: "[[beta/twin-note]]" });
  await store.putPage({ slug: "beta/twin-note", body: "# Beta Twin" });
  expect(await backlinkSlugs("beta/twin-note")).not.toContain("src/addr-x");
  await store.putPage({ slug: "alpha/twin-note", body: "# Alpha Twin" });
  expect(await backlinkSlugs("alpha/twin-note")).toEqual(expect.arrayContaining(["src/addr-x"]));
  expect(await backlinkSlugs("alpha/twin-note")).not.toContain("src/addr-y");
  expect(await backlinkSlugs("beta/twin-note")).toContain("src/addr-y");
  // A bare name asserts NO location, so it is genuinely ambiguous input; the
  // store answers deterministically (shortest slug, then alphabetically) rather
  // than by write order. beta/twin-note is shorter than alpha/twin-note.
  const bare = await store.putPage({ slug: "src/addr-bare", body: "[[Twin Note]]" });
  expect(bare.pending).toEqual([]);
  expect(await backlinkSlugs("beta/twin-note")).toContain("src/addr-bare");
  expect(await backlinkSlugs("alpha/twin-note")).not.toContain("src/addr-bare");
});

test("an address survives its target being deleted and recreated", async () => {
  await store.putPage({ slug: "src/wants-cycle", body: "points at [[cycle/target]]" });
  await store.putPage({ slug: "cycle/target", body: "v1" });
  expect(await backlinkSlugs("cycle/target")).toContain("src/wants-cycle");
  await store.deletePage({ slug: "cycle/target" });
  // Re-put the referrer while the target is gone: the ref re-parks.
  const gone = await store.putPage({
    slug: "src/wants-cycle",
    body: "points at [[cycle/target]]!",
  });
  expect(gone.pending).toEqual(["cycle/target"]);
  // A same-named page cannot move in on the parked ref while the address is
  // vacant-but-soft-deleted...
  await store.putPage({ slug: "zz/target", body: "# Decoy Target" });
  expect(await backlinkSlugs("zz/target")).not.toContain("src/wants-cycle");
  // ...and restore_page, which writes through putPage, lands it.
  await store.restorePage({ slug: "cycle/target" });
  expect(await backlinkSlugs("cycle/target")).toContain("src/wants-cycle");
});

test("an address is found past the basename arm's candidate cap", async () => {
  // The cap is 25, ordered shortest-slug-first, and the tie-break has nothing to
  // do with which page is AT the address — so a vault with many same-named files
  // (exactly when path-shaped refs get written) could starve the real target out
  // of the candidate list and park a ref that is perfectly resolvable.
  for (let i = 0; i < 26; i++) {
    await store.putPage({ slug: `d${String(i).padStart(2, "0")}/my-note`, body: `decoy ${i}` });
  }
  await store.putPage({ slug: "src/wants-capped", body: "see [[Deeper/Dir/My Note]]" });
  await store.putPage({ slug: "deeper/dir/my-note", body: "# The Real One" });
  expect(await backlinkSlugs("deeper/dir/my-note")).toContain("src/wants-capped");
  expect((await store.brokenLinks({ limit: 200 })).map((b) => b.from_slug)).not.toContain(
    "src/wants-capped",
  );
  // ...and none of the 26 decoys took it.
  const stolen = await pg.query(
    `SELECT pt.slug FROM edges e
     JOIN pages pf ON pf.id = e.from_page_id JOIN pages pt ON pt.id = e.to_page_id
     WHERE pf.slug = 'src/wants-capped'`,
  );
  expect((stolen as { rows: { slug: string }[] }).rows.map((r) => r.slug)).toEqual([
    "deeper/dir/my-note",
  ]);
});

test("the mention sweep cannot consume or steal a parked address", async () => {
  // The one edge writer that does NOT go through resolveRef. It must stay unable
  // to reach the bad state: its edges are in the 'auto' lane, it never touches
  // pending_links, and clear_auto_edges undoes all of it — so a parked address is
  // still parked, still reported, and still lands on the right page afterwards.
  await store.putPage({ slug: "src/wants-swept", body: "waits for [[people/sweep-target]]" });
  await store.putPage({ slug: "people/sweep-decoy", body: "# Sweep Target" });
  await store.sweepMentions({ limit: 200 });
  expect(await backlinkSlugs("people/sweep-decoy")).not.toContain("src/wants-swept");
  expect(await store.brokenLinks({ limit: 200 })).toContainEqual({
    from_slug: "src/wants-swept",
    ref: "people/sweep-target",
  });
  await store.putPage({ slug: "people/sweep-target", body: "# The Real Sweep Target" });
  expect(await backlinkSlugs("people/sweep-target")).toContain("src/wants-swept");
  await store.clearAutoEdges();
  expect(await backlinkSlugs("people/sweep-target")).toContain("src/wants-swept");
});

test("percent-encoded and NFD path refs address the same page", async () => {
  // Two spellings a real export produces that no test covered: %20 in a Markdown
  // link target, and a macOS NFD path segment typed composed in the ref.
  const nfd = "maps/café-note"; // café-note, decomposed the way macOS stores it
  await store.putPage({ slug: nfd, body: "# Unrelated Heading" });
  await store.putPage({ slug: "maps/enc-note", body: "# Another Unrelated Heading" });
  const a = await store.putPage({ slug: "src/enc-ref", body: "[x](Maps/Enc%20Note.md)" });
  const b = await store.putPage({ slug: "src/nfd-ref", body: "see [[Maps/Café Note]]" });
  expect(a.pending).toEqual([]);
  expect(b.pending).toEqual([]);
  expect(await backlinkSlugs("maps/enc-note")).toContain("src/enc-ref");
  expect(await backlinkSlugs(nfd)).toContain("src/nfd-ref");
});

test("two slugs folding to ONE address: the literal spelling still wins its own page", async () => {
  // The boundary of what the folding can tell apart, pinned so it is a known
  // property rather than a surprise: separators and case fold away, so
  // maps/dup-note and maps/dup_note are ONE address. The canonical-spelling probe
  // must not let that steal a ref that names an existing slug exactly — an exact
  // slug is the strongest evidence there is, and it stays the most specific arm.
  await store.putPage({ slug: "maps/dup_note", body: "# First Written" });
  await store.putPage({ slug: "maps/dup-note", body: "# Second Written" });
  const lands = async (ref: string, i: number) => {
    await store.putPage({ slug: `src/dup-${i}`, body: `see [[${ref}]]` });
    const rows = await pg.query(
      `SELECT pt.slug FROM edges e JOIN pages pf ON pf.id = e.from_page_id
       JOIN pages pt ON pt.id = e.to_page_id WHERE pf.slug = $1`,
      [`src/dup-${i}`],
    );
    return (rows as { rows: { slug: string }[] }).rows.map((r) => r.slug);
  };
  expect(await lands("maps/dup_note", 0)).toEqual(["maps/dup_note"]);
  expect(await lands("maps/dup-note", 1)).toEqual(["maps/dup-note"]);
  // Spelled as neither, it lands on the canonical (hyphenated) page — one page,
  // decided by the folding, not by which of the two was written first.
  expect(await lands("Maps/Dup Note", 2)).toEqual(["maps/dup-note"]);
});

test("a slug whose name merely FOLDS into a separator cannot take an address", async () => {
  // The sideways step Unicode offers: NFKC turns a fullwidth solidus into '/', so
  // the single-segment page "uni／steal" folds to the two-segment address
  // "uni/steal". It is not at that address — it is one top-level page with an odd
  // name — and it must not be able to consume a ref that names the directory.
  // Its H1 is the ref, so the title arm really does hand this row to the rule —
  // the rule has to be what rejects it, not the query happening to miss it.
  await store.putPage({ slug: "src/wants-uni", body: "waits for [[uni/steal]]" });
  await store.putPage({ slug: "uni／steal", body: "# uni/steal" });
  expect(await backlinkSlugs("uni／steal")).not.toContain("src/wants-uni");
  await store.putPage({ slug: "uni/steal", body: "# The Real One" });
  expect(await backlinkSlugs("uni/steal")).toContain("src/wants-uni");
});

// --- the address is EXACT: '-' and '_' name different files -----------------
// Round 3's predicate was "the slug FOLDS to that path", and the fold turned
// [-_]+ into spaces, so two real sibling files shared one address and whichever
// was written first answered a ref that named the other. The predicate is now
// "the slug IS that path": the ref goes through pathToSlug — the importer's own
// filename->slug transform, so there is ONE definition of the slug a name means
// — and the page's stored slug is compared as written.

test("an underscore names a different file, so write order cannot pick an address", async () => {
  // VERBATIM refutation, in order: the ref is parked, the underscore file lands
  // first and must not take it, and the file the ref names takes it when it
  // arrives. Every failure here is permanent — landing deletes the pending row,
  // so brokenLinks() then reports nothing and an idempotent re-put of the
  // referrer answers unchanged:true and repairs nothing.
  await store.putPage({ slug: "ord/wants-dash", body: "see [[Ord/Dated Note]]" });
  await store.putPage({ slug: "ord/dated_note", body: "# The underscore file" });
  expect(await backlinkSlugs("ord/dated_note")).not.toContain("ord/wants-dash");
  expect(await store.brokenLinks({ limit: 200 })).toContainEqual({
    from_slug: "ord/wants-dash",
    ref: "Ord/Dated Note",
  });
  await store.putPage({ slug: "ord/dated-note", body: "# The file the ref names" });
  expect(await backlinkSlugs("ord/dated-note")).toContain("ord/wants-dash");
  expect((await store.brokenLinks({ limit: 200 })).map((b) => b.from_slug)).not.toContain(
    "ord/wants-dash",
  );

  // REVERSE ORDER, same answer. Two orders giving two edges was the defect.
  await store.putPage({ slug: "rev/dated-note", body: "# Written first" });
  await store.putPage({ slug: "rev/dated_note", body: "# Written second" });
  const rev = await store.putPage({ slug: "rev/wants-dash", body: "see [[Rev/Dated Note]]" });
  expect(rev.pending).toEqual([]);
  expect(await backlinkSlugs("rev/dated-note")).toContain("rev/wants-dash");
  expect(await backlinkSlugs("rev/dated_note")).not.toContain("rev/wants-dash");

  // No ordering involved at all: both twins live, and a ref naming ONE of them
  // exactly lands on that one instead of on its canonical sibling.
  await store.putPage({ slug: "twin/dup_note", body: "# Underscore twin" });
  await store.putPage({ slug: "twin/dup-note", body: "# Hyphen twin" });
  await store.putPage({ slug: "twin/wants-under", body: "see [[Twin/Dup_Note]]" });
  expect(await backlinkSlugs("twin/dup_note")).toContain("twin/wants-under");
  expect(await backlinkSlugs("twin/dup-note")).not.toContain("twin/wants-under");

  // The realistic vault shape: an _index sibling cannot answer [[dx/index]].
  await store.putPage({ slug: "dx/wants-index", body: "see [[dx/index]]" });
  await store.putPage({ slug: "dx/_index", body: "# The underscore index" });
  expect(await backlinkSlugs("dx/_index")).not.toContain("dx/wants-index");
  await store.putPage({ slug: "dx/index", body: "# The real index" });
  expect(await backlinkSlugs("dx/index")).toContain("dx/wants-index");
});

test("a rename walks the page out of the address, so its addressed refs re-park", async () => {
  // The write-time rule is that an address means the page AT that path. A rename
  // moved the page out and dragged the inbound edge along: a page that does NOT
  // live at zz/addr held the inbound link of [[zz/addr]], brokenLinks() reported
  // nothing, and the address's real tenant — created immediately afterwards — got
  // none of them. Same rule, other direction, decided in the same place.
  await store.putPage({ slug: "zz/addr", body: "# First tenant" });
  await store.putPage({ slug: "src/points-addr", body: "see [[zz/addr]]" });
  expect(await backlinkSlugs("zz/addr")).toContain("src/points-addr");
  // A NAME-shaped ref at the same page, which MUST survive the rename: an alias
  // is a name, and over-parking would break Obsidian's default link style.
  await store.putPage({ slug: "src/names-addr", body: "see [[First tenant]]" });
  expect(await backlinkSlugs("zz/addr")).toContain("src/names-addr");

  await store.renamePage({ slug: "zz/addr", to: "moved/addr" });
  expect(await backlinkSlugs("moved/addr")).not.toContain("src/points-addr");
  expect(await store.brokenLinks({ limit: 200 })).toContainEqual({
    from_slug: "src/points-addr",
    ref: "zz/addr",
  });
  expect(await backlinkSlugs("moved/addr")).toContain("src/names-addr");

  // The address's next tenant takes the inbound link with NO re-put of the
  // referrer — which is the state a re-put could never have repaired anyway.
  await store.putPage({ slug: "zz/addr", body: "# New tenant" });
  expect(await backlinkSlugs("zz/addr")).toContain("src/points-addr");
  expect((await store.brokenLinks({ limit: 200 })).map((b) => b.from_slug)).not.toContain(
    "src/points-addr",
  );
});

test("a rename that swaps two slugs hands each address to whoever now lives there", async () => {
  await store.putPage({ slug: "sw/one", body: "# One" });
  await store.putPage({ slug: "sw/two", body: "# Two" });
  await store.putPage({ slug: "src/at-one", body: "see [[sw/one]]" });
  await store.putPage({ slug: "src/at-two", body: "see [[sw/two]]" });
  // A destination that exists is refused, so a swap is three moves — three
  // chances for an addressed edge to be dragged somewhere it does not belong.
  await store.renamePage({ slug: "sw/one", to: "sw/tmp" });
  await store.renamePage({ slug: "sw/two", to: "sw/one" });
  await store.renamePage({ slug: "sw/tmp", to: "sw/two" });
  expect((await store.getPage({ slug: "sw/one" })).title).toBe("Two");
  expect(await backlinkSlugs("sw/one")).toContain("src/at-one");
  expect(await backlinkSlugs("sw/one")).not.toContain("src/at-two");
  expect(await backlinkSlugs("sw/two")).toContain("src/at-two");
  expect(await backlinkSlugs("sw/two")).not.toContain("src/at-one");
  const broken = (await store.brokenLinks({ limit: 200 })).map((b) => b.from_slug);
  expect(broken).not.toContain("src/at-one");
  expect(broken).not.toContain("src/at-two");
});

test("a rename re-resolves the moved page's OWN relative links", async () => {
  // The outgoing half of the same defect: `../maps/x.md` is resolved against the
  // folder the referring page is IN (pipeline.ts), so moving the page changes
  // which address it names. Its body is untouched, so nothing re-embeds.
  await store.putPage({ slug: "mv/maps/rel-a", body: "# Rel A" });
  await store.putPage({ slug: "other/maps/rel-a", body: "# Other Rel A" });
  await store.putPage({ slug: "mv/notes/mover", body: "see [t](../maps/Rel A.md)" });
  expect(await backlinkSlugs("mv/maps/rel-a")).toContain("mv/notes/mover");
  await store.renamePage({ slug: "mv/notes/mover", to: "other/notes/mover" });
  expect(await backlinkSlugs("mv/maps/rel-a")).not.toContain("other/notes/mover");
  expect(await backlinkSlugs("other/maps/rel-a")).toContain("other/notes/mover");
});

test("slugs differing only by case or width: an address is exact, so neither steals", async () => {
  // The boundary of the canonical transform, pinned as a property. It lowercases
  // and NFKC-folds, so only the CANONICAL spelling is an address; a slug the
  // transform cannot spell stays reachable by naming it EXACTLY, and never by
  // naming its canonical twin. Both spellings answer deterministically, and
  // neither depends on which page was written first.
  await store.putPage({ slug: "CASE/Addr", body: "# Upper" });
  await store.putPage({ slug: "case/addr", body: "# Lower" });
  await store.putPage({ slug: "wide/ｎａｍｅ", body: "# Wide" });
  await store.putPage({ slug: "wide/name", body: "# Narrow" });
  const lands = async (ref: string, i: number) => {
    await store.putPage({ slug: `src/exact-${i}`, body: `see [[${ref}]]` });
    const rows = await pg.query(
      `SELECT pt.slug FROM edges e JOIN pages pf ON pf.id = e.from_page_id
       JOIN pages pt ON pt.id = e.to_page_id WHERE pf.slug = $1`,
      [`src/exact-${i}`],
    );
    return (rows as { rows: { slug: string }[] }).rows.map((r) => r.slug);
  };
  expect(await lands("case/addr", 0)).toEqual(["case/addr"]);
  expect(await lands("CASE/Addr", 1)).toEqual(["CASE/Addr"]);
  // Neither literal: the canonical page, and only it.
  expect(await lands("Case/Addr", 2)).toEqual(["case/addr"]);
  expect(await lands("wide/ｎａｍｅ", 3)).toEqual(["wide/ｎａｍｅ"]);
  expect(await lands("wide/name", 4)).toEqual(["wide/name"]);
});

test("a ref whose canonical form would DELETE a character addresses nothing", async () => {
  // Deleting a character forges a name the ref never spelled: 'ta%rget/deep-note'
  // canonicalizes to 'target/deep-note', and callers upstream (mcp.ts's
  // reserved-namespace door) screen the ref's RAW spelling. Such a ref must not
  // fall back to a NAME either: a name asserts no location, so the basename arm
  // alone would hand it the page whose filename is deep-note.
  await store.putPage({ slug: "target/deep-note", body: "# Deep Note Target" });
  for (const ref of ["ta%rget/deep-note", "ta\\rget/deep-note", "target\\deep-note"]) {
    const res = await store.putPage({ slug: "src/forged", body: `see [[${ref}]]` });
    expect(res.pending, ref).toEqual([ref]);
    expect(await backlinkSlugs("target/deep-note"), ref).not.toContain("src/forged");
  }
});

test("no parked ref names a live page: resolved and broken stay mutually exclusive", async () => {
  // A whole-database check over everything this file wrote. A parked address whose
  // page is live is the invisible half of the defect: brokenLinks() accuses a ref
  // that would resolve, and nothing ever sweeps it. The candidate set is spelled
  // out here rather than imported so the test is an independent reader of the
  // rule — a live page at ANY spelling the resolver accepts is a violation.
  const parked = await pg.query(
    `SELECT p.slug AS from_slug, pl.target_ref AS ref FROM pending_links pl
     JOIN pages p ON p.id = pl.from_page_id WHERE p.deleted_at IS NULL`,
  );
  const rows = (parked as { rows: { from_slug: string; ref: string }[] }).rows;
  expect(rows.length).toBeGreaterThan(0);
  for (const { from_slug, ref } of rows) {
    const address = refAddress(ref);
    if (address === null) continue;
    const live = await pg.query(
      "SELECT slug FROM pages WHERE slug = ANY($1::text[]) AND deleted_at IS NULL",
      [[...new Set([normalizePageSlug(ref), address, address.normalize("NFD")])]],
    );
    expect((live as { rows: { slug: string }[] }).rows, `${from_slug} -> ${ref}`).toEqual([]);
  }
});

test("slugs differing only by Unicode composition resolve by spelling, not write order", async () => {
  // The ONE fold the address rule still allows to reach across the page side, so
  // it is where to hunt for "two pages, one address": SQL equality is byte-exact
  // and macOS writes NFD filenames, so the resolver offers both compositions of
  // the address as candidates. Two pages can therefore both be candidates — and
  // the winner is decided by SPELLING (the composed form the canonical transform
  // produces), never by which page was written first. Built with explicit
  // normalize() calls so this test cannot depend on how the file is encoded.
  const composed = "cmp/café-note".normalize("NFC");
  const decomposed = "cmp/café-note".normalize("NFD");
  expect(composed).not.toBe(decomposed);
  const lands = async (slugs: string[], ref: string, tag: string) => {
    for (const slug of slugs) await store.putPage({ slug, body: `# body of ${slug}` });
    await store.putPage({ slug: `src/cmp-${tag}`, body: `see [[${ref}]]` });
    const rows = await pg.query(
      `SELECT pt.slug FROM edges e JOIN pages pf ON pf.id = e.from_page_id
       JOIN pages pt ON pt.id = e.to_page_id WHERE pf.slug = $1`,
      [`src/cmp-${tag}`],
    );
    return (rows as { rows: { slug: string }[] }).rows.map((r) => r.slug);
  };
  // Decomposed page written FIRST, composed second: the composed one answers.
  expect(await lands([decomposed, composed], "Cmp/Café Note".normalize("NFC"), "a")).toEqual([
    composed,
  ]);
  // ...and the ref's own composition does not change the answer either.
  expect(await lands([], "Cmp/Café Note".normalize("NFD"), "b")).toEqual([composed]);
  // A brain where ONLY the decomposed page exists still resolves — the case a real
  // Mac vault import produces, and the reason both compositions are offered.
  await store.putPage({ slug: "mac/naïve-note".normalize("NFD"), body: "# Mac file" });
  const mac = await store.putPage({
    slug: "src/cmp-mac",
    body: `see [[${"Mac/Naïve Note".normalize("NFC")}]]`,
  });
  expect(mac.pending).toEqual([]);
  expect(await backlinkSlugs("mac/naïve-note".normalize("NFD"))).toContain("src/cmp-mac");
});

// The query side is encoded differently from the document side, or the strong
// 2026 models are used at less than they are. The store is the only party that
// knows which side it is holding, so the role travels with the call; the prefix
// itself stays in the embedder, where the env lives.
test("the query prefix reaches queries and never touches documents", async () => {
  const seen: string[][] = [];
  const cfg = {
    url: "http://x/embeddings",
    apiKey: "k",
    model: "m",
    dim: DIM,
    queryPrefix: "Instruct: retrieve\nQuery: ",
  };
  const fetchSpy = async (_url: string, init: { body: string }) => {
    const input = JSON.parse(init.body).input as string[];
    seen.push(input);
    return {
      ok: true,
      json: async () => ({ data: input.map((_t, i) => ({ index: i, embedding: fakeVec("x") })) }),
    };
  };
  const orig = globalThis.fetch;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  try {
    const { makeEmbedFn } = await import("../src/server/pipeline.js");
    const embed = makeEmbedFn(cfg);
    await embed(["a doc"]);
    await embed(["a question"], "query");
    await embed(["explicit doc"], "document");
  } finally {
    globalThis.fetch = orig;
  }
  expect(seen[0]).toEqual(["a doc"]);
  expect(seen[1]).toEqual(["Instruct: retrieve\nQuery: a question"]);
  expect(seen[2]).toEqual(["explicit doc"]);
});

// An unset prefix must leave the bytes on the wire byte-identical to before,
// or every existing deployment silently changes its query encoding on upgrade.
test("no prefix configured leaves a query untouched", async () => {
  const seen: string[][] = [];
  const fetchSpy = async (_url: string, init: { body: string }) => {
    const input = JSON.parse(init.body).input as string[];
    seen.push(input);
    return {
      ok: true,
      json: async () => ({ data: input.map((_t, i) => ({ index: i, embedding: fakeVec("x") })) }),
    };
  };
  const orig = globalThis.fetch;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  try {
    const { makeEmbedFn } = await import("../src/server/pipeline.js");
    await makeEmbedFn({ url: "http://x", apiKey: "k", model: "m", dim: DIM })(["q"], "query");
  } finally {
    globalThis.fetch = orig;
  }
  expect(seen[0]).toEqual(["q"]);
});
