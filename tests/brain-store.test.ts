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
  // the referring page is untouched, and its ref still resolves on re-put
  const res = await store.putPage({ slug: "notes/points-old", body: "see [[old/place]] again" });
  expect(res.pending).toEqual([]);
  expect((await store.getBacklinks({ slug: "new/place" })).map((b) => b.slug)).toContain(
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
  // Backward, and the case a real import hits: the vault prefix makes the ref's
  // path a SUFFIX of the slug, which still satisfies it.
  await store.putPage({ slug: "vault/maps/deep-note", body: "# Deep Heading" });
  const res = await store.putPage({ slug: "notes/wants-deep", body: "see [[Maps/Deep Note]]" });
  expect(res.pending).toEqual([]);
  expect((await store.getBacklinks({ slug: "vault/maps/deep-note" })).map((b) => b.slug)).toContain(
    "notes/wants-deep",
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
