import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { type Store, createStore } from "../src/server/store.js";
import {
  SKIP_REPORT_PATH,
  serializeNote,
  splitPath,
  tarStream,
  withSkipReport,
} from "../src/server/tar.js";
import {
  isMarkdown,
  parseFrontmatter,
  parseNote,
  pathToSlug,
  refAddress,
  slugCollisions,
} from "../src/server/vault.js";

const DIM = 8;
const embed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array(DIM).fill(0.01);
    for (let i = 0; i < t.length; i++) v[i % DIM] += (t.charCodeAt(i) % 97) / 97;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

let pg: PGlite;
let store: Store;

function pgliteDb(lite: PGlite): Db {
  const q: Query = async (text, params) => ({
    rows: (await lite.query(text, params as unknown[])).rows as Record<string, unknown>[],
  });
  return {
    query: q,
    async tx(fn) {
      const out = await lite.transaction((t) =>
        fn(async (text, params) => ({
          rows: (await t.query(text, params as unknown[])).rows as Record<string, unknown>[],
        })),
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

test("pathToSlug keeps folders, slugifies filenames, strips unsafe characters", () => {
  expect(pathToSlug("Projects/My Note.md")).toBe("projects/my-note");
  expect(pathToSlug("./Vault/Deep/Sub Folder/A B.markdown")).toBe("vault/deep/sub-folder/a-b");
  // characters lore's slug rule forbids, and the ones that break a wikilink
  expect(pathToSlug("Weird [name] #1 | x.md")).toBe("weird-name-1-x");
  expect(pathToSlug("笔记/记忆系统.md")).toBe("笔记/记忆系统");
  expect(isMarkdown("a/b.md")).toBe(true);
  expect(isMarkdown("a/b.png")).toBe(false);
});

test("parseFrontmatter reads the subset Obsidian writes", () => {
  const { frontmatter, body } = parseFrontmatter(
    [
      "---",
      'title: "Robert Smith"',
      "aliases: [Bob, Bobby S]",
      "tags:",
      "  - person",
      "  - work",
      'up: "[[MOC]]"',
      "draft: true",
      "---",
      "",
      "# Robert",
      "",
      "body text",
    ].join("\n"),
  );
  expect(frontmatter.title).toBe("Robert Smith");
  expect(frontmatter.aliases).toEqual(["Bob", "Bobby S"]);
  expect(frontmatter.tags).toEqual(["person", "work"]);
  expect(frontmatter.up).toBe("[[MOC]]");
  expect(body.trimStart().startsWith("# Robert")).toBe(true);
  // no frontmatter at all is not an error
  expect(parseFrontmatter("just a body").frontmatter).toEqual({});
  // a lone --- in the body must not be read as a fence
  expect(parseFrontmatter("intro\n\n---\n\nmore").frontmatter).toEqual({});
});

test("parseNote prefers frontmatter title, then H1, then filename", () => {
  expect(parseNote({ path: "a/One.md", text: "---\ntitle: FM\n---\n# H1\n" }).title).toBe("FM");
  expect(parseNote({ path: "a/One.md", text: "# H1 Here\n" }).title).toBe("H1 Here");
  expect(parseNote({ path: "a/One.md", text: "no heading" }).title).toBe("One");
});

test("importing a vault links notes that only reference each other by name", async () => {
  // The shapes a real vault mixes: Properties-based structure, aliases, a
  // Markdown link, an image embed, CJK, and an out-of-order forward reference.
  const vault = [
    { path: "V/Maps/Reading MOC.md", text: "# Reading MOC\n\nhub for reading" },
    {
      path: "V/People/Robert Smith.md",
      text: "---\naliases: [Bob]\n---\n# Robert Smith\n\nsee [[Reading MOC]]",
    },
    { path: "V/Notes/Child.md", text: '---\nup: "[[Reading MOC]]"\n---\nno links in the body' },
    { path: "V/Notes/Asks Bob.md", text: "asked [[Bob]] about it" },
    { path: "V/Notes/Md Link.md", text: "see [the hub](../Maps/Reading MOC.md)" },
    { path: "V/Notes/Early.md", text: "waits for [[Later Note]]" },
    { path: "V/Notes/Later Note.md", text: "# Completely Other Heading\n\narrived late" },
    { path: "V/笔记/记忆系统.md", text: "自研记忆系统的设计" },
    { path: "V/attach/pic.png", text: "not markdown" },
  ];
  for (const file of vault) {
    if (!isMarkdown(file.path)) continue;
    const note = parseNote(file);
    await store.putPage({
      slug: note.slug,
      title: note.title,
      body: note.body,
      frontmatter: note.frontmatter,
    });
  }

  const backlinks = (slug: string) =>
    store.getBacklinks({ slug }).then((rows) => rows.map((r) => r.slug));

  // resolved by title, by frontmatter value, and by a relative Markdown link
  const hub = await backlinks("v/maps/reading-moc");
  expect(hub).toContain("v/people/robert-smith");
  expect(hub).toContain("v/notes/child");
  // ...and by a RELATIVE Markdown link, which is what Obsidian's Markdown mode
  // and every Logseq/Foam export emit.
  expect(hub).toContain("v/notes/md-link");
  // resolved by alias
  expect(await backlinks("v/people/robert-smith")).toContain("v/notes/asks-bob");
  // out-of-order forward ref resolved by filename even though the H1 differs
  expect(await backlinks("v/notes/later-note")).toContain("v/notes/early");
  // CJK note imported under a CJK slug and is searchable
  expect((await store.search({ query: "记忆系统", limit: 10 })).map((h) => h.slug)).toContain(
    "v/笔记/记忆系统",
  );
  // the attachment was not imported
  await expect(store.getPage({ slug: "v/attach/pic" })).rejects.toThrow(/not_found/);
});

test("a re-import of the same vault writes nothing", async () => {
  const file = { path: "V/Maps/Reading MOC.md", text: "# Reading MOC\n\nhub for reading" };
  const note = parseNote(file);
  const again = await store.putPage({
    slug: note.slug,
    title: note.title,
    body: note.body,
    frontmatter: note.frontmatter,
  });
  expect(again.unchanged).toBe(true);
});

test("export round-trips through import: same slugs, same links", async () => {
  const pages = await store.exportBatch({ limit: 500 });
  expect(pages.length).toBeGreaterThan(5);

  const fresh = new PGlite({ extensions: { vector, pg_trgm } });
  const db2 = pgliteDb(fresh);
  await initSchema(db2, { embeddingModel: "fake", embeddingDim: DIM });
  const store2 = createStore(db2, embed);
  for (const page of pages) {
    const file = {
      path: `${page.slug}.md`,
      text: serializeNote(page.title, page.frontmatter, page.body),
    };
    const note = parseNote(file);
    // The export writes slug.md, so the slug must survive the trip unchanged.
    expect(note.slug).toBe(page.slug);
    await store2.putPage({
      slug: note.slug,
      title: note.title,
      body: note.body,
      frontmatter: note.frontmatter,
    });
  }
  const before = (await store.getBacklinks({ slug: "v/maps/reading-moc" })).map((r) => r.slug);
  const after = (await store2.getBacklinks({ slug: "v/maps/reading-moc" })).map((r) => r.slug);
  expect(after.sort()).toEqual(before.sort());
  // and a "[[MOC]]"-style frontmatter value survived quoting
  expect(await store2.brokenLinks({ limit: 100 })).toEqual(await store.brokenLinks({ limit: 100 }));
  await fresh.close();
});

test("tarStream emits a well-formed archive", async () => {
  async function* two() {
    yield { path: "a/one.md", body: "first" };
    yield { path: "b/two.md", body: "x".repeat(600) }; // spans two blocks
  }
  const chunks: Uint8Array[] = [];
  const reader = tarStream(two(), 1_700_000_000).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  expect(total % 512).toBe(0);
  const flat = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    flat.set(c, at);
    at += c.length;
  }
  const dec = new TextDecoder();
  expect(dec.decode(flat.subarray(0, 9))).toBe("a/one.md\0");
  expect(dec.decode(flat.subarray(257, 262))).toBe("ustar");
  // header checksum must validate, or tar refuses the archive
  const stored = Number.parseInt(dec.decode(flat.subarray(148, 156)).replace(/\0.*$/, ""), 8);
  const copy = flat.slice(0, 512);
  copy.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of copy) sum += b;
  expect(sum).toBe(stored);
  // the archive ends with two zero blocks
  expect(flat.subarray(total - 1024).every((b) => b === 0)).toBe(true);
});

test("splitPath refuses paths USTAR cannot represent, rather than truncating", () => {
  expect(splitPath("short.md")).toEqual({ name: "short.md", prefix: "" });
  // The invariant, not one particular split: both halves fit their fields and
  // rejoin to the original path.
  const deep = `${"dir/".repeat(30)}note.md`;
  const split = splitPath(deep);
  expect(split).not.toBeNull();
  if (split) {
    expect(split.name.length).toBeLessThanOrEqual(100);
    expect(split.prefix.length).toBeLessThanOrEqual(155);
    expect(`${split.prefix}/${split.name}`).toBe(deep);
  }
  expect(splitPath(`${"x".repeat(200)}.md`)).toBeNull();
});

test("a page too long for USTAR is reported inside the archive, not dropped", async () => {
  // The skip is discovered mid-stream, long after the response headers went
  // out, so the only place it can still be observed is the archive itself.
  const tooLong = `${"x".repeat(200)}.md`;
  async function* pages() {
    yield { path: "ok.md", body: "kept" };
    yield { path: tooLong, body: "unrepresentable" };
  }
  const skipped: string[] = [];
  const stream = tarStream(withSkipReport(pages(), skipped), 1_700_000_000, (p) => skipped.push(p));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const flat = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    flat.set(c, at);
    at += c.length;
  }
  const text = new TextDecoder().decode(flat);
  expect(skipped).toEqual([tooLong]);
  expect(text).toContain(SKIP_REPORT_PATH);
  expect(text).toContain(tooLong);
  // and the good page still made it
  expect(text).toContain("kept");
});

test("the reserved memory namespace is refused by BOTH write paths", async () => {
  // put_page (the tool) and /api/import are the two ways a user page gets in.
  // Guarding one and not the other is how a generated projection gets clobbered,
  // which is exactly what happened before this test existed.
  const { isMemorySlug } = await import("../src/server/memory/projection.js");
  expect(isMemorySlug("memory/vault/abc")).toBe(true);
  expect(isMemorySlug("memory/thread/t1/abc")).toBe(true);
  expect(isMemorySlug("notes/memory-of-things")).toBe(false);

  // The importer derives the slug from the path, so a vault folder named
  // "memory" produces a reserved slug and must be skipped.
  const note = parseNote({ path: "memory/vault/squatter.md", text: "trying to squat" });
  expect(isMemorySlug(note.slug)).toBe(true);
});

test("refAddress is pathToSlug: ONE definition of the slug a name means", async () => {
  // The invariant, not a list of cases. A vault FILE and a path-shaped REF that
  // spell the same name must produce the same slug, or the store's address rule
  // and the importer disagree about where a page lives — which is how
  // maps/dated_note came to answer [[Maps/Dated Note]].
  for (const path of [
    "Projects/My Note.md",
    "Maps/Dated Note.md",
    "Maps/Dated_Note.md",
    "docs/_index.md",
    "笔记/记忆系统.md",
    "Vault/Deep/Sub Folder/A B.markdown",
    "ＭＡＰＳ/Spelled Note.md",
    "a/Weird 'quoted' name.md",
  ]) {
    expect(refAddress(path), path).toBe(pathToSlug(path));
  }
});

test("refAddress keeps '-' and '_' apart while a space still becomes '-'", () => {
  // The tension the address rule has to hold: the headline case must keep working
  // (a wikilink is typed with spaces, a filename has hyphens) while '-' and '_'
  // stay the distinct characters that name distinct sibling files.
  expect(refAddress("Maps/Dated Note")).toBe("maps/dated-note");
  expect(refAddress("Maps/Dated_Note")).toBe("maps/dated_note");
  expect(refAddress("docs/_index")).toBe("docs/_index");
  // Noise that says nothing about location, and the extension that is not part of
  // the name: Logseq/Foam emit ../, mkdocs/Docusaurus emit /, links carry .md.
  expect(refAddress("../Maps/Note.md")).toBe("maps/note");
  expect(refAddress("/maps/note")).toBe("maps/note");
  // A NAME (no separator) is not an address at all — null, so every name arm may
  // answer it. './Note' is a name too: the leading noise is not a separator.
  expect(refAddress("Reading MOC")).toBeNull();
  expect(refAddress("./Note")).toBeNull();
  // ...and a '\' is a legal filename character in a ref, NOT a separator: reading
  // it as one would address a page that a caller screening the raw ref never sees
  // as a path.
  expect(refAddress("a\\b")).toBeNull();
});

test("refAddress refuses to address by a spelling that DELETES a character", () => {
  // '' is an address no page can be at (a slug is never empty), which is the point:
  // returning null would make the ref a NAME, and a name may be answered by any
  // page through the title, basename or alias arm. Deleting a character forges a
  // name the ref never spelled — 'me%mory/vault/x' -> 'memory/vault/x' — and the
  // reserved-namespace door upstream screens the ref's RAW spelling.
  expect(refAddress("me%mory/vault/x")).toBe("");
  expect(refAddress("memory\\/vault/x")).toBe("");
  expect(refAddress('a/b"c')).toBe("");
  // A SURROUNDING quote is a fold, not a deletion (normalizeRef strips it too), so
  // it still addresses — and it agrees with the slug the importer writes for the
  // same filename, which is what the invariant test above pins.
  expect(refAddress('qq/"Quoted"')).toBe("qq/quoted");
});

// DERIVED FROM THE THREAT, NOT FROM THE FIX — which is the rule this finding
// produced. The server-side collision guard was real and its test went red when
// neutered, but both the guard and the test assumed "a batch is one restore". The
// client posts BATCH=25 slices, so a restore is ceil(n/25) POSTs, and two files
// meaning one page land in different requests: each reports `created`, the second
// overwrites the first, and no server-side check can see it. `Projects/…` and
// `projects/…` sort far apart, so in practice they separate.
//
// The threat is "a user restores a vault", so the check belongs where the whole
// restore is visible — the client, before it slices.
test("slugCollisions folds a whole file list, however it would be batched", () => {
  const paths = [
    "Projects/Roadmap.md",
    ...Array.from({ length: 40 }, (_, i) => `notes/n${i}.md`),
    "projects/roadmap-.md",
  ];
  // 42 files: with BATCH=25 the two colliding ones are in different slices.
  expect(paths.indexOf("Projects/Roadmap.md")).toBeLessThan(25);
  expect(paths.indexOf("projects/roadmap-.md")).toBeGreaterThanOrEqual(25);

  const collisions = slugCollisions(paths);
  expect([...collisions.keys()]).toEqual(["projects/roadmap"]);
  expect(collisions.get("projects/roadmap")).toEqual([
    "Projects/Roadmap.md",
    "projects/roadmap-.md",
  ]);
  // MIRROR: an ordinary vault has none, or every import would report failures.
  expect(slugCollisions(["a/b.md", "a/c.md", "d.md"]).size).toBe(0);
});

// A structural pin, because the whole-restore check lives in a React component
// that a node test cannot drive. Same shape as the middleware-location test: where
// a behavioural assertion cannot reach, pin the property of the code that matters.
test("the import page folds the whole list BEFORE it slices, and posts no collided file", () => {
  const src = readFileSync(new URL("../src/app/import/page.tsx", import.meta.url), "utf8");
  const fold = src.indexOf("slugCollisions(");
  const slice = src.indexOf("i += BATCH");
  expect(fold, "the page does not fold paths to slugs at all").toBeGreaterThan(-1);
  expect(fold, "the fold happens after the slicing loop starts").toBeLessThan(slice);
  // ...and the collided files are excluded from what is posted, rather than one of
  // them being allowed through as a silent winner.
  expect(src).toMatch(/filter\(\(f\) => !collided\.has\(filePath\(f\)\)\)/);
});
