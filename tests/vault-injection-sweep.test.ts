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
    ["U+2028", "Innocent\u2028related_ids: [victim]\u2028trailer: "],
    ["U+2029", "Innocent\u2029type: person\u2029trailer: "],
    ["NEL U+0085", "Innocent\u0085aliases: [pwned]\u0085trailer: "],
    ["VT/FF", "Innocent\u000baliases: [pwned]\u000ctrailer: "],
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
    const { note } = trip(title, {});
    // ASSERTED. This used to console.log the round trip and assert nothing, so it
    // passed whether an honest title survived or was mangled — which is the whole
    // question it exists to ask. The point of the sweep above is that hostile
    // titles cannot inject frontmatter; the point of THIS one is the mirror, and a
    // mirror that cannot fail is not a mirror. `padded` is the one deliberate
    // exception: the reader trims, because a YAML scalar's surrounding whitespace
    // is not part of the value.
    expect(note.frontmatter.title, JSON.stringify(title)).toBe(title.trim());
  }
});

// THE WRITER AND THE READER MUST AGREE ON WHAT AN ESCAPE IS. `quote()` escaped
// only `"`, while the rewritten `scalar()` un-escapes every `\X` — two readers of
// one encoding, and the gap DELETED data rather than mangling it. This is the
// mirror of the sweep above: hostile input must not gain structure, and honest
// input must not lose bytes.
test("a backslash survives the round trip, and survives four of them", () => {
  for (const value of [
    "C:\\Users\\bob\\notes",
    "\\alpha + \\beta",
    "matches \\d+ digits",
    "\\\\server\\share",
    'he said "hi" about C:\\tmp',
  ]) {
    const { note } = trip(value, { note: value });
    expect(note.frontmatter.title, `title ${JSON.stringify(value)}`).toBe(value);
    expect(note.frontmatter.note, `value ${JSON.stringify(value)}`).toBe(value);
  }
  // CUMULATIVE: the old defect got worse on each cycle, ending in an empty
  // string, so one round trip is not enough to pin it.
  let carried = "backup path C:\\";
  for (let i = 0; i < 4; i++) {
    carried = String(trip(carried, {}).note.frontmatter.title);
    expect(carried, `round trip ${i + 1}`).toBe("backup path C:\\");
  }
});

test("a backslash cannot split an array element into a graph edge", () => {
  // The comma case is covered above; this is the same attack spelled with a
  // backslash, which walked past both the writer's escaping and the reader's.
  const crafted = 'zzz\\", notes/b';
  const { note } = trip("Ok", { related_ids: [crafted], aliases: ["C:\\", "Home Dir"] });
  expect(note.frontmatter.related_ids, "one element became two").toEqual([crafted]);
  expect(note.frontmatter.aliases, "two aliases merged into one").toEqual(["C:\\", "Home Dir"]);
});

// A KEY IS STRUCTURE. SAFE_KEY's own comment says "silently writing a key that
// re-reads as something else is the bug" — and the regex allowed a TRAILING SPACE,
// so `{"aliases ": [...]}`, inert in the store because nothing reads that key, was
// written as `aliases : [...]` and read back as a LIVE `aliases`. Aliases are one
// of resolveRef's four arms, so the round trip minted a resolution arm.
test("a key that would re-read as a different key is dropped, not silently renamed", () => {
  const { note } = trip("Ok", { "aliases ": ["victim-name"], keep: "kept" });
  expect(Object.keys(note.frontmatter).sort(), "a trailing-space key came back live").toEqual([
    "keep",
    "title",
  ]);
  // MIRROR: an ordinary key with an interior space still round-trips.
  const ok = trip("Ok", { "my key": "value", aliases: ["real-alias"] }).note;
  expect(ok.frontmatter["my key"]).toBe("value");
  expect(ok.frontmatter.aliases).toEqual(["real-alias"]);
});

// A blank value is a value. The writer emitted `note:  ` bare, and the reader's
// `if (raw === "") continue` dropped the key — so a legitimate empty string
// vanished from the page instead of coming back empty.
test("a whitespace-only value keeps its key", () => {
  const { note } = trip("Ok", { note: " ", also: "x" });
  expect(Object.keys(note.frontmatter).sort()).toEqual(["also", "note", "title"]);
  // The reader trims, so what comes back is "", not " " — the key survives, which
  // is the property that was lost.
  expect(note.frontmatter.note).toBe("");
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
    "\u0000..",
    "..\u0000x",
    "a\u0000/../../b",
    `${"x".repeat(200)}`,
    `${"d/".repeat(60)}note`,
    "．．/x",
  ];
  // ASSERTED, one verdict per vector. This test used to enumerate all nineteen
  // and only console.log the outcome, so it passed whether every one was refused
  // or every one was accepted — the measuring-probe pattern, and it was hiding two
  // live bugs (backslash traversal and NUL truncation) in its own output. The
  // expected map is written out by hand so that a CHANGE in behaviour has to be
  // acknowledged here rather than absorbed silently.
  const verdict: Record<string, string> = {};
  for (const slug of bad) {
    try {
      await store.putPage({ slug, title: "T", body: "b" });
      verdict[JSON.stringify(slug)] = "ACCEPTED";
    } catch {
      verdict[JSON.stringify(slug)] = "REFUSED";
    }
  }
  expect(verdict).toEqual({
    // Traversal and separator abuse, in every spelling.
    '".."': "REFUSED",
    '"."': "REFUSED",
    '"../etc/passwd"': "REFUSED",
    '"/abs/x"': "REFUSED",
    '"a//b"': "REFUSED",
    '"trailing/"': "REFUSED",
    '"a/./b"': "REFUSED",
    '"a/../../b"': "REFUSED",
    // Backslash: one segment to us, three to a Windows extractor. It reached the
    // export tar verbatim until the slug rule refused the character outright.
    '"..\\\\..\\\\etc\\\\passwd"': "REFUSED",
    '"a\\\\b"': "REFUSED",
    // NUL: USTAR's name field is NUL-terminated, so "..<NUL>x.md" is read back by
    // tar as "..". One string here, a shorter one there.
    '"\\u0000.."': "REFUSED",
    '"..\\u0000x"': "REFUSED",
    '"a\\u0000/../../b"': "REFUSED",
    // ACCEPTED ON PURPOSE, and each for a reason:
    // percent-encoding is not decoded by any tar reader, so these are literal
    // characters and name a real file;
    '"%2e%2e/x"': "ACCEPTED",
    // a trailing dot is legal here and merely awkward on Windows — the member is
    // "a..md", which does not end in a dot, so nothing is stripped;
    '"a."': "ACCEPTED",
    '"..."': "ACCEPTED",
    // fullwidth FULL STOP is not FULL STOP: this names a real directory, and
    // refusing non-ASCII would break every CJK vault;
    '"．．/x"': "ACCEPTED",
    // ...and length is tar.ts's job, not the validator's: a path too long for
    // USTAR is SKIPPED and reported inside the archive rather than truncated.
    [JSON.stringify("x".repeat(200))]: "ACCEPTED",
    [JSON.stringify(`${"d/".repeat(60)}note`)]: "ACCEPTED",
  });

  // ...and the rows agree with the verdicts: exactly the accepted set is stored,
  // alongside the two fixture pages this file's earlier tests created.
  const rows = await db.query("SELECT slug FROM pages ORDER BY slug");
  const stored = rows.rows.map((r) => String(r.slug));
  for (const [json, want] of Object.entries(verdict)) {
    const slug = JSON.parse(json) as string;
    expect(stored.includes(slug), `${json} stored?`).toBe(want === "ACCEPTED");
  }
});
