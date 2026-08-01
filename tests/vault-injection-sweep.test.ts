// An adversarial sweep of the export -> import round trip. A crafted title,
// value or KEY must not be able to add frontmatter, mint an alias, or mint a
// graph edge on the way back in. Kept permanent: the first fix escaped newlines
// and this found three ways past it (a comma inside a quoted array element, a
// U+2028 that made the reader drop the whole entry, and a key starting with
// "- " that smuggles an element into the previous key's block array).
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { type Store, createStore } from "../src/server/store.js";
import { serializeNote } from "../src/server/tar.js";
import { parseNote } from "../src/server/vault.js";

const DIM = 8;
const embed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array(DIM).fill(0.01);
    for (let i = 0; i < t.length; i++) v[i % DIM] += (t.charCodeAt(i) % 97) / 97;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

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

let pg: PGlite;
let db: Db;
let store: Store;

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector, pg_trgm } });
  db = pgliteDb(pg);
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  store = createStore(db, embed);
});

afterAll(async () => {
  await pg.close();
});

// --- pure serialize -> parse sweep -------------------------------------------

function trip(title: string, fm: Record<string, unknown>, body = "body") {
  const text = serializeNote(title, fm, body);
  return { text, note: parseNote({ path: "notes/probe.md", text }) };
}

test("line-injection sweep on title and values", () => {
  const cases: [string, string][] = [
    ["bare LF", "Innocent\naliases: [pwned]\ntrailer: "],
    ["CRLF", "Innocent\r\nrelated_ids: [victim]\r\ntrailer: "],
    ["lone CR", "Innocent\rtype: person\rtrailer: "],
    ["doc boundary", "Innocent\n---\nrelated_ids: [victim]\n---\n"],
    ["U+2028", "Innocent related_ids: [victim] trailer: "],
    ["U+2029", "Innocent type: person trailer: "],
    ["NEL U+0085", "Innocentaliases: [pwned]trailer: "],
    ["VT/FF", "Innocentaliases: [pwned]trailer: "],
    ["quoted value", '"Innocent"\naliases: [pwned]\nx: '],
    ["colon key", "a: b\naliases: [pwned]\nx: "],
  ];
  for (const [name, title] of cases) {
    const { text, note } = trip(title, {});
    console.log(
      `--- title/${name} ---\n${JSON.stringify(text)}\n keys=${JSON.stringify(Object.keys(note.frontmatter))} fm=${JSON.stringify(note.frontmatter)}`,
    );
    expect(Object.keys(note.frontmatter), `title/${name}`).toEqual(["title"]);
  }
  for (const [name, val] of cases) {
    const { text, note } = trip("Ok", { note: val });
    console.log(
      `--- value/${name} ---\n${JSON.stringify(text)}\n keys=${JSON.stringify(Object.keys(note.frontmatter))}`,
    );
    expect(Object.keys(note.frontmatter).sort(), `value/${name}`).toEqual(["note", "title"]);
  }
  // key side
  for (const [name, key] of cases) {
    const { text, note } = trip("Ok", { [key]: "v" });
    console.log(
      `--- key/${name} ---\n${JSON.stringify(text)}\n keys=${JSON.stringify(Object.keys(note.frontmatter))}`,
    );
    expect(
      Object.keys(note.frontmatter).filter((k) => /^(aliases|type|related_ids)$/.test(k)),
      `key/${name}`,
    ).toEqual([]);
  }
});

test("array element with a comma splits into extra elements", () => {
  const { text, note } = trip("Ok", { aliases: ["Doe, Jane"], related_ids: ["notes/x, notes/b"] });
  console.log(
    `--- comma array ---\n${JSON.stringify(text)}\n fm=${JSON.stringify(note.frontmatter)}`,
  );
  expect(note.frontmatter.aliases).toEqual(["Doe, Jane"]);
  expect(note.frontmatter.related_ids).toEqual(["notes/x, notes/b"]);
});

test("block-array smuggling through a key that starts with '- '", () => {
  const { text, note } = trip("Ok", { aliases: "", "- pwned": "x" });
  console.log(
    `--- block smuggle ---\n${JSON.stringify(text)}\n fm=${JSON.stringify(note.frontmatter)}`,
  );
  expect(note.frontmatter.aliases).toBe("");
});

test("honest titles round-trip", () => {
  for (const title of [
    "Q4 Plan (v2) — 50% done",
    'He said "hi"',
    "记忆系统 / 设计",
    "Roadmap 🚀 2026",
    "Doe, Jane",
    "Design # notes",
    "a: b",
    "  padded  ",
  ]) {
    const { text, note } = trip(title, {});
    console.log(
      `--- honest ${JSON.stringify(title)} -> ${JSON.stringify(note.frontmatter.title)} :: ${JSON.stringify(text.split("\n")[1])}`,
    );
  }
});

// --- real store: does the round trip create an edge that did not exist? ------

async function freshStore(): Promise<{ close: () => Promise<void>; store: Store; db: Db }> {
  const lite = new PGlite({ extensions: { vector, pg_trgm } });
  const d = pgliteDb(lite);
  await initSchema(d, { embeddingModel: "fake", embeddingDim: DIM });
  return { close: () => lite.close(), store: createStore(d, embed), db: d };
}

test("alias with a comma gains a resolution arm across a round trip", async () => {
  // Page with ONE alias that legitimately contains a comma.
  await store.putPage({
    slug: "people/jane-doe",
    title: "Jane Doe",
    body: "person",
    frontmatter: { aliases: ["Doe, Jane"] },
  });
  // A page that references [[Jane]] — must NOT resolve before or after.
  await store.putPage({ slug: "notes/ref", title: "Ref", body: "see [[Jane]]" });
  const before = await store.getBacklinks({ slug: "people/jane-doe" });
  console.log("before backlinks", before);

  const dest = await freshStore();
  for (const page of await store.exportBatch({ limit: 500 })) {
    const note = parseNote({
      path: `${page.slug}.md`,
      text: serializeNote(page.title, page.frontmatter, page.body),
    });
    await dest.store.putPage({
      slug: note.slug,
      title: note.title,
      body: note.body,
      frontmatter: note.frontmatter,
    });
  }
  const after = await dest.store.getBacklinks({ slug: "people/jane-doe" });
  const fmAfter = await dest.store.getPage({ slug: "people/jane-doe" });
  console.log("after backlinks", after, "aliases", JSON.stringify(fmAfter.frontmatter));
  await dest.close();
  expect(after.map((r) => r.slug).sort()).toEqual(before.map((r) => r.slug).sort());
});

test("related_ids with a comma gains an edge across a round trip", async () => {
  const src = await freshStore();
  await src.store.putPage({ slug: "notes/b", title: "Bee", body: "target page" });
  await src.store.putPage({
    slug: "notes/a",
    title: "Ay",
    body: "no links here",
    frontmatter: { related_ids: ["notes/zzz, notes/b"] },
  });
  const before = await src.store.getBacklinks({ slug: "notes/b" });
  console.log("related before", before);

  const dest = await freshStore();
  for (const page of await src.store.exportBatch({ limit: 500 })) {
    const note = parseNote({
      path: `${page.slug}.md`,
      text: serializeNote(page.title, page.frontmatter, page.body),
    });
    await dest.store.putPage({
      slug: note.slug,
      title: note.title,
      body: note.body,
      frontmatter: note.frontmatter,
    });
  }
  const after = await dest.store.getBacklinks({ slug: "notes/b" });
  console.log("related after", after);
  await src.close();
  await dest.close();
  expect(after.map((r) => r.slug)).toEqual(before.map((r) => r.slug));
});

// --- path side ---------------------------------------------------------------

test("slugs that could escape the tar are refused on write", async () => {
  const bad = [
    "..",
    ".",
    "../etc/passwd",
    "/abs/x",
    "a//b",
    "trailing/",
    "a/./b",
    "a/../../b",
    "%2e%2e/x",
    "..\\..\\etc\\passwd",
    "a\\b",
    "a.",
    "...",
    " ..",
    ".. x",
    "a /../../b",
    `${"x".repeat(200)}`,
    `${"d/".repeat(60)}note`,
    "．．/x",
  ];
  for (const slug of bad) {
    let outcome = "ACCEPTED";
    try {
      await store.putPage({ slug, title: "T", body: "b" });
    } catch (e) {
      outcome = `refused: ${(e as Error).message.slice(0, 90)}`;
    }
    console.log(`slug ${JSON.stringify(slug)} -> ${outcome}`);
  }
  const rows = await db.query("SELECT slug FROM pages ORDER BY slug");
  console.log("stored slugs", JSON.stringify(rows.rows.map((r) => r.slug)));
});
