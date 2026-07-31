import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { type Store, createStore } from "../src/server/store.js";
import { serializeNote, splitPath, tarStream } from "../src/server/tar.js";
import { isMarkdown, parseFrontmatter, parseNote, pathToSlug } from "../src/server/vault.js";

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
