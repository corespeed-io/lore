import { afterEach, expect, test, vi } from "vitest";
import { buildGraph, clearGraphCache, isHashTitle, nodeType } from "../src/lib/graph.js";
import { callTool } from "../src/lib/tools.js";

// Stub the tool door so buildGraph reads a fixed fixture instead of a live brain.
// `query` seeds the page set (titles/types); `traverse_graph` (direction=both,
// deep) returns every edge in the slug's reachable neighborhood — incoming +
// outgoing — in one call (shape: {from_slug, to_slug}), which is what the
// build relies on.
vi.mock("../src/lib/tools.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/tools.js")>();
  const SEEDS = [
    { slug: "companies/acme", title: "Acme", type: "company" },
    { slug: "people/ada", title: "Ada Lovelace", type: "person" },
    // a seed with no edges either way → now remains as an isolated graph node
    { slug: "concepts/orphan", title: "Orphan", type: "concept" },
  ];
  const PAGES = [
    ...SEEDS,
    { slug: "extracts/receipt", title: "Receipt", type: "extract_receipt" },
    { slug: "tech/hash-import", title: "904b1d36", type: "concept" },
  ];
  // The full edge set; traverse_graph(both) returns the rows incident to a slug.
  const EDGES: { from_slug: string; to_slug: string }[] = [
    // a `mentions`/typed edge the old chunk-text scan would have missed
    { from_slug: "companies/acme", to_slug: "people/ada" },
    // a target that was never itself a seed → pendant node, slug-derived label
    { from_slug: "companies/acme", to_slug: "entities/widget" },
    // hash-titled target → dropped even though it's linked
    { from_slug: "companies/acme", to_slug: "concepts/7416e83d" },
    // reciprocal edge → must dedupe to a single undirected link
    { from_slug: "people/ada", to_slug: "companies/acme" },
  ];
  return {
    ...real,
    callTool: vi.fn(async (tool: string, args: { slug?: string }) => {
      if (tool === "list_pages") return { isError: false, text: JSON.stringify(PAGES) };
      if (tool === "query") return { isError: false, text: JSON.stringify(SEEDS) };
      if (tool === "traverse_graph") {
        const s = args.slug ?? "";
        const incident = EDGES.filter((e) => e.from_slug === s || e.to_slug === s);
        return { isError: false, text: JSON.stringify(incident) };
      }
      return { isError: false, text: "[]" };
    }),
  };
});

// Every buildGraph test swaps the mock implementation and relies on the module
// cache being empty; restore both so test order can't leak state.
const baseImpl = () => {
  const base = vi.mocked(callTool).getMockImplementation();
  if (!base) throw new Error("callTool mock missing");
  return base;
};
afterEach(() => {
  clearGraphCache();
});

test("isHashTitle flags content-hash labels but not real titles", () => {
  expect(isHashTitle("7416e83d")).toBe(true);
  expect(isHashTitle("904b1d36")).toBe(true);
  expect(isHashTitle("CoreSpeed")).toBe(false);
  expect(isHashTitle("bytedance")).toBe(false);
  expect(isHashTitle("Haas Mcp Converged 0622")).toBe(false);
});

test("nodeType preserves backend type, then infers from slug prefix, then concept", () => {
  expect(nodeType("people/x", "founder")).toBe("founder");
  expect(nodeType("people/x")).toBe("person");
  expect(nodeType("companies/x")).toBe("company");
  expect(nodeType("entities/x")).toBe("product");
  expect(nodeType("gtm/x", "product")).toBe("product");
  expect(nodeType("extracts/x", "extract_receipt")).toBe("extract_receipt");
  expect(nodeType("gtm/x")).toBe("concept");
});

test("buildGraph builds from pages + the real link graph: isolated nodes stay in", async () => {
  clearGraphCache();
  const g = await buildGraph();
  const ids = g.nodes.map((n) => n.id).sort();
  // acme <-> ada (reciprocal → one edge), pendant entities/widget, plus isolated pages.
  expect(ids).toEqual([
    "companies/acme",
    "concepts/orphan",
    "entities/widget",
    "extracts/receipt",
    "people/ada",
  ]);
  // reciprocal edge deduped; acme-widget kept → 2 undirected links
  expect(g.links).toHaveLength(2);
  // a non-seed link target still becomes a node, labeled + typed from its slug
  const widget = g.nodes.find((n) => n.id === "entities/widget");
  expect(widget).toMatchObject({ label: "widget", type: "product" });
  // a legitimate no-edge page still becomes a graph node with its real backend type
  const receipt = g.nodes.find((n) => n.id === "extracts/receipt");
  expect(receipt).toMatchObject({ label: "Receipt", type: "extract_receipt" });
  // hash-titled target dropped even though it was linked
  expect(ids).not.toContain("concepts/7416e83d");
  // hash-titled page-list import also dropped
  expect(ids).not.toContain("tech/hash-import");
});

test("traversal roots prefer relevance-ranked seed hits over the newest pages", async () => {
  clearGraphCache();
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  // list_pages (updated_desc) is filled by MORE than TRAVERSE_ROOTS fresh,
  // still-unlinked pages; the only edge-bearing hub is surfaced solely by the
  // seed queries. Recency-ordered roots (the pre-fix behavior) would traverse
  // only the fresh pages and build the all-isolated "scattered" graph.
  const fresh = Array.from({ length: 9 }, (_, i) => ({
    slug: `notes/fresh-${i}`,
    title: `Fresh ${i}`,
    type: "concept",
  }));
  const hub = { slug: "companies/hub", title: "Hub", type: "company" };
  mocked.mockImplementation(async (tool, args) => {
    if (tool === "list_pages") return { isError: false, text: JSON.stringify(fresh) };
    if (tool === "query") return { isError: false, text: JSON.stringify([hub]) };
    if (tool === "traverse_graph") {
      const rows =
        (args as { slug?: string }).slug === "companies/hub"
          ? [{ from_slug: "companies/hub", to_slug: "notes/fresh-0" }]
          : [];
      return { isError: false, text: JSON.stringify(rows) };
    }
    return { isError: false, text: "[]" };
  });
  try {
    const g = await buildGraph();
    expect(g.links).toHaveLength(1);
  } finally {
    mocked.mockImplementation(base);
  }
});

test("traversal roots round-robin across seed queries (each query's top hit gets a slot)", async () => {
  clearGraphCache();
  // loadConfig reads live env — pin the queries so an exported SEED_QUERIES
  // in the runner's shell can't change the expected slot math below.
  vi.stubEnv("SEED_QUERIES", "alpha||beta||gamma||delta");
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  // Each of the 4 seed queries returns 3 distinct hubs (12 > 8 slots).
  const traversed: string[] = [];
  mocked.mockImplementation(async (tool, args) => {
    if (tool === "query") {
      const q = (args as { query: string }).query.replace(/\W+/g, "-");
      const hits = [0, 1, 2].map((i) => ({
        slug: `hubs/${q}-${i}`,
        title: `Hub ${q} ${i}`,
        type: "concept",
      }));
      return { isError: false, text: JSON.stringify(hits) };
    }
    if (tool === "traverse_graph") {
      traversed.push((args as { slug: string }).slug);
      return { isError: false, text: "[]" }; // healthy, genuinely edgeless
    }
    return base(tool, args);
  });
  try {
    await buildGraph();
    expect(traversed).toHaveLength(8);
    expect(new Set(traversed).size).toBe(8);
    // round-robin: every query's rank-0 hit is traversed, and all of them
    // come before any lower-ranked hit
    expect(traversed.slice(0, 4).every((s) => s.endsWith("-0"))).toBe(true);
    expect(traversed.filter((s) => s.endsWith("-0"))).toHaveLength(4);
  } finally {
    mocked.mockImplementation(base);
    vi.unstubAllEnvs();
  }
});

test("a big brain drops isolated pages; the connected structure stays intact", async () => {
  clearGraphCache();
  // 1 hub + 401 spokes = 402 connected nodes, past the 400 budget. The threat
  // this pins: reverting the budget guard to an unconditional ensure() silently
  // re-adds the halo of degree-zero dots (66% of the picture at 4k pages) and
  // nothing else in the suite notices, because every other fixture is tiny.
  const base = baseImpl(); // capture BEFORE swapping, or finally restores our own mock
  const spokes = Array.from({ length: 401 }, (_, i) => `concepts/spoke-${i}`);
  const EDGES = spokes.map((s) => ({ from_slug: "concepts/hub", to_slug: s }));
  const PAGES = [
    { slug: "concepts/hub", title: "Hub", type: "concept" },
    { slug: "concepts/lonely", title: "Lonely Isolated Page", type: "concept" },
  ];
  vi.mocked(callTool).mockImplementation(async (tool: string, args?: object) => {
    if (tool === "list_pages") return { isError: false, text: JSON.stringify(PAGES) };
    if (tool === "query")
      return { isError: false, text: JSON.stringify([{ slug: "concepts/hub", title: "Hub" }]) };
    if (tool === "traverse_graph") {
      const s = (args as { slug?: string })?.slug ?? "";
      const incident = EDGES.filter((e) => e.from_slug === s || e.to_slug === s);
      return { isError: false, text: JSON.stringify(incident) };
    }
    return { isError: false, text: "[]" };
  });
  try {
    const g = await buildGraph();
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.size).toBe(402); // hub + 401 spokes, and nothing else
    expect(ids.has("concepts/lonely")).toBe(false); // the halo is gone
    expect(ids.has("concepts/hub")).toBe(true);
    expect(g.links).toHaveLength(401); // dropping isolates must not cost edges
  } finally {
    vi.mocked(callTool).mockImplementation(base);
  }
});

test("buildGraph serves a genuinely edgeless brain without throwing (and caches it)", async () => {
  clearGraphCache();
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  mocked.mockImplementation(async (tool, args) => {
    if (tool === "traverse_graph") return { isError: false, text: "[]" }; // healthy, no edges
    return base(tool, args);
  });
  try {
    const g = await buildGraph();
    expect(g.links).toHaveLength(0);
    expect(g.nodes.length).toBeGreaterThan(0);
  } finally {
    mocked.mockImplementation(base);
  }
});

test("buildGraph fails loud instead of caching an edgeless graph when traversals error", async () => {
  clearGraphCache();
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  // Pages/seeds still resolve (nodes exist), but every edge read fails → the
  // graph would be all-isolated. That must throw, not cache a scattered graph.
  mocked.mockImplementation(async (tool, args) => {
    if (tool === "traverse_graph") throw new Error("brain 429");
    return base(tool, args);
  });
  try {
    await expect(buildGraph()).rejects.toThrow(/refusing to serve an edgeless graph/);
    // and the failed build must NOT have been cached: a retry re-attempts
    // upstream and re-fails (a poisoned cache would resolve with the edgeless graph)
    await expect(buildGraph()).rejects.toThrow(/refusing to serve an edgeless graph/);
  } finally {
    mocked.mockImplementation(base);
  }
});

// Each shape pins ONE edgeRows failure branch (callTool does NOT throw on any
// of these; they used to parse as "healthy, zero edges" and slip past the
// guard): the isError flag on an otherwise healthy-looking body, a non-array
// payload, and a non-empty array carrying no {from_slug, to_slug} rows
// (schema drift — e.g. a backend answering with node rows instead of edges).
const FAILED_READ_SHAPES: [string, { isError: boolean; text: string }][] = [
  ["an isError flag on a healthy-looking body", { isError: true, text: "[]" }],
  ["a non-array payload", { isError: false, text: '"not an array"' }],
  [
    "an array without edge rows",
    { isError: false, text: JSON.stringify([{ slug: "x", title: "X" }]) },
  ],
];
for (const [shape, reply] of FAILED_READ_SHAPES) {
  test(`a traverse read returning ${shape} counts as a failed read`, async () => {
    clearGraphCache();
    const mocked = vi.mocked(callTool);
    const base = baseImpl();
    mocked.mockImplementation(async (tool, args) => {
      if (tool === "traverse_graph") return reply;
      return base(tool, args);
    });
    try {
      await expect(buildGraph()).rejects.toThrow(/refusing to serve an edgeless graph/);
    } finally {
      mocked.mockImplementation(base);
    }
  });
}

test("filter-emptiness is not failure: hash-only edges + a failed read still serve (no 502)", async () => {
  clearGraphCache();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  // acme's only edge goes to a hash-titled page (dropped from the viz) and a
  // DIFFERENT root's read fails. Pre-filter edges exist, so the emptiness of
  // data.links is a filtering artifact, not a brain hiccup — must not throw.
  mocked.mockImplementation(async (tool, args) => {
    if (tool === "traverse_graph") {
      if ((args as { slug?: string }).slug === "companies/acme")
        return {
          isError: false,
          text: JSON.stringify([{ from_slug: "companies/acme", to_slug: "concepts/7416e83d" }]),
        };
      throw new Error("brain 429");
    }
    return base(tool, args);
  });
  try {
    const g = await buildGraph();
    expect(g.links).toHaveLength(0);
  } finally {
    mocked.mockImplementation(base);
    warn.mockRestore();
  }
});

test("hash-titled pages don't consume traversal-root slots", async () => {
  clearGraphCache();
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  // 8 hash-titled mem0 imports lead both the query ranking and the recency
  // list; the only edge-bearing hub sits behind them at position 9. If either
  // root pool let hash pages through, the hub would be sliced out of the 8
  // root slots and the graph would build edgeless.
  const hashes = Array.from({ length: 8 }, (_, i) => ({
    slug: `mem0/import-${i}`,
    title: `a1b2c${i}d4`,
    type: "concept",
  }));
  const hub = { slug: "companies/hub", title: "Hub", type: "company" };
  mocked.mockImplementation(async (tool, args) => {
    if (tool === "query") return { isError: false, text: JSON.stringify(hashes) };
    if (tool === "list_pages") return { isError: false, text: JSON.stringify([...hashes, hub]) };
    if (tool === "traverse_graph") {
      const rows =
        (args as { slug?: string }).slug === "companies/hub"
          ? [{ from_slug: "companies/hub", to_slug: "notes/pinned" }]
          : [];
      return { isError: false, text: JSON.stringify(rows) };
    }
    return base(tool, args);
  });
  try {
    const g = await buildGraph();
    expect(g.links).toHaveLength(1);
  } finally {
    mocked.mockImplementation(base);
  }
});

test("buildGraph fails loud on a total brain outage instead of caching an empty graph", async () => {
  clearGraphCache();
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  mocked.mockImplementation(async () => {
    throw new Error("fetch failed");
  });
  try {
    // No roots were even traversed — the seed-phase failure alone must trip
    // the guard (this used to cache {nodes:[],links:[]} for the full TTL).
    await expect(buildGraph()).rejects.toThrow(/refusing to serve an edgeless graph/);
  } finally {
    mocked.mockImplementation(base);
  }
});

test("a partial traversal failure with surviving edges serves the graph but does NOT cache it", async () => {
  clearGraphCache();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  mocked.mockImplementation(async (tool, args) => {
    if (tool === "traverse_graph" && (args as { slug?: string }).slug !== "companies/acme")
      throw new Error("brain 429");
    return base(tool, args);
  });
  try {
    const g = await buildGraph();
    // acme's incident rows alone still yield both undirected links
    expect(g.links).toHaveLength(2);
    // degraded build is not cached: a second call hits upstream again
    const callsAfterFirst = mocked.mock.calls.length;
    await buildGraph();
    expect(mocked.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  } finally {
    mocked.mockImplementation(base);
    warn.mockRestore();
  }
});

test("buildGraph serves the last good graph stale when a rebuild fails", async () => {
  clearGraphCache();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  const good = await buildGraph(); // healthy build → cached
  expect(good.links).toHaveLength(2);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 3_600_001); // expire the TTL
    mocked.mockImplementation(async (tool, args) => {
      if (tool === "traverse_graph") throw new Error("brain down");
      return base(tool, args);
    });
    // the rebuild fails, but the expired-yet-real graph beats a 502
    await expect(buildGraph()).resolves.toBe(good);
  } finally {
    vi.useRealTimers();
    mocked.mockImplementation(base);
    warn.mockRestore();
  }
});

test("an expired graph is served stale immediately, not after the rebuild", async () => {
  clearGraphCache();
  const mocked = vi.mocked(callTool);
  const base = baseImpl();
  const good = await buildGraph(); // healthy build → cached
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 3_600_001); // expire the TTL
    let rebuildStarted = false;
    mocked.mockImplementation(() => {
      rebuildStarted = true;
      return new Promise(() => {}); // a rebuild that never finishes
    });
    // The threat: reverting to await-then-serve makes this await hang on the
    // never-settling rebuild and the test dies on its timeout — which is
    // exactly what a visitor saw for 10-48s after every TTL expiry.
    await expect(buildGraph()).resolves.toBe(good);
    expect(rebuildStarted).toBe(true); // and the background refresh really began
  } finally {
    vi.useRealTimers();
    mocked.mockImplementation(base);
  }
});

test("concurrent cache misses share a single rebuild (single-flight)", async () => {
  clearGraphCache();
  const mocked = vi.mocked(callTool);
  mocked.mockClear();
  const [a, b] = await Promise.all([buildGraph(), buildGraph()]);
  expect(a).toBe(b);
  // one rebuild's worth of upstream calls: 4 seed queries + list_pages + ≤8
  // traversals — a second concurrent rebuild would double this
  const listCalls = mocked.mock.calls.filter(([tool]) => tool === "list_pages").length;
  expect(listCalls).toBe(1);
});

test("a big EDGELESS brain drops the halo too — the budget measures the prospective total", async () => {
  clearGraphCache();
  // The inverted direction of the isolated-page budget, from the reviewer's
  // round 1: `nodes` holds only edge endpoints when the gate runs, so an
  // edgeless 4,000-page brain measured ZERO connected nodes and sailed under
  // the budget — 4,000 isolated dots, settled by d3, in the PR that added the
  // budget to prevent exactly that.
  const base = baseImpl();
  const PAGES = Array.from({ length: 500 }, (_, i) => ({
    slug: `concepts/iso-${i}`,
    title: `Isolated ${i}`,
    type: "concept",
  }));
  vi.mocked(callTool).mockImplementation(async (tool: string) => {
    if (tool === "list_pages") return { isError: false, text: JSON.stringify(PAGES) };
    if (tool === "query") return { isError: false, text: JSON.stringify([PAGES[0]]) };
    return { isError: false, text: "[]" }; // healthy, genuinely edgeless
  });
  try {
    const g = await buildGraph();
    expect(g.nodes).toHaveLength(0); // 500 candidates > 400 budget: no halo
    expect(g.links).toHaveLength(0);
  } finally {
    vi.mocked(callTool).mockImplementation(base);
  }
});
