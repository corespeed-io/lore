import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "@corespeed/lore-core";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, describe, expect, it } from "vitest";
import { codeIdentity } from "../../tools/evaluation/harness/code";
import {
  cachedEmbeddingProvider,
  embeddingCacheKey,
} from "../../tools/evaluation/harness/embedding-cache";
import {
  answer,
  compareRuns,
  gradingIdentity,
  RUN_ENTRIES,
  retrievalMetrics,
  unitWorkspaceId,
  uuidFromHash,
} from "../../tools/evaluation/harness/harness";
import { identityHash, sha256 } from "../../tools/evaluation/harness/hash";
import { memorySourcesSystem } from "../../tools/evaluation/harness/memory-sources";
import { longMemEvalRubricPrompt, rubricVerdict } from "../../tools/evaluation/harness/scorers";
import { sourceLayout, sourceLayoutFor } from "../../tools/evaluation/harness/source-layout";
import {
  compare,
  gate,
  mcnemarExactP,
  type PairedScore,
  wilson95,
} from "../../tools/evaluation/harness/stats";
import { EvalStore } from "../../tools/evaluation/harness/store";
import { memorySearchSystem } from "../../tools/evaluation/harness/systems";
import { selectTier } from "../../tools/evaluation/harness/tiers";
import type { Dataset, EvalCase, EvalUnit } from "../../tools/evaluation/harness/types";
import { warmFromDatabase } from "../../tools/evaluation/harness/warm";

/** The shared store's real SQL, on an in-process PostgreSQL. */
async function memoryStore(): Promise<EvalStore> {
  const db = new PGlite();
  return EvalStore.over(
    (text, params) => db.query(text, params as unknown[]),
    () => db.close(),
  );
}

const pairs = (
  rows: Array<[category: string, base: number, candidate: number, count: number]>,
): PairedScore[] =>
  rows.flatMap(([category, base, candidate, count]) =>
    Array.from({ length: count }, (_, index) => ({
      caseId: `${category}-${base}-${candidate}-${index}`,
      category,
      base,
      candidate,
    })),
  );

describe("the pre-registered gate", () => {
  it("calls a significant gain with no category regression an improvement", () => {
    const result = gate(
      pairs([
        ["a", 0, 1, 12],
        ["a", 1, 1, 60],
        ["b", 0, 1, 6],
        ["b", 1, 0, 1],
      ]),
      true,
    );
    expect(result.verdict).toBe("improved");
    expect(result.overall).toMatchObject({ wins: 18, losses: 1 });
    expect(result.overall.mcnemarP).toBeLessThan(0.05);
  });

  it("refuses an improvement when one category loses three or more net cases", () => {
    const result = gate(
      pairs([
        ["a", 0, 1, 20],
        ["a", 1, 1, 40],
        ["b", 1, 0, 4],
        ["b", 1, 1, 10],
      ]),
      true,
    );
    expect(result.verdict).toBe("no-evidence");
    expect(result.regressedCategories).toEqual(["b"]);
  });

  it("calls a significant loss, or any isolation failure, a regression", () => {
    expect(
      gate(
        pairs([
          ["a", 1, 0, 15],
          ["a", 1, 1, 50],
        ]),
        true,
      ).verdict,
    ).toBe("regressed");
    expect(gate(pairs([["a", 1, 1, 50]]), true, 1)).toMatchObject({
      verdict: "regressed",
      reasons: ["1 isolation failure(s)"],
    });
  });

  it("stays exact past a thousand discordant pairs, where 2^n overflows", () => {
    // References from Python's math.lgamma, summed in log space.
    expect(mcnemarExactP(470, 600) / 7.876132164651816e-5).toBeCloseTo(1, 9);
    expect(mcnemarExactP(2_000, 2_300) / 5.079935568926816e-6).toBeCloseTo(1, 9);
    const result = gate(
      pairs([
        ["a", 0, 1, 470],
        ["a", 1, 0, 600],
        ["a", 1, 1, 2_000],
      ]),
      true,
    );
    expect(result.verdict).toBe("regressed");
  });

  it("calls noise no evidence, for binary and continuous scores alike", () => {
    expect(
      gate(
        pairs([
          ["a", 0, 1, 3],
          ["a", 1, 0, 2],
          ["a", 1, 1, 40],
        ]),
        true,
      ).verdict,
    ).toBe("no-evidence");
    const continuous = gate(
      pairs([
        ["a", 0.5, 0.52, 10],
        ["a", 0.6, 0.58, 10],
      ]),
      false,
    );
    expect(continuous.verdict).toBe("no-evidence");
    expect(continuous.overall.mcnemarP).toBeNull();
  });

  it("matches the exact McNemar and Wilson references", () => {
    expect(mcnemarExactP(34, 9)).toBeCloseTo(0.000170155, 8);
    expect(mcnemarExactP(5, 0)).toBe(0.0625);
    expect(mcnemarExactP(3, 3)).toBe(1);
    const [low, high] = wilson95(422, 500);
    expect(low).toBeCloseTo(0.8098, 3);
    expect(high).toBeCloseTo(0.8729, 3);
    expect(compare(pairs([["a", 0, 1, 2]]), true).delta).toBe(1);
  });
});

describe("tiers", () => {
  const index = ["x", "y"].flatMap((category) =>
    Array.from({ length: 30 }, (_, number) => ({
      id: `${category}${number}`,
      unitKey: `${category}${number}`,
      category,
    })),
  );

  it("take a fixed number per category in hash order, the same every time", () => {
    const smoke = selectTier(index, "smoke");
    expect(smoke.size).toBe(10);
    expect(selectTier([...index].reverse(), "smoke")).toEqual(smoke);
    expect(selectTier(index, "standard").size).toBe(40);
    expect(selectTier(index, "full").size).toBe(60);
  });
});

describe("the store and embedding cache", () => {
  it("hashes identities independently of key order", () => {
    expect(identityHash({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(
      identityHash({ b: { d: "x", c: [1, 2] }, a: 1 }),
    );
  });

  it("answers repeated texts from the store and counts provider failures", async () => {
    const store = await memoryStore();
    const calls: string[][] = [];
    let fail = false;
    const base: EmbeddingProvider = {
      provider: "test",
      model: "m",
      dimensions: 2,
      revision: "r",
      async embed(texts) {
        if (fail) throw new Error("provider down");
        calls.push(texts);
        return texts.map((text) => [text.length, 0.5]);
      },
    };
    const { provider, counters } = cachedEmbeddingProvider(base, store);
    expect(await provider.embed(["ab", "cde"], "document")).toEqual([
      [2, 0.5],
      [3, 0.5],
    ]);
    expect(await provider.embed(["cde", "f"], "document")).toEqual([
      [3, 0.5],
      [1, 0.5],
    ]);
    // A query and a document of the same text are different embeddings.
    await provider.embed(["ab"], "query");
    expect(calls).toEqual([["ab", "cde"], ["f"], ["ab"]]);
    expect(counters).toMatchObject({ cached: 1, embedded: 4, requests: 3, failures: 0 });
    fail = true;
    await expect(provider.embed(["new"], "document")).rejects.toThrow("provider down");
    expect(counters.failures).toBe(1);
    await store.close();
  });

  it("keeps runs, packets, answers, and verdicts by content, first writer winning", async () => {
    const store = await memoryStore();
    const items = [{ id: "m", text: "t", sourceKeys: ["k"] }];
    const sha = await store.savePacket({ items, latencyMs: 3 });
    expect(sha).toBe(sha256(JSON.stringify(items)));
    expect((await store.packets([sha])).get(sha)).toEqual(items);
    await expect(store.packets(["missing"])).rejects.toThrow("missing from the store");
    await store.saveAnswer("a", { answer: "yes", inputTokens: 10, outputTokens: 2 });
    await store.saveAnswer("a", { answer: "other", inputTokens: 1, outputTokens: 1 });
    expect((await store.answers(["a", "a", "b"])).get("a")).toEqual({
      answer: "yes",
      inputTokens: 10,
      outputTokens: 2,
    });
    await store.saveVerdict("v", { score: 1, label: "yes", inputTokens: null, outputTokens: null });
    expect((await store.verdicts(["v"])).get("v")?.score).toBe(1);
    await store.close();
  });

  it("returns every stored vector bit for bit, past one batch", async () => {
    const store = await memoryStore();
    const tricky = [0.1, -1 / 3, 1e-30, 3.4028234663852886e38, -0, 123456.789];
    const entries: Array<[string, number[]]> = Array.from({ length: 1_203 }, (_, index) => [
      `k${index}`,
      tricky.map((value) => value * (index + 1)),
    ]);
    await store.saveEmbeddings(entries);
    const found = await store.embeddings(entries.map(([key]) => key));
    expect(found.size).toBe(1_203);
    for (const [key, values] of entries) {
      expect(Array.from(found.get(key) ?? [])).toEqual(Array.from(Float32Array.from(values)));
    }
    await store.close();
  });
});

describe("case metrics and scoring", () => {
  it("reads retrieval against gold records, and skips cases without gold", () => {
    const items = [
      { id: "1", text: "", sourceKeys: ["s1"] },
      { id: "2", text: "", sourceKeys: ["s2"] },
      { id: "3", text: "", sourceKeys: ["s3"] },
    ];
    expect(retrievalMetrics(items, ["s2", "s3"])).toEqual({
      gold: 2,
      anyHit: true,
      allHit: true,
      reciprocalRank: 0.5,
    });
    expect(retrievalMetrics(items, ["s2", "s9"]).allHit).toBe(false);
    expect(retrievalMetrics(items, [])).toEqual({
      gold: 0,
      anyHit: false,
      allHit: false,
      reciprocalRank: 0,
    });
  });

  it("fills the LongMemEval rubric by question type and reads only yes or no", () => {
    const templates = ["A {} {} {}", "T {} {} {}", "K {} {} {}", "P {} {} {}", "X {} {} {}"];
    const evalCase: EvalCase = {
      id: "q",
      unitKey: "q",
      category: "temporal-reasoning",
      question: "When?",
      readerQuestion: "When?",
      searchQuery: "When?",
      answer: "Monday",
      evidenceKeys: ["s"],
      abstention: false,
      scoring: { questionType: "temporal-reasoning" },
    };
    expect(longMemEvalRubricPrompt(templates, evalCase, "Tuesday")).toBe("T When? Monday Tuesday");
    expect(longMemEvalRubricPrompt(templates, { ...evalCase, abstention: true }, "-")).toMatch(
      /^X /,
    );
    expect(rubricVerdict(" Yes.\n")).toBe("yes");
    expect(() => rubricVerdict("probably")).toThrow("yes/no");
    expect(uuidFromHash("a".repeat(64))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("what a run may reuse", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const checkout = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "lore-eval-code-"));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  const files = {
    "entry.ts":
      'import { a } from "./lib/a";\nimport { p } from "pkg";\nimport type { T } from "./types";\nexport const x: T = a + p;\n',
    "lib/a.ts": 'import { readFileSync } from "node:fs";\nexport const a = typeof readFileSync;\n',
    "types.ts": "export type T = string;\n",
    "unrelated.ts": "export const unused = 1;\n",
    "node_modules/pkg/package.json": '{ "name": "pkg", "main": "index.ts" }',
    "node_modules/pkg/index.ts": 'export const p = "1";\n',
    "bun.lock": "lock v1\n",
  };

  it("hashes exactly the files a checkout would load, by content", () => {
    const base = checkout(files);
    const identity = codeIdentity([join(base, "entry.ts")], base);
    // entry and lib/a; the type-only import, the unrelated file, and the package are not read.
    expect(identity.files).toBe(2);
    const same = checkout({ ...files, "unrelated.ts": "export const unused = 2;\n" });
    expect(codeIdentity([join(same, "entry.ts")], same).digest).toBe(identity.digest);
    const sameOutsideLock = checkout({
      ...files,
      "node_modules/pkg/index.ts": "export const p = 2;\n",
    });
    expect(codeIdentity([join(sameOutsideLock, "entry.ts")], sameOutsideLock).digest).toBe(
      identity.digest,
    );
    const edited = checkout({ ...files, "lib/a.ts": "export const a = 'edited';\n" });
    expect(codeIdentity([join(edited, "entry.ts")], edited).digest).not.toBe(identity.digest);
    const relocked = checkout({ ...files, "bun.lock": "lock v2\n" });
    expect(codeIdentity([join(relocked, "entry.ts")], relocked).digest).not.toBe(identity.digest);
  });

  it("keys runs by everything that stores results, and corpora by the ingest path only", async () => {
    const harness = join(process.cwd(), "tools/evaluation/harness");
    const closure = (entries: readonly string[]) => codeIdentity(entries, process.cwd()).paths;
    const store = await memoryStore();
    for (const system of [
      memorySearchSystem({ store, geminiApiKey: "unused-in-this-test" }),
      memorySourcesSystem({ store, geminiApiKey: "unused-in-this-test", layout: sourceLayout }),
    ]) {
      const run = closure([
        ...RUN_ENTRIES.map((entry) => join(harness, entry)),
        ...system.runEntries,
      ]);
      const corpus = closure(system.corpusEntries);
      for (const file of ["store.ts", "harness.ts", "datasets.ts", "system-common.ts"]) {
        expect(run).toContain(`tools/evaluation/harness/${file}`);
      }
      expect(run).toContain("packages/lore-core/src/memory-chunking.ts");
      // Storage, reporting, and layout edits must not seed new corpora.
      for (const file of ["store.ts", "run-eval.ts", "source-layout.ts"]) {
        expect(corpus).not.toContain(`tools/evaluation/harness/${file}`);
      }
      expect(corpus).not.toContain("packages/typescript-sdk/src/index.ts");
      expect(corpus).toContain("packages/lore-core/src/memory-chunking.ts");
      expect(corpus).toContain("src/modules/memories/service.ts");
    }
    // The layout's SDK is part of a sources run, so an SDK change gets new packets.
    const sources = memorySourcesSystem({
      store,
      geminiApiKey: "unused-in-this-test",
      layout: sourceLayout,
    });
    expect(closure(sources.runEntries)).toContain("packages/typescript-sdk/src/index.ts");
    expect(closure(sources.corpusEntries)).toContain(
      "src/modules/episodes/observation-evidence.ts",
    );
    await store.close();
  });

  it("refuses code that resolves outside the checkout", () => {
    const parent = checkout({ "outside.ts": "export const o = 1;\n" });
    const inner = join(parent, "repo");
    mkdirSync(inner);
    writeFileSync(
      join(inner, "entry.ts"),
      'import { o } from "../outside";\nexport const x = o;\n',
    );
    expect(() => codeIdentity([join(inner, "entry.ts")], inner)).toThrow("outside");
  });

  it("gives a Unit a new Workspace whenever what it stores would differ", () => {
    const unit: EvalUnit = {
      key: "u1",
      records: [{ key: "r1", text: "Alice moved to Lisbon." }],
      cases: [],
      tripwires: ["Bob's secret"],
    };
    const id = unitWorkspaceId("corpus-a", unit);
    // Cases are not stored, so they never move the Workspace.
    expect(unitWorkspaceId("corpus-a", { ...unit, cases: [] })).toBe(id);
    expect(unitWorkspaceId("corpus-b", unit)).not.toBe(id);
    expect(
      unitWorkspaceId("corpus-a", { ...unit, records: [{ key: "r1", text: "Alice moved." }] }),
    ).not.toBe(id);
    expect(unitWorkspaceId("corpus-a", { ...unit, tripwires: ["other"] })).not.toBe(id);
    // The id of a Unit without sources does not depend on the field existing.
    expect(id).toBe(
      uuidFromHash(
        identityHash({
          corpus: "corpus-a",
          unit: unit.key,
          records: unit.records,
          tripwires: unit.tripwires,
        }),
      ),
    );
    const withSources: EvalUnit = {
      ...unit,
      sources: [{ key: "s1", text: "Session text.", observedAt: "2023-05-20T02:21:00.000Z" }],
    };
    const sourced = unitWorkspaceId("corpus-a", withSources);
    expect(sourced).not.toBe(id);
    for (const changed of [
      { key: "s2", text: "Session text.", observedAt: "2023-05-20T02:21:00.000Z" },
      { key: "s1", text: "Other text.", observedAt: "2023-05-20T02:21:00.000Z" },
      { key: "s1", text: "Session text.", observedAt: "2023-05-21T02:21:00.000Z" },
    ]) {
      expect(unitWorkspaceId("corpus-a", { ...withSources, sources: [changed] })).not.toBe(sourced);
    }
  });

  it("keeps provenance per run and remembers which corpora were used", async () => {
    const store = await memoryStore();
    await store.saveEvent("run", {
      kind: "answer",
      at: "2026-10-14T00:00:00.000Z",
      detail: {
        reader: "r",
        scorer: "locomo-f1",
        judge: null,
        grading: "g1",
        cases: { answersFromStore: 3, answersNew: 1, verdictsFromStore: 4, verdictsNew: 0 },
        readerCalls: 1,
        gradeCalls: 0,
        readerTokens: { input: 10, output: 2 },
        estimatedReaderUsd: 0,
      },
    });
    expect(await store.events("run")).toMatchObject([
      { kind: "answer", detail: { cases: { answersNew: 1 } } },
    ]);
    expect(await store.events("other")).toEqual([]);
    await store.touchCorpora("db", [{ workspaceId: "w1", unit: "u1", corpus: "c" }]);
    await store.touchCorpora("db", [{ workspaceId: "w1", unit: "u1", corpus: "c" }]);
    expect(await store.corporaUsedSince("db", new Date("2000-01-01"))).toEqual(new Set(["w1"]));
    expect((await store.corporaUsedSince("db", new Date("2999-01-01"))).size).toBe(0);
    expect((await store.corporaUsedSince("other", new Date("2000-01-01"))).size).toBe(0);
    await store.forgetCorpora("db", ["w1"]);
    expect((await store.corporaUsedSince("db", new Date("2000-01-01"))).size).toBe(0);
    await store.close();
  });
});

describe("comparing answered runs", () => {
  const seed = async (store: EvalStore, run: string, gradings: Array<string | null>, score = 1) => {
    await store.saveRun({
      id: run,
      refSha: run,
      dataset: "d",
      tier: "standard",
      system: "s",
      identity: {},
      createdAt: "2026-10-14T00:00:00.000Z",
    });
    await store.saveResults(
      run,
      gradings.map((grading, index) => ({
        caseId: `c${index}`,
        category: "a",
        packetSha: "p",
        retrieval: { gold: 1, anyHit: true, allHit: true, reciprocalRank: 1 },
        latencyMs: 1,
        isolationFailure: false,
        answerKey: "a",
        verdictKey: "v",
        score,
        grading,
      })),
    );
  };

  it("names the reader, scorer, and judge behind every score", () => {
    const base = gradingIdentity("reader", { scorer: "longmemeval" }, { model: "sol" });
    expect(gradingIdentity("reader", { scorer: "longmemeval" }, { model: "sol" })).toBe(base);
    expect(gradingIdentity("reader", { scorer: "longmemeval" }, { model: "4o" })).not.toBe(base);
    expect(gradingIdentity("other", { scorer: "longmemeval" }, { model: "sol" })).not.toBe(base);
    expect(gradingIdentity("reader", { scorer: "f1" }, null)).not.toBe(base);
  });

  it("refuses to compare scores from two graders", async () => {
    const store = await memoryStore();
    await seed(store, "base", ["judge-a", "judge-a"], 0);
    await seed(store, "candidate", ["judge-b", "judge-b"], 1);
    await expect(compareRuns(store, "base", "candidate", true)).rejects.toThrow("graded under 2");
    await store.close();
  });

  it("refuses a run whose own scores mix graders", async () => {
    const store = await memoryStore();
    await seed(store, "base", ["judge-a", "judge-a"]);
    await seed(store, "candidate", ["judge-a", "judge-b"]);
    await expect(compareRuns(store, "base", "candidate", true)).rejects.toThrow("graded under 2");
    await store.close();
  });

  it("refuses scores whose grader was never recorded, even on both sides", async () => {
    const store = await memoryStore();
    await seed(store, "base", [null, null]);
    await seed(store, "candidate", [null, null]);
    await expect(compareRuns(store, "base", "candidate", true)).rejects.toThrow("answer it again");
    await store.close();
  });

  it("compares runs graded alike", async () => {
    const store = await memoryStore();
    await seed(store, "base", ["judge-a", "judge-a"]);
    await seed(store, "candidate", ["judge-a", "judge-a"]);
    const comparison = await compareRuns(store, "base", "candidate", true);
    expect(comparison.answers?.verdict).toBe("no-evidence");
    expect(comparison.candidate.gradings).toEqual(["judge-a"]);
    await store.close();
  });
});

describe("warming the store from another Lore database", () => {
  const space = { provider: "google", model: "m", dimensions: 3, revision: "r1" };
  /** A read-only source with a generation, three chunks, and two sharing one text. */
  async function source() {
    const db = new PGlite({ extensions: { vector } });
    await db.exec(`
      CREATE EXTENSION vector;
      CREATE TABLE embedding_generations (id uuid PRIMARY KEY, embedding_provider text,
        embedding_model text, embedding_dimensions integer, embedding_revision text);
      CREATE TABLE memory_chunks (id uuid PRIMARY KEY, content text);
      CREATE TABLE memory_chunk_embeddings (generation_id uuid, chunk_id uuid, embedding vector,
        PRIMARY KEY (generation_id, chunk_id));
      INSERT INTO embedding_generations VALUES
        ('00000000-0000-4000-8000-000000000001', 'google', 'm', 3, 'r1');
      INSERT INTO memory_chunks VALUES
        ('00000000-0000-4000-8000-0000000000a1', 'alpha'),
        ('00000000-0000-4000-8000-0000000000a2', 'beta'),
        ('00000000-0000-4000-8000-0000000000a3', 'alpha');
      INSERT INTO memory_chunk_embeddings VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '[0.1,0.2,0.3]'),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', '[0.4,0.5,0.6]'),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a3', '[0.1,0.2,0.3]');
      SET default_transaction_read_only = on;
    `);
    return db;
  }
  const query = (db: PGlite) => (text: string, params?: unknown[]) =>
    db.query(text, params as unknown[]);

  it("copies vectors under the harness's own keys, page by page, writing nothing at the source", async () => {
    const db = await source();
    const store = await memoryStore();
    const alpha = embeddingCacheKey(space, "document", "alpha");
    await store.saveEmbeddings([[alpha, [0.1, 0.2, 0.3]]]);
    const report = await warmFromDatabase({
      source: query(db),
      store,
      batchSize: 2,
      log: () => {},
    });
    expect(report).toMatchObject({ read: 3, added: 1, compared: 2, maxDifference: 0 });
    const beta = embeddingCacheKey(space, "document", "beta");
    expect(Array.from((await store.embeddings([beta])).get(beta) ?? [])).toEqual(
      Array.from(Float32Array.from([0.4, 0.5, 0.6])),
    );
    await expect(
      db.query("INSERT INTO memory_chunks VALUES (gen_random_uuid(), 'x')"),
    ).rejects.toThrow("read-only");
    await store.close();
    await db.close();
  });

  it("stops when a vector disagrees with the store, and refuses a writable source", async () => {
    const db = await source();
    const store = await memoryStore();
    await store.saveEmbeddings([[embeddingCacheKey(space, "document", "alpha"), [0.1, 0.2, 0.4]]]);
    await expect(warmFromDatabase({ source: query(db), store, log: () => {} })).rejects.toThrow(
      "differs from the store's",
    );
    const beta = embeddingCacheKey(space, "document", "beta");
    expect((await store.embeddings([beta])).size).toBe(0);
    await db.exec("SET default_transaction_read_only = off");
    await expect(warmFromDatabase({ source: query(db), store, log: () => {} })).rejects.toThrow(
      "not read-only",
    );
    await store.close();
    await db.close();
  });
});

describe("sandboxes racing on one key", () => {
  /** Two sandboxes' stores over one database. */
  async function twoStores() {
    const db = new PGlite();
    const query = (text: string, params?: unknown[]) => db.query(text, params as unknown[]);
    return {
      mine: await EvalStore.over(query),
      theirs: await EvalStore.over(query),
      close: () => db.close(),
    };
  }

  it("hands every writer the first stored answer, verdict, and vector", async () => {
    const { mine, theirs, close } = await twoStores();
    await theirs.saveAnswer("a", { answer: "London", inputTokens: 1, outputTokens: 1 });
    expect(
      await mine.saveAnswer("a", { answer: "Paris", inputTokens: 2, outputTokens: 2 }),
    ).toEqual({ answer: "London", inputTokens: 1, outputTokens: 1 });
    await theirs.saveVerdict("v", { score: 0, label: "no", inputTokens: null, outputTokens: null });
    expect(
      (
        await mine.saveVerdict("v", {
          score: 1,
          label: "yes",
          inputTokens: null,
          outputTokens: null,
        })
      ).label,
    ).toBe("no");
    await theirs.saveEmbeddings([["e", [1, 2]]]);
    const stored = await mine.saveEmbeddings([
      ["e", [3, 4]],
      ["f", [5, 6]],
    ]);
    expect(Array.from(stored.get("e") ?? [])).toEqual([1, 2]);
    expect(Array.from(stored.get("f") ?? [])).toEqual([5, 6]);
    await close();
  });

  it("embeds with the vector another sandbox stored while this one was calling the provider", async () => {
    const { mine, theirs, close } = await twoStores();
    const space = { provider: "test", model: "m", dimensions: 2, revision: "r" };
    const { provider } = cachedEmbeddingProvider(
      {
        ...space,
        async embed(texts) {
          await theirs.saveEmbeddings([[embeddingCacheKey(space, "query", "q"), [0.25, 0.75]]]);
          return texts.map(() => [0.5, 0.5]);
        },
      },
      mine,
    );
    expect(await provider.embed(["q"], "query")).toEqual([[0.25, 0.75]]);
    await close();
  });

  it("grades the answer another sandbox stored first, never its own", async () => {
    const { mine, theirs, close } = await twoStores();
    const evalCase: EvalCase = {
      id: "c1",
      unitKey: "u",
      category: "single-hop",
      question: "Where does Alice live?",
      readerQuestion: "Where does Alice live?",
      searchQuery: "Where does Alice live?",
      answer: "London",
      evidenceKeys: [],
      abstention: false,
      scoring: { locomoCategory: 4 },
    };
    const dataset: Dataset = {
      id: "d",
      revision: "r",
      scorer: "locomo-f1",
      reader: { maximumContextCharacters: 1_000 },
      index: async () => [],
      async *units() {
        yield { key: "u", records: [], cases: [evalCase], tripwires: [] };
      },
    };
    const packetSha = await mine.savePacket({
      items: [{ id: "m", text: "Alice moved to London.", sourceKeys: [] }],
      latencyMs: 1,
    });
    await mine.saveRun({
      id: "run",
      refSha: "x",
      dataset: "d",
      tier: "standard",
      system: "s",
      identity: {},
      createdAt: "2026-10-14T00:00:00.000Z",
    });
    await mine.saveResults("run", [
      {
        caseId: "c1",
        category: "single-hop",
        packetSha,
        retrieval: { gold: 0, anyHit: false, allHit: false, reciprocalRank: 0 },
        latencyMs: 1,
        isolationFailure: false,
        answerKey: null,
        verdictKey: null,
        score: null,
        grading: null,
      },
    ]);
    const render = (question: string, evidence: Array<{ id: string; text: string }>) =>
      `${question}|${evidence.map((item) => item.text).join("|")}`;
    await answer({
      store: mine,
      dataset,
      runIds: ["run"],
      reader: "gemini-3.5-flash",
      judge: "gpt-5.6-sol",
      geminiApiKey: "",
      budgetUsd: 1,
      log: () => {},
      bound: {
        reader: {
          identity: { reader: "fake" },
          identityHash: "fake-reader",
          render,
          async answer(question, evidence) {
            // Another sandbox answers the same input first.
            await theirs.saveAnswer(sha256(`fake-reader\u0000${render(question, evidence)}`), {
              answer: "London",
              inputTokens: 1,
              outputTokens: 1,
            });
            return { text: "Paris", inputTokens: 1, outputTokens: 1 };
          },
        },
      },
    });
    const [result] = await mine.results("run");
    expect(result?.score).toBe(1);
    expect(
      (await mine.answers([result?.answerKey ?? ""])).get(result?.answerKey ?? "")?.answer,
    ).toBe("London");
    await close();
  });
});

describe("answering a run named twice", () => {
  it("answers a run once when a gate's base and candidate share it", async () => {
    const db = new PGlite();
    const store = await EvalStore.over((text, params) => db.query(text, params as unknown[]));
    const evalCase: EvalCase = {
      id: "c1",
      unitKey: "u",
      category: "single-hop",
      question: "Where does Alice live?",
      readerQuestion: "Where does Alice live?",
      searchQuery: "Where does Alice live?",
      answer: "London",
      evidenceKeys: [],
      abstention: false,
      scoring: { locomoCategory: 4 },
    };
    const dataset: Dataset = {
      id: "d",
      revision: "r",
      scorer: "locomo-f1",
      reader: { maximumContextCharacters: 1_000 },
      index: async () => [],
      async *units() {
        yield { key: "u", records: [], cases: [evalCase], tripwires: [] };
      },
    };
    const packetSha = await store.savePacket({
      items: [{ id: "m", text: "Alice moved to London.", sourceKeys: [] }],
      latencyMs: 1,
    });
    await store.saveRun({
      id: "shared",
      refSha: "x",
      dataset: "d",
      tier: "standard",
      system: "s",
      identity: {},
      createdAt: "2026-10-14T00:00:00.000Z",
    });
    await store.saveResults("shared", [
      {
        caseId: "c1",
        category: "single-hop",
        packetSha,
        retrieval: { gold: 0, anyHit: false, allHit: false, reciprocalRank: 0 },
        latencyMs: 1,
        isolationFailure: false,
        answerKey: null,
        verdictKey: null,
        score: null,
        grading: null,
      },
    ]);
    let calls = 0;
    await answer({
      store,
      dataset,
      runIds: ["shared", "shared"],
      reader: "gemini-3.5-flash",
      judge: "gpt-5.6-sol",
      geminiApiKey: "",
      budgetUsd: 1,
      log: () => {},
      bound: {
        reader: {
          identity: { reader: "fake" },
          identityHash: "fake-reader",
          render: (question) => question,
          async answer() {
            calls += 1;
            return { text: "London", inputTokens: 1, outputTokens: 1 };
          },
        },
      },
    });
    expect(calls).toBe(1);
    expect((await store.results("shared"))[0]?.score).toBe(1);
    expect((await store.events("shared")).filter((event) => event.kind === "answer")).toHaveLength(
      1,
    );
    const comparison = await compareRuns(store, "shared", "shared", false);
    expect(comparison.changedPackets).toBe(0);
    await db.close();
  });
});

describe("the order an agent reads sources in", () => {
  const memoryIds = ["m1", "m2", "m3"];
  const sources = [
    { observationId: "o1", memoryIds: ["m1"] },
    { observationId: "o2", memoryIds: ["m3"] },
    { observationId: "o3", memoryIds: ["m1", "m2"] },
  ];

  it("puts every Memory first when the checkout has two calls", () => {
    const layout = sourceLayoutFor(undefined, "x");
    expect(layout.name).toMatch(/^two calls/);
    expect(layout.arrange(memoryIds, sources)).toEqual([
      { kind: "memory", index: 0 },
      { kind: "memory", index: 1 },
      { kind: "memory", index: 2 },
      { kind: "source", index: 0 },
      { kind: "source", index: 1 },
      { kind: "source", index: 2 },
    ]);
  });

  it("puts each Memory's sources after it when the SDK exports attachMemorySources", () => {
    // The contract a checkout's SDK may export: each source after its first citing result.
    const attachMemorySources = (
      results: ReadonlyArray<{ memory: { id: string } }>,
      read: { sources: ReadonlyArray<{ observationId: string; memoryIds: readonly string[] }> },
    ) =>
      results.map((_, index) => ({
        sources: read.sources.filter(
          (source) =>
            results.findIndex((other) => source.memoryIds.includes(other.memory.id)) === index,
        ),
      }));
    const layout = sourceLayoutFor(attachMemorySources, "x");
    expect(layout.name).toMatch(/^sdk attachMemorySources/);
    expect(layout.arrange(memoryIds, sources)).toEqual([
      { kind: "memory", index: 0 },
      { kind: "source", index: 0 },
      { kind: "source", index: 2 },
      { kind: "memory", index: 1 },
      { kind: "memory", index: 2 },
      { kind: "source", index: 1 },
    ]);
    // This checkout's SDK has none, so its runs read as an agent's two calls do.
    expect(sourceLayout.name).toMatch(/^two calls/);
  });

  it("refuses an SDK order that leaves a source out", () => {
    const dropsAll = (results: ReadonlyArray<{ memory: { id: string } }>) =>
      results.map(() => ({ sources: [] }));
    expect(() => sourceLayoutFor(dropsAll, "x").arrange(memoryIds, sources)).toThrow(
      "placed 0 of 3 sources",
    );
  });
});
