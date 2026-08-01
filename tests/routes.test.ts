import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterEach, expect, test, vi } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import { handleRpc } from "../src/server/mcp.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { type Store, createStore } from "../src/server/store.js";

// The brain /api/import writes into, when a test arms one. getBrainCtx is the one
// function the route asks for a context, so mocking it here is the whole seam —
// the route still crosses handleRpc, put_page and the real store.
const brain = vi.hoisted(() => ({
  ctx: null as { store: unknown; db: unknown } | null,
}));

vi.mock("../src/server/local.js", () => ({
  getBrainCtx: async () => {
    if (!brain.ctx) throw new Error("this test did not arm a brain");
    return brain.ctx;
  },
  getStore: async () => {
    if (!brain.ctx) throw new Error("this test did not arm a brain");
    return brain.ctx.store;
  },
  getDb: async () => {
    if (!brain.ctx) throw new Error("this test did not arm a brain");
    return brain.ctx.db;
  },
}));

vi.mock("../src/lib/gbrain.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/gbrain.js")>();
  return {
    ...real,
    callTool: vi.fn(async (tool: string) => {
      if (!real.READ_ONLY_TOOLS.has(tool)) throw new real.ToolNotAllowedError("nope");
      return { isError: false, text: "[]" };
    }),
  };
});

test("POST /api/call rejects a write tool with 403", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const res = await POST(
    new Request("http://x/api/call", {
      method: "POST",
      body: JSON.stringify({ tool: "put_page", args: {} }),
    }),
  );
  expect(res.status).toBe(403);
});

test("POST /api/call passes a read tool", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const res = await POST(
    new Request("http://x/api/call", {
      method: "POST",
      body: JSON.stringify({ tool: "list_pages", args: {} }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ isError: false, text: "[]" });
});

test("GET /api/health is ok", async () => {
  const { GET } = await import("../src/app/api/health/route.js");
  const res = await GET();
  expect((await res.json()).status).toBe("ok");
});

test("GET /api/graph maps a failed build to 502 and a healthy build to 200", async () => {
  const { clearGraphCache } = await import("../src/lib/graph.js");
  const { GET } = await import("../src/app/api/graph/route.js");
  const gbrain = await import("../src/lib/gbrain.js");
  const mocked = vi.mocked(gbrain.callTool);
  const base = mocked.getMockImplementation();
  if (!base) throw new Error("callTool mock missing");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  clearGraphCache();
  mocked.mockImplementation(async () => {
    throw new Error("gbrain down");
  });
  try {
    const bad = await GET();
    expect(bad.status).toBe(502);
    expect((await bad.json()).detail).toBe("couldn't reach the brain");
  } finally {
    mocked.mockImplementation(base);
    error.mockRestore();
    clearGraphCache();
  }
  const ok = await GET();
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.nodes).toEqual([]);
  expect(body.links).toEqual([]);
  clearGraphCache();
});

test("POST /api/call clamps an oversized limit before reaching gbrain", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const gbrain = await import("../src/lib/gbrain.js");
  await POST(
    new Request("http://x/api/call", {
      method: "POST",
      body: JSON.stringify({ tool: "list_pages", args: { limit: 1_000_000 } }),
    }),
  );
  // MAX is 200 — hand-known from the route, not computed by the code under test.
  // biome-ignore lint/suspicious/noExplicitAny: reaching into the vi mock
  const lastArgs = (gbrain.callTool as any).mock.calls.at(-1)[1];
  expect(lastArgs.limit).toBe(200);
});

test("POST /api/call rejects a missing/non-string tool with 400", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const res = await POST(
    new Request("http://x/api/call", { method: "POST", body: JSON.stringify({ args: {} }) }),
  );
  expect(res.status).toBe(400);
});

test("POST /api/call rejects an unparseable body with 400", async () => {
  const { POST } = await import("../src/app/api/call/route.js");
  const res = await POST(new Request("http://x/api/call", { method: "POST", body: "not json" }));
  expect(res.status).toBe(400);
});

// The bearer-authed brain routes. Middleware exempts these from the viewer gate,
// so the bearer check inside each route is the ONLY thing standing in front of a
// write — /api/mcp has tests/brain-route.test.ts, these three had nothing.
const WRITE = "write-token-0123456789";
const READ = "read-token-01234567890";
const savedEnv = ["DATABASE_URL", "BRAIN_WRITE_TOKEN", "BRAIN_READ_TOKEN"].map(
  (k) => [k, process.env[k]] as const,
);

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

function armBrain() {
  // NOT `= undefined` — Node coerces that to the string "undefined" (truthy),
  // and the routes would try to open a database. Unconfigured is what makes a
  // 404 the proof that a request got PAST the bearer gate.
  Reflect.deleteProperty(process.env, "DATABASE_URL");
  process.env.BRAIN_WRITE_TOKEN = WRITE;
  process.env.BRAIN_READ_TOKEN = READ;
}

const bearer = (token?: string): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

test("POST /api/import fails closed and takes the write token only", async () => {
  armBrain();
  const { POST } = await import("../src/app/api/import/route.js");
  const post = (token?: string) =>
    POST(
      new Request("http://x/api/import", { method: "POST", headers: bearer(token), body: "{}" }),
    );

  const none = await post();
  expect(none.status).toBe(401);
  expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
  expect((await post("wrong-but-long-enough")).status).toBe(401);
  // Read is not enough: import writes.
  expect((await post(READ)).status).toBe(401);
  expect((await post(WRITE)).status).toBe(404);
});

test("POST /api/maintenance fails closed and takes the write token only", async () => {
  armBrain();
  const { POST } = await import("../src/app/api/maintenance/route.js");
  const post = (token?: string) =>
    POST(
      new Request("http://x/api/maintenance", {
        method: "POST",
        headers: bearer(token),
        body: "{}",
      }),
    );

  const none = await post();
  expect(none.status).toBe(401);
  expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
  expect((await post("wrong-but-long-enough")).status).toBe(401);
  // A read token must not be able to trigger a sweep — it writes auto edges.
  expect((await post(READ)).status).toBe(401);
  expect((await post(WRITE)).status).toBe(404);
});

// --- /api/import is the SAME door as the tool call ---------------------------
//
// It used to call store.putPage directly, so it crossed none of the dispatcher's
// rules: no credential screen, no refuseReserved. The refutation was one string
// posted twice — refused as tools/call put_page, created as POST /api/import, and
// then readable by a BRAIN_READ_TOKEN holder through get_page and search. These
// tests post exactly that string and assert the two doors now agree, against real
// SQL (PGlite = Postgres 17) so "the row is not there" is a fact about a database.

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

// Arms the bearer pair AND a real database, then installs it as the context the
// route's getBrainCtx hands back.
async function withImportBrain(
  fn: (ctx: { db: Db; store: Store }) => Promise<void>,
): Promise<void> {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  try {
    await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
    const ctx = { db, store: createStore(db, embed) };
    brain.ctx = ctx;
    process.env.DATABASE_URL = "postgres://unused/db";
    process.env.BRAIN_WRITE_TOKEN = WRITE;
    process.env.BRAIN_READ_TOKEN = READ;
    await fn(ctx);
  } finally {
    brain.ctx = null;
    await pg.close();
  }
}

interface ImportResult {
  path: string;
  slug?: string;
  status: string;
  pending?: string[];
  detail?: string;
}

async function importFiles(files: { path: string; text: string }[]): Promise<ImportResult[]> {
  const { POST } = await import("../src/app/api/import/route.js");
  const res = await POST(
    new Request("http://x/api/import", {
      method: "POST",
      headers: { ...bearer(WRITE), "content-type": "application/json" },
      body: JSON.stringify({ files }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: ImportResult[] }).results;
}

// Every text-ish column of every table, read out of information_schema rather
// than listed — the refutations all landed in a column nobody had thought of.
async function occurrencesOf(db: Db, needle: string): Promise<string[]> {
  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('text','character varying','character','jsonb','json')
     ORDER BY table_name, column_name`,
  );
  const hits: string[] = [];
  for (const r of cols.rows) {
    // Identifiers come from the catalog, never from a caller.
    const table = `"${String(r.table_name)}"`;
    const col = `"${String(r.column_name)}"`;
    const res = await db.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${col}::text LIKE '%' || $1 || '%'`,
      [needle],
    );
    if (Number(res.rows[0].n) > 0) hits.push(`${table}.${col}`);
  }
  return hits;
}

const AWS = "AKIAIOSFODNN7EXAMPLE";
// The reviewer's file, verbatim, as one string posted through both doors.
const RUNBOOK = [
  "# Deploy runbook",
  "",
  `The bot key is ${AWS} and the console password: hunter2swordfish`,
  "",
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

test("the same bytes are refused at BOTH doors, and no row holds them", async () => {
  await withImportBrain(async (ctx) => {
    // Door 1, the tool call — unchanged, and quoted here so the comparison is in
    // the test rather than in a comment.
    const tool = await handleRpc(() => Promise.resolve(ctx), "write", "tools/call", {
      name: "put_page",
      arguments: { slug: "ops/runbook", body: RUNBOOK },
    });
    expect(tool.result, "reached a handler").toBeUndefined();
    expect(tool.error?.code).toBe(-32602);
    expect(tool.error?.message).toMatch(/refused: request contains/);
    for (const kind of ["private_key", "aws_access_key", "labelled_credential"]) {
      expect(tool.error?.message, kind).toContain(kind);
    }

    // Door 2, the importer: the same string, which used to answer created.
    const [result] = await importFiles([{ path: "ops/runbook.md", text: RUNBOOK }]);
    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/refused: request contains/);
    // The refusal names the KIND and never the value: this text is handed back to
    // a client and a gate that echoes the credential is a second copy of it.
    expect(result.detail).not.toContain(AWS);

    // "Observed: pages and chunks hold it, embedded and FTS-indexed."
    const pages = await ctx.db.query("SELECT slug FROM pages");
    expect(pages.rows).toEqual([]);
    const chunks = await ctx.db.query("SELECT count(*)::int AS n FROM chunks");
    expect(Number(chunks.rows[0].n)).toBe(0);
    for (const secret of [AWS, "hunter2swordfish", "BEGIN RSA PRIVATE KEY"]) {
      expect(await occurrencesOf(ctx.db, secret), secret).toEqual([]);
    }

    // ...so the read-only bearer's first search finds nothing to find.
    const read = await handleRpc(() => Promise.resolve(ctx), "read", "tools/call", {
      name: "search",
      arguments: { query: "runbook deploy bot" },
    });
    expect((read.result as { content: { text: string }[] }).content[0].text).toBe("[]");
    const get = await handleRpc(() => Promise.resolve(ctx), "read", "tools/call", {
      name: "get_page",
      arguments: { slug: "ops/runbook" },
    });
    expect((get.result as { content: { text: string }[]; isError: boolean }).isError).toBe(true);
  });
});

test("/api/import crosses refuseReserved, in the slug AND in the body", async () => {
  await withImportBrain(async (ctx) => {
    const results = await importFiles([
      // The route used to check this itself, on its own spelling of the slug.
      { path: "memory/vault/squatter.md", text: "trying to squat" },
      // The half no route-local slug check could ever have caught: a REF into the
      // namespace, which put_page's own `pending` array would then have answered
      // an existence question about.
      {
        path: "notes/oracle.md",
        text: "see [[memory/vault/00000000-0000-4000-8000-000000000000]]",
      },
      // ...including the spellings the store folds to the same address.
      {
        path: "notes/oracle2.md",
        text: "see [[/memory/vault/00000000-0000-4000-8000-000000000000]]",
      },
      {
        path: "notes/oracle3.md",
        text: "see [[memory / vault / 00000000-0000-4000-8000-000000000000]]",
      },
    ]);
    for (const r of results) {
      expect(r.status, r.path).toBe("failed");
      expect(r.detail, r.path).toMatch(/reserved/);
    }
    // Nothing written by any of them — no page, and no parked ref to measure.
    expect((await ctx.db.query("SELECT slug FROM pages")).rows).toEqual([]);
    expect((await ctx.db.query("SELECT target_ref FROM pending_links")).rows).toEqual([]);
  });
});

// SELF-ATTACK. Three adjacent paths nobody handed me, all through the importer,
// because the importer derives its slug from a caller-supplied PATH — the one
// input the tool door does not have.
test("no crafted vault path reaches the reserved namespace", async () => {
  await withImportBrain(async (ctx) => {
    const id = "00000000-0000-4000-8000-000000000000";
    const results = await importFiles([
      // pathToSlug only strips ONE leading './' or '/', so these arrive at the door
      // with '..' and '' segments still in them — exactly the two shapes refForm
      // and the store's foldPath have to agree about.
      { path: `../../memory/vault/${id}.md`, text: "escape" },
      { path: `/memory/vault/${id}.md`, text: "root-relative" },
      { path: `./memory/vault/${id}.md`, text: "dot" },
      { path: `memory//vault/${id}.md`, text: "empty segment" },
      // pathToSlug lowercases, so case is not a way in either.
      { path: `Memory/Vault/${id.toUpperCase()}.md`, text: "case" },
      { path: `memory/vault/${id}.markdown`, text: "the other extension" },
    ]);
    for (const r of results) {
      expect(r.status, r.path).not.toBe("created");
      expect(r.status, r.path).not.toBe("unchanged");
      expect(r.detail, r.path).toMatch(/reserved|invalid slug/);
    }
    expect((await ctx.db.query("SELECT slug FROM pages")).rows).toEqual([]);
  });
});

// SELF-ATTACK 2, and it found something — so the assertion is PARITY rather than
// an outcome, because parity is the property this route owns and an outcome would
// pin whatever safety.ts happens to detect today.
//
// `---\napi_key: hunter2swordfish\n---` parses to frontmatter {api_key: '…'}, and
// findSecretsInPayload visits an object's KEY and its VALUE as separate strings
// (deliberately — "a credential hides in a key as easily as in a value") while
// safety.ts's labelled_credential pattern needs LABEL, separator and value in ONE
// string. So the pair is invisible to the screen, and it is invisible at the TOOL
// door too: put_page{frontmatter:{api_key:'hunter2swordfish'}} reaches the handler
// on main. That is a pre-existing hole in safety.ts's composition, not something
// this route can close — closing it here would be a SECOND detector, which is the
// mistake this whole round is about. Reported upward instead; the fix belongs in
// findSecretsInPayload, which should feed `${key}: ${value}` to the same
// findSecrets it already calls.
//
// What this test therefore holds: for the same bytes, the importer and the tool
// door reach the SAME verdict — including on the cases where both are blind — plus
// the two frontmatter attacks that DO fire, so it is not vacuous.
type Verdict = "refused" | "failed" | "written";

test("frontmatter reaches the same verdict at BOTH doors", async () => {
  await withImportBrain(async (ctx) => {
    const id = "00000000-0000-4000-8000-000000000000";
    const probes = [
      // Self-evidencing VALUES: the pattern matches without the label, so the screen
      // sees them wherever they sit. Proof frontmatter is walked at all.
      { path: "notes/tok.md", text: "---\ntoken: ghp_abcdefghijklmnopqrstuvwxyz012345\n---\n\nx" },
      { path: "notes/aws.md", text: "---\nk: AKIAIOSFODNN7EXAMPLE\n---\n\nx" },
      // An alias into the namespace would make every stale ref to a projection's
      // address resolve to this imported note; related_ids mints the edge directly.
      { path: "notes/alias.md", text: `---\naliases: [memory/vault/${id}]\n---\n\nmine now` },
      { path: "notes/related.md", text: `---\nrelated_ids: [/memory/vault/${id}]\n---\n\nmine` },
      // The label/value split described above. No outcome asserted — only parity.
      { path: "notes/api.md", text: "---\napi_key: hunter2swordfish\n---\n\nthe api note" },
      { path: "notes/plain.md", text: "---\ntype: note\n---\n\nnothing to see" },
    ];
    const { parseNote } = await import("../src/server/vault.js");
    for (const file of probes) {
      const [imported] = await importFiles([file]);
      const importVerdict: Verdict =
        imported.status === "skipped"
          ? "refused"
          : imported.status === "failed"
            ? "failed"
            : "written";
      const note = parseNote(file);
      const rpc = await handleRpc(() => Promise.resolve(ctx), "write", "tools/call", {
        name: "put_page",
        arguments: {
          slug: `tool/${note.slug}`,
          title: note.title,
          body: note.body,
          frontmatter: note.frontmatter,
        },
      });
      const toolVerdict: Verdict = rpc.error
        ? "refused"
        : (rpc.result as { isError: boolean }).isError
          ? "failed"
          : "written";
      expect(toolVerdict, file.path).toBe(importVerdict);
    }
    // Not vacuous: the four attacks that DO fire, fire.
    const [tok, aws, alias, related] = await importFiles(probes.slice(0, 4));
    expect(tok.detail).toMatch(/refused: request contains github_token/);
    expect(aws.detail).toMatch(/refused: request contains aws_access_key/);
    expect(alias.detail).toMatch(/reserved/);
    expect(related.detail).toMatch(/reserved/);
    for (const slug of ["notes/tok", "notes/aws", "notes/alias", "notes/related"]) {
      expect((await ctx.db.query("SELECT slug FROM pages WHERE slug = $1", [slug])).rows).toEqual(
        [],
      );
    }
    expect(await occurrencesOf(ctx.db, "AKIAIOSFODNN7EXAMPLE")).toEqual([]);
  });
});

test("a refused file does not take the rest of the batch with it", async () => {
  await withImportBrain(async (ctx) => {
    // Per-file refusal is the whole reason screening import is the right trade
    // rather than a choice between indexing a credential and refusing a vault.
    const results = await importFiles([
      { path: "notes/before.md", text: "# Before\n\nlinks to [[After]]" },
      { path: "ops/runbook.md", text: RUNBOOK },
      { path: "notes/after.md", text: "# After\n\nthe one that came after" },
    ]);
    expect(results.map((r) => r.status)).toEqual(["created", "skipped", "created"]);
    // ...and the survivors are COMPLETE: chunked (searchable) and linked, not
    // half-written by a loop that lost its place.
    const slugs = await ctx.db.query("SELECT slug FROM pages ORDER BY slug");
    expect(slugs.rows.map((r) => String(r.slug))).toEqual(["notes/after", "notes/before"]);
    const hits = await ctx.store.search({ query: "the one that came after" });
    expect(hits.map((h) => h.slug)).toContain("notes/after");
    const edges = await ctx.db.query("SELECT count(*)::int AS n FROM edges");
    expect(Number(edges.rows[0].n)).toBe(1);
    expect(await occurrencesOf(ctx.db, AWS)).toEqual([]);
  });
});

test("an honest vault still imports through the new door, and re-imports free", async () => {
  await withImportBrain(async (ctx) => {
    const files = [
      { path: "Projects/My Note.md", text: "# My Note\n\nlinks to [[Other]] and [[Nowhere]]" },
      { path: "Projects/Other.md", text: "# Other\n\nthe other one" },
      { path: "attachments/diagram.png", text: "not markdown" },
    ];
    const first = await importFiles(files);
    expect(first.map((r) => r.status)).toEqual(["created", "created", "skipped"]);
    expect(first[0].slug).toBe("projects/my-note");
    // pending is plumbed through the dispatcher's JSON envelope, not lost in it:
    // the graph-health report on the import page is built from it. [[Other]] is
    // parked here because a vault imports in directory order and Other.md is the
    // NEXT file — the forward reference the store lands on the following write.
    expect(first[0].pending).toEqual(["Other", "Nowhere"]);
    expect(first[2].detail).toBe("not markdown");

    // The edge the wikilink minted is real, so the write went all the way through.
    const edges = await ctx.db.query(
      `SELECT pf.slug AS from_slug, pt.slug AS to_slug FROM edges e
       JOIN pages pf ON pf.id = e.from_page_id JOIN pages pt ON pt.id = e.to_page_id`,
    );
    expect(edges.rows.map((r) => `${r.from_slug}->${r.to_slug}`)).toEqual([
      "projects/my-note->projects/other",
    ]);
    expect((await ctx.store.getPage({ slug: "projects/other" })).title).toBe("Other");

    const second = await importFiles(files);
    expect(second.map((r) => r.status)).toEqual(["unchanged", "unchanged", "skipped"]);
    expect(second[0].pending).toEqual(["Nowhere"]);
  });
});

test("GET /api/export fails closed and takes the WRITE token only", async () => {
  // Changed deliberately from "accepts either token": export streams
  // exportBatch straight out and never passes the MCP dispatcher, so it is the
  // one door that bypasses the filter keeping thread- and agent-scoped memory
  // projections off the shared agent surface. Leaving it on the read token
  // would hand every agent that door. 404 here is "standalone brain not
  // configured", i.e. auth already passed.
  armBrain();
  const { GET } = await import("../src/app/api/export/route.js");
  const get = (token?: string) =>
    GET(new Request("http://x/api/export", { headers: bearer(token) }));

  const none = await get();
  expect(none.status).toBe(401);
  expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
  expect((await get("wrong-but-long-enough")).status).toBe(401);
  expect((await get(READ)).status).toBe(401);
  expect((await get(WRITE)).status).toBe(404);
});
