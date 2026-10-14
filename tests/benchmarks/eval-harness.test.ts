import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "@corespeed/lore-core";
import { afterEach, describe, expect, it } from "vitest";
import { codeIdentity } from "../../tools/evaluation/harness/code";
import { cachedEmbeddingProvider } from "../../tools/evaluation/harness/embedding-cache";
import {
  CORPUS_ENTRIES,
  compareRuns,
  gradingIdentity,
  RUN_ENTRIES,
  retrievalMetrics,
  unitWorkspaceId,
  uuidFromHash,
} from "../../tools/evaluation/harness/harness";
import { identityHash, sha256 } from "../../tools/evaluation/harness/hash";
import { longMemEvalRubricPrompt, rubricVerdict } from "../../tools/evaluation/harness/scorers";
import {
  compare,
  gate,
  mcnemarExactP,
  type PairedScore,
  wilson95,
} from "../../tools/evaluation/harness/stats";
import { EvalStore } from "../../tools/evaluation/harness/store";
import { selectTier } from "../../tools/evaluation/harness/tiers";
import type { EvalCase, EvalUnit } from "../../tools/evaluation/harness/types";

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
    const store = new EvalStore(":memory:");
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
    store.close();
  });

  it("keeps runs, packets, answers, and verdicts by content", () => {
    const store = new EvalStore(":memory:");
    const sha = store.savePacket({
      items: [{ id: "m", text: "t", sourceKeys: ["k"] }],
      latencyMs: 3,
    });
    expect(sha).toBe(sha256(JSON.stringify([{ id: "m", text: "t", sourceKeys: ["k"] }])));
    expect(store.packet(sha)).toEqual([{ id: "m", text: "t", sourceKeys: ["k"] }]);
    store.saveAnswer("a", { answer: "yes", inputTokens: 10, outputTokens: 2 });
    expect(store.answer("a")).toEqual({ answer: "yes", inputTokens: 10, outputTokens: 2 });
    store.saveVerdict("v", { score: 1, label: "yes", inputTokens: null, outputTokens: null });
    expect(store.verdict("v")?.score).toBe(1);
    store.close();
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

  it("keys runs by everything that stores results, and corpora by the ingest path only", () => {
    const harness = join(process.cwd(), "tools/evaluation/harness");
    const closure = (entries: readonly string[]) =>
      codeIdentity(
        entries.map((entry) => join(harness, entry)),
        process.cwd(),
      ).paths;
    const run = closure(RUN_ENTRIES);
    const corpus = closure(CORPUS_ENTRIES);
    for (const file of ["store.ts", "harness.ts", "datasets.ts", "systems.ts"]) {
      expect(run).toContain(`tools/evaluation/harness/${file}`);
    }
    expect(run).toContain("packages/lore-core/src/memory-chunking.ts");
    // Storage and reporting edits must not seed new corpora.
    expect(corpus).not.toContain("tools/evaluation/harness/store.ts");
    expect(corpus).not.toContain("tools/evaluation/harness/run-eval.ts");
    expect(corpus).toContain("packages/lore-core/src/memory-chunking.ts");
    expect(corpus).toContain("src/modules/memories/service.ts");
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
  });

  it("keeps provenance per run and remembers which corpora were used", () => {
    const store = new EvalStore(":memory:");
    store.saveEvent("run", {
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
    expect(store.events("run")).toMatchObject([
      { kind: "answer", detail: { cases: { answersNew: 1 } } },
    ]);
    expect(store.events("other")).toEqual([]);
    store.touchCorpora("db", [{ workspaceId: "w1", unit: "u1", corpus: "c" }]);
    expect(store.corporaUsedSince("db", "2000-01-01T00:00:00.000Z")).toEqual(new Set(["w1"]));
    expect(store.corporaUsedSince("db", "2999-01-01T00:00:00.000Z").size).toBe(0);
    store.forgetCorpora("db", ["w1"]);
    expect(store.corporaUsedSince("db", "2000-01-01T00:00:00.000Z").size).toBe(0);
    store.close();
  });
});

describe("comparing answered runs", () => {
  const seed = (store: EvalStore, run: string, gradings: Array<string | null>, score = 1) => {
    store.saveRun({
      id: run,
      refSha: run,
      dataset: "d",
      tier: "standard",
      system: "s",
      identity: {},
      createdAt: "2026-10-14T00:00:00.000Z",
    });
    for (const [index, grading] of gradings.entries()) {
      store.saveResult(run, {
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
      });
    }
  };

  it("names the reader, scorer, and judge behind every score", () => {
    const base = gradingIdentity("reader", { scorer: "longmemeval" }, { model: "sol" });
    expect(gradingIdentity("reader", { scorer: "longmemeval" }, { model: "sol" })).toBe(base);
    expect(gradingIdentity("reader", { scorer: "longmemeval" }, { model: "4o" })).not.toBe(base);
    expect(gradingIdentity("other", { scorer: "longmemeval" }, { model: "sol" })).not.toBe(base);
    expect(gradingIdentity("reader", { scorer: "f1" }, null)).not.toBe(base);
  });

  it("refuses to compare scores from two graders", () => {
    const store = new EvalStore(":memory:");
    seed(store, "base", ["judge-a", "judge-a"], 0);
    seed(store, "candidate", ["judge-b", "judge-b"], 1);
    expect(() => compareRuns(store, "base", "candidate", true)).toThrow("graded under 2");
    store.close();
  });

  it("refuses a run whose own scores mix graders", () => {
    const store = new EvalStore(":memory:");
    seed(store, "base", ["judge-a", "judge-a"]);
    seed(store, "candidate", ["judge-a", "judge-b"]);
    expect(() => compareRuns(store, "base", "candidate", true)).toThrow("graded under 2");
    store.close();
  });

  it("refuses scores whose grader was never recorded, even on both sides", () => {
    const store = new EvalStore(":memory:");
    seed(store, "base", [null, null]);
    seed(store, "candidate", [null, null]);
    expect(() => compareRuns(store, "base", "candidate", true)).toThrow("answer it again");
    store.close();
  });

  it("compares runs graded alike", () => {
    const store = new EvalStore(":memory:");
    seed(store, "base", ["judge-a", "judge-a"]);
    seed(store, "candidate", ["judge-a", "judge-a"]);
    const comparison = compareRuns(store, "base", "candidate", true);
    expect(comparison.answers?.verdict).toBe("no-evidence");
    expect(comparison.candidate.gradings).toEqual(["judge-a"]);
    store.close();
  });
});
