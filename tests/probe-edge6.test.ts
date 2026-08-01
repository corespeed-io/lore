// ADVERSARIAL PROBE — round 6, HTTP edge + credential screen. Deleted before the
// report is filed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { type Store, createStore } from "../src/server/store.js";
import { type TarEntry, serializeNote, tarStream, withSkipReport } from "../src/server/tar.js";
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

async function freshStore(): Promise<{ close: () => Promise<void>; store: Store; db: Db }> {
  const lite = new PGlite({ extensions: { vector, pg_trgm } });
  const d = pgliteDb(lite);
  await initSchema(d, { embeddingModel: "fake", embeddingDim: DIM });
  return { close: () => lite.close(), store: createStore(d, embed), db: d };
}

function trip(title: string, fm: Record<string, unknown>, body = "body") {
  const text = serializeNote(title, fm, body);
  return { text, note: parseNote({ path: "notes/probe.md", text }) };
}

// ============================================================================
// ITEM 5 — serializeNote -> parseNote round trip
// ============================================================================

test("P5a: an honest value containing a backslash does not survive a round trip", () => {
  const cases: [string, string][] = [
    ["windows path", "C:\\Users\\bob\\notes"],
    ["latex", "\\alpha + \\beta"],
    ["regex note", "matches \\d+ digits"],
    ["unc", "\\\\server\\share"],
  ];
  const observed: Record<string, string> = {};
  for (const [name, title] of cases) {
    const { note } = trip(title, {});
    observed[name] = String(note.frontmatter.title);
  }
  console.log("P5a title round trip:", JSON.stringify(observed, null, 1));
  for (const [name, title] of cases) {
    expect(observed[name], `title/${name} changed across one round trip`).toBe(title);
  }
});

test("P5b: a value ending in a backslash grows on EVERY round trip (cumulative)", () => {
  let v = "backup path C:\\";
  const seen = [v];
  for (let i = 0; i < 4; i++) {
    const { note } = trip("Ok", { note: v });
    v = String(note.frontmatter.note);
    seen.push(v);
  }
  console.log("P5b successive round trips:", JSON.stringify(seen, null, 1));
  expect(seen[1], "round trip 1 changed the value").toBe(seen[0]);
  expect(seen[2], "round trip 2 changed it AGAIN (cumulative corruption)").toBe(seen[1]);
});

test("P5c: a crafted array element SPLITS into two across a round trip", () => {
  // ONE alias, containing a backslash before a quote. The writer escapes only `"`;
  // the reader un-escapes every `\X`, so the escape that protected the quote is
  // itself eaten and the quote closes the element early.
  const { text, note } = trip("Ok", { aliases: ['zzz\\", victim-name'] });
  console.log("P5c serialized:", JSON.stringify(text));
  console.log("P5c parsed aliases:", JSON.stringify(note.frontmatter.aliases));
  expect(note.frontmatter.aliases, "one crafted alias became two").toEqual([
    'zzz\\", victim-name',
  ]);
});

test("P5d: the same trick MINTS A GRAPH EDGE through related_ids", async () => {
  const src = await freshStore();
  const dest = await freshStore();
  try {
    await src.store.putPage({ slug: "notes/b", title: "Bee", body: "target page" });
    await src.store.putPage({
      slug: "notes/a",
      title: "Ay",
      body: "no links here",
      frontmatter: { related_ids: ['zzz\\", notes/b'] },
    });
    const before = await src.store.getBacklinks({ slug: "notes/b" });
    for (const page of await src.store.exportBatch({ limit: 500 })) {
      const text = serializeNote(page.title, page.frontmatter, page.body);
      if (page.slug === "notes/a") console.log("P5d exported notes/a:\n", JSON.stringify(text));
      const note = parseNote({ path: `${page.slug}.md`, text });
      await dest.store.putPage({
        slug: note.slug,
        title: note.title,
        body: note.body,
        frontmatter: note.frontmatter,
      });
    }
    const after = await dest.store.getBacklinks({ slug: "notes/b" });
    const round = await dest.store.getPage({ slug: "notes/a" });
    console.log(
      "P5d before:",
      JSON.stringify(before),
      "after:",
      JSON.stringify(after),
      "related_ids:",
      JSON.stringify((round.frontmatter as Record<string, unknown>).related_ids),
    );
    expect(after.map((r) => r.slug).sort(), "a graph edge appeared out of a round trip").toEqual(
      before.map((r) => r.slug).sort(),
    );
  } finally {
    await src.close();
    await dest.close();
  }
});

test("P5e: honest sibling elements MERGE when one ends in a backslash", () => {
  const { note } = trip("Ok", { aliases: ["C:\\", "Home Dir"] });
  console.log("P5e aliases:", JSON.stringify(note.frontmatter.aliases));
  expect(note.frontmatter.aliases).toEqual(["C:\\", "Home Dir"]);
});

test("P5f: a whitespace-only value loses its key entirely", () => {
  const { text, note } = trip("Ok", { note: " ", keep: "x" });
  console.log("P5f serialized:", JSON.stringify(text), "keys:", Object.keys(note.frontmatter));
  expect(Object.keys(note.frontmatter).sort()).toEqual(["keep", "note", "title"]);
});

test("P5g: a key with a trailing space becomes a LIVE key across a round trip", () => {
  // Inert in the store ("aliases " is not "aliases"), active after a round trip.
  const { text, note } = trip("Ok", { "aliases ": ["victim-name"] });
  console.log("P5g serialized:", JSON.stringify(text), "keys:", Object.keys(note.frontmatter));
  expect(Object.keys(note.frontmatter).includes("aliases"), "an alias key was minted").toBe(false);
});

// ============================================================================
// ITEM 4 — slug rules vs a real tar extractor
// ============================================================================

test("P4a: hostile-but-accepted slugs cannot escape a real tar extraction", async () => {
  const s = await freshStore();
  const candidates = [
    "%2e%2e/x",
    "a.",
    "...",
    "．．/x",
    "c:/windows/system32/evil",
    "~/.ssh/authorized_keys",
    "-rf",
    "a*b",
    'a"b',
    "a?b",
    "a<b>c",
    "con",
    "nul",
    "com1",
    "a\u200bb", // zero-width space
    "a\u202eevil", // RTL override
    "a\u0085b", // NEL: a C1 control that hasControlChar (c<0x20||0x7f) misses
    "a\u00ade", // soft hyphen
    "\u0301combining",
    "x".repeat(200),
    `${"d/".repeat(60)}note`,
  ];
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const slug of candidates) {
    try {
      await s.store.putPage({ slug, title: "T", body: "b" });
      accepted.push(slug);
    } catch {
      refused.push(slug);
    }
  }
  console.log("P4a accepted:", JSON.stringify(accepted));
  console.log("P4a refused:", JSON.stringify(refused));

  const skipped: string[] = [];
  async function* entries(): AsyncGenerator<TarEntry> {
    for (const page of await s.store.exportBatch({ limit: 500 })) {
      yield { path: `${page.slug}.md`, body: serializeNote(page.title, page.frontmatter, page.body) };
    }
  }
  const stream = tarStream(withSkipReport(entries(), skipped), 1_700_000_000, (p) =>
    skipped.push(p),
  );
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await s.close();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  const root = mkdtempSync(join(tmpdir(), "probe-tar-"));
  const out = join(root, "out");
  const archive = join(root, "brain.tar");
  writeFileSync(archive, buf);
  execFileSync("mkdir", ["-p", out]);
  const listing = execFileSync("tar", ["-tf", archive], { encoding: "utf8" });
  console.log("P4a tar listing:\n", listing);
  const extract = execFileSync("tar", ["-xf", archive, "-C", out], { encoding: "utf8" });
  console.log("P4a extract stderr/stdout:", JSON.stringify(extract));
  const inside = execFileSync("find", [out, "-type", "f"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  console.log("P4a extracted files:\n", inside.join("\n"));
  const strays = execFileSync("find", [root, "-type", "f"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((p) => p !== archive && !p.startsWith(`${out}/`));
  console.log("P4a skipped:", JSON.stringify(skipped), "strays:", JSON.stringify(strays));
  expect(strays, "a member landed outside the extraction directory").toEqual([]);
  // Every accepted page must come back out: a slug we accept and then cannot
  // export is a page the owner cannot retrieve.
  const got = new Set(inside.map((p) => p.slice(out.length + 1)));
  const missing = accepted.map((sl) => `${sl}.md`).filter((n) => !got.has(n));
  console.log("P4a missing from the archive:", JSON.stringify(missing));
  expect(missing.filter((n) => !skipped.includes(n))).toEqual([]);
});
