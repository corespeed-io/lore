import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { codeIdentity } from "./code";
import { ensureEvalDatabase } from "./database";
import { identityHash, sha256 } from "./hash";
import {
  type BoundJudge,
  type BoundReader,
  bindJudge,
  bindReader,
  type JudgeProfileName,
  type ReaderProfileName,
} from "./profiles";
import { createScorer, type Scorer } from "./scorers";
import { type GateResult, gate, type PairedScore, wilson95 } from "./stats";
import type { CaseResult, EvalStore, RunEvent } from "./store";
import { EMBEDDING_SPACE } from "./system-common";
import { selectTier, TIERS, type TierName } from "./tiers";
import type {
  Dataset,
  EvalCase,
  EvalSystem,
  EvalUnit,
  IngestOutcome,
  PacketItem,
  RetrievalMetrics,
} from "./types";

/** A UUID derived from a hash, so a corpus's Workspaces are the same on every run. */
export function uuidFromHash(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A Unit's Workspace id: the corpus key (dataset, database, ingest code) plus the
 * Unit's exact records and tripwires. Any difference in what would be stored
 * gives a different Workspace.
 */
export function unitWorkspaceId(corpusKey: string, unit: EvalUnit): string {
  return uuidFromHash(
    identityHash({
      corpus: corpusKey,
      unit: unit.key,
      records: unit.records,
      tripwires: unit.tripwires,
    }),
  );
}

export function retrievalMetrics(
  items: readonly PacketItem[],
  evidenceKeys: readonly string[],
): RetrievalMetrics {
  if (!evidenceKeys.length) return { gold: 0, anyHit: false, allHit: false, reciprocalRank: 0 };
  const ranked = items.map((item) => item.sourceKeys);
  const firstHit = ranked.findIndex((keys) => keys.some((key) => evidenceKeys.includes(key)));
  const found = new Set(ranked.flat().filter((key) => evidenceKeys.includes(key)));
  return {
    gold: evidenceKeys.length,
    anyHit: firstHit >= 0,
    allHit: evidenceKeys.every((key) => found.has(key)),
    reciprocalRank: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
  };
}

async function retrying<T>(label: string, attempts: number, use: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await use();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${label}: attempt ${attempt} failed (${message.slice(0, 200)}); retrying\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
    }
  }
}

async function parallel<T>(
  items: readonly T[],
  concurrency: number,
  use: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await use(item);
      }
    }),
  );
}

export interface CollectInput {
  store: EvalStore;
  dataset: Dataset;
  tier: TierName;
  system: EvalSystem;
  serverUrl: string;
  checkoutRoot: string;
  /** The code under test, for people: a commit, or a commit plus a hash of uncommitted changes. */
  refSha: string;
  log(message: string): void;
}

const HARNESS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
/**
 * The harness files whose imports decide a run's stored results, beside the
 * System's own entries: the dataset adapters, collection, and the store that saves
 * Packets and results (which harness.ts imports as types only, so its closure
 * would miss it). What a System stores is decided by its `corpusEntries` alone.
 */
export const RUN_ENTRIES = ["harness.ts", "datasets.ts", "store.ts"];
/** Held shared by every collection, and exclusively by clean-up, in each eval database. */
export const CORPUS_LOCK = "lore-eval-corpora";

/**
 * Seed the tier's Units (once per corpus and database) and record one evidence
 * Packet per Case under the code checked out here. Resumes where it stopped.
 *
 * Nothing is reused on trust. The run id hashes the code this checkout actually
 * imports, so a harness or product change gets new Packets even when no revision
 * constant moved. A Unit's Workspace id hashes the code that ingests plus the
 * Unit's records, so two checkouts share a corpus only when they would store the
 * same thing, and a reused Workspace is counted again before it is searched. Each
 * collection writes what it reused and what it paid for into the run's events.
 */
export async function collect(input: CollectInput): Promise<string> {
  const { store, dataset, tier, system } = input;
  const startedAt = new Date();
  const selected = selectTier(await dataset.index(), tier, dataset.tierSizes?.[tier]);
  const corpusCode = codeIdentity(system.corpusEntries, input.checkoutRoot);
  const runCode = codeIdentity(
    [...RUN_ENTRIES.map((entry) => join(HARNESS_DIRECTORY, entry)), ...system.runEntries],
    input.checkoutRoot,
  );
  const engine = realpathSync(Bun.resolveSync("@corespeed/lore-core", HARNESS_DIRECTORY));
  const database = await ensureEvalDatabase({
    serverUrl: input.serverUrl,
    checkoutRoot: input.checkoutRoot,
    dimensions: EMBEDDING_SPACE.dimensions,
    log: input.log,
  });
  const corpusKey = identityHash({
    dataset: dataset.id,
    revision: dataset.revision,
    database: database.name,
    ingest: system.ingestIdentity(),
    code: corpusCode.digest,
  });
  const runId = identityHash({
    code: runCode.digest,
    corpus: corpusKey,
    postgres: database.serverVersion,
    dataset: dataset.id,
    revision: dataset.revision,
    tier,
    cases: sha256([...selected].sort().join("\n")),
    system: system.id,
    retrieval: system.retrievalIdentity(),
  }).slice(0, 16);
  await store.saveRun({
    id: runId,
    refSha: input.refSha,
    dataset: dataset.id,
    tier,
    system: system.id,
    identity: {
      corpusKey,
      runCode: runCode.digest,
      corpusCode: corpusCode.digest,
      database: database.name,
      postgres: database.serverVersion,
      ingest: system.ingestIdentity(),
      retrieval: system.retrievalIdentity(),
    },
    createdAt: startedAt.toISOString(),
  });
  const done = new Set((await store.results(runId)).map((result) => result.caseId));
  const ingested: IngestOutcome = { seeded: 0, reused: 0, verifiedChunks: 0 };
  let searched = 0;
  let failure: string | undefined;
  const record = () =>
    store.saveEvent(runId, {
      kind: "collect",
      at: startedAt.toISOString(),
      detail: {
        refSha: input.refSha,
        checkout: input.checkoutRoot,
        engine,
        runCode: { digest: runCode.digest, files: runCode.files },
        corpusCode: { digest: corpusCode.digest, files: corpusCode.files },
        database: database.name,
        units: ingested,
        cases: { selected: selected.size, alreadyStored: done.size, searched },
        usage: system.usage(),
        seconds: Math.round((Date.now() - startedAt.getTime()) / 100) / 10,
        ...(failure ? { failure } : {}),
      },
    });
  if (done.size === selected.size) {
    await record();
    return runId;
  }
  // Clean-up refuses to run while any collection holds this lock.
  const lock = new pg.Client({ connectionString: database.url });
  await lock.connect();
  await lock.query("SELECT pg_advisory_lock_shared(hashtext($1))", [CORPUS_LOCK]);
  const workspaceIds = new Map<string, string>();
  const context = {
    databaseUrl: database.url,
    workspaceIdFor(unit: EvalUnit) {
      let id = workspaceIds.get(unit.key);
      if (!id) {
        id = unitWorkspaceId(corpusKey, unit);
        workspaceIds.set(unit.key, id);
      }
      return id;
    },
    log: input.log,
  };
  // Units stream in batches, so a full LongMemEval run never holds every haystack.
  let batch: EvalUnit[] = [];
  const flush = async () => {
    const units = batch.filter((unit) => unit.cases.some((evalCase) => !done.has(evalCase.id)));
    batch = [];
    if (!units.length) return;
    await store.touchCorpora(
      database.name,
      units.map((unit) => ({
        workspaceId: context.workspaceIdFor(unit),
        unit: unit.key,
        corpus: corpusKey,
      })),
    );
    const outcome = await system.ingest(context, units);
    ingested.seeded += outcome.seeded;
    ingested.reused += outcome.reused;
    ingested.verifiedChunks += outcome.verifiedChunks;
    const cases = units.flatMap((unit) =>
      unit.cases
        .filter((evalCase) => !done.has(evalCase.id))
        .map((evalCase) => ({ unit, evalCase })),
    );
    await parallel(cases, 8, async ({ unit, evalCase }) => {
      const packet = await retrying(`${evalCase.id} retrieve`, 3, () =>
        system.retrieve(context, unit, evalCase),
      );
      const packetSha = await store.savePacket(packet);
      await store.saveResults(runId, [
        {
          caseId: evalCase.id,
          category: evalCase.category,
          packetSha,
          retrieval: retrievalMetrics(packet.items, evalCase.evidenceKeys),
          latencyMs: packet.latencyMs,
          isolationFailure: packet.items.some((item) => item.id === "tripwire"),
          answerKey: null,
          verdictKey: null,
          score: null,
          grading: null,
        },
      ]);
      if (++searched % 50 === 0) {
        input.log(`${dataset.id}: collected ${done.size + searched}/${selected.size}`);
      }
    });
  };
  try {
    for await (const unit of dataset.units(selected)) {
      batch.push(unit);
      if (batch.length >= 25) await flush();
    }
    await flush();
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 500) : String(error);
    throw error;
  } finally {
    await record();
    await lock.end();
  }
  return runId;
}

/** The reader, scorer, and judge behind a score. Scores compare only under one. */
export function gradingIdentity(
  reader: string,
  scorer: Record<string, unknown>,
  judge: Record<string, unknown> | null,
): string {
  return identityHash({ reader, scorer, judge }).slice(0, 16);
}

/** gemini-3.5-flash list prices on 2026-10-13; output includes thinking. */
const READER_PRICE = { inputPerMillion: 0.75, outputPerMillion: 3.75, outputTokensPerCall: 750 };

export interface AnswerInput {
  store: EvalStore;
  dataset: Dataset;
  runIds: readonly string[];
  /** Bound profiles to use instead of binding `reader` and `judge` by name; for tests. */
  bound?: { reader: BoundReader; judge?: BoundJudge };
  reader: ReaderProfileName;
  judge: JudgeProfileName;
  geminiApiKey: string;
  budgetUsd: number;
  log(message: string): void;
}

/**
 * Answer and grade every collected Case. An identical reader input reuses its
 * answer, and an identical answer its verdict, across all runs, so a comparison
 * pays only for Cases whose evidence changed. Refuses to start past the budget.
 * Each run gets an event saying how many answers and verdicts came from the
 * store and how many were made now.
 */
export async function answer(input: AnswerInput): Promise<void> {
  const { store, dataset } = input;
  const startedAt = new Date();
  const reader: BoundReader =
    input.bound?.reader ?? bindReader(input.reader, dataset, input.geminiApiKey);
  const scorer: Scorer = createScorer(dataset.scorer);
  const judge: BoundJudge | undefined = scorer.needsJudge
    ? (input.bound?.judge ?? bindJudge(input.judge))
    : undefined;
  const grading = gradingIdentity(reader.identityHash, scorer.identity, judge?.identity ?? null);
  // A score from another reader, scorer, or judge is graded again, from cached
  // answers and verdicts where they exist, so one comparison never mixes graders.
  // A gate whose base and candidate share one run passes it twice; answer it once.
  const runIds = [...new Set(input.runIds)];
  const pending = (
    await Promise.all(
      runIds.map(async (runId) =>
        (
          await store.results(runId)
        )
          .filter((result) => result.score === null || result.grading !== grading)
          .map((result) => ({ runId, result })),
      ),
    )
  ).flat();
  if (!pending.length) return;
  const cases = new Map<string, EvalCase>();
  for await (const unit of dataset.units(new Set(pending.map(({ result }) => result.caseId)))) {
    for (const evalCase of unit.cases) cases.set(evalCase.id, evalCase);
  }
  const packets = await store.packets(pending.map(({ result }) => result.packetSha));
  const prepared = pending.map(({ runId, result }) => {
    const evalCase = cases.get(result.caseId);
    if (!evalCase) throw new Error(`${result.caseId} is no longer in ${dataset.id}`);
    const evidence = (packets.get(result.packetSha) ?? []).map(({ id, text }) => ({ id, text }));
    const rendered = reader.render(evalCase.readerQuestion, evidence);
    return {
      runId,
      result,
      evalCase,
      evidence,
      answerKey: sha256(`${reader.identityHash}\u0000${rendered}`),
      rendered,
    };
  });
  const storedAnswers = await store.answers(prepared.map((item) => item.answerKey));
  const uncached = new Map(
    prepared
      .filter((item) => !storedAnswers.has(item.answerKey))
      .map((item) => [item.answerKey, item]),
  );
  const estimate = [...uncached.values()].reduce(
    (total, item) =>
      total +
      ((item.rendered.length / 4) * READER_PRICE.inputPerMillion +
        READER_PRICE.outputTokensPerCall * READER_PRICE.outputPerMillion) /
        1_000_000,
    0,
  );
  input.log(
    `${dataset.id}: ${prepared.length} cases to grade, ${uncached.size} new reader calls, about $${estimate.toFixed(2)}`,
  );
  if (estimate > input.budgetUsd) {
    throw new Error(
      `Estimated reader cost $${estimate.toFixed(2)} exceeds --budget-usd ${input.budgetUsd}`,
    );
  }
  const readerTokens = { input: 0, output: 0 };
  await parallel([...uncached.values()], 12, async (item) => {
    const response = await retrying(`${item.evalCase.id} reader`, 5, () =>
      reader.answer(item.evalCase.readerQuestion, item.evidence),
    );
    readerTokens.input += response.inputTokens ?? 0;
    readerTokens.output += response.outputTokens ?? 0;
    // The stored answer, which is another sandbox's when it saved this key first.
    const stored = await store.saveAnswer(item.answerKey, {
      answer: response.text,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
    storedAnswers.set(item.answerKey, stored);
  });
  // Grade each distinct answer once: base and candidate often share one.
  const graded = prepared.map((item) => {
    const stored = storedAnswers.get(item.answerKey);
    if (!stored) throw new Error(`${item.evalCase.id}: answer missing after reading`);
    const verdictKey = identityHash({
      scorer: scorer.identity,
      judge: judge?.identity ?? null,
      caseId: item.evalCase.id,
      question: item.evalCase.question,
      gold: item.evalCase.answer,
      answer: stored.answer,
    });
    return { ...item, answerText: stored.answer, verdictKey };
  });
  const storedVerdicts = await store.verdicts(graded.map((item) => item.verdictKey));
  const ungraded = new Map(
    graded
      .filter((item) => !storedVerdicts.has(item.verdictKey))
      .map((item) => [item.verdictKey, item]),
  );
  let gradedCount = 0;
  await parallel([...ungraded.values()], judge ? 12 : 32, async (item) => {
    const verdict = await retrying(`${item.evalCase.id} grade`, 5, () =>
      scorer.grade(item.evalCase, item.answerText, judge),
    );
    storedVerdicts.set(item.verdictKey, await store.saveVerdict(item.verdictKey, verdict));
    if (++gradedCount % 100 === 0)
      input.log(`${dataset.id}: graded ${gradedCount}/${ungraded.size}`);
  });
  const perRun = new Map<
    string,
    { answersFromStore: number; answersNew: number; verdictsFromStore: number; verdictsNew: number }
  >();
  const updates = new Map<string, CaseResult[]>();
  for (const item of graded) {
    const verdict = storedVerdicts.get(item.verdictKey);
    if (!verdict) throw new Error(`${item.evalCase.id}: verdict missing after grading`);
    const list = updates.get(item.runId) ?? [];
    list.push({
      ...item.result,
      answerKey: item.answerKey,
      verdictKey: item.verdictKey,
      score: verdict.score,
      grading,
    });
    updates.set(item.runId, list);
    const counts = perRun.get(item.runId) ?? {
      answersFromStore: 0,
      answersNew: 0,
      verdictsFromStore: 0,
      verdictsNew: 0,
    };
    if (uncached.has(item.answerKey)) counts.answersNew += 1;
    else counts.answersFromStore += 1;
    if (ungraded.has(item.verdictKey)) counts.verdictsNew += 1;
    else counts.verdictsFromStore += 1;
    perRun.set(item.runId, counts);
  }
  for (const [runId, list] of updates) await store.saveResults(runId, list);
  for (const [runId, counts] of perRun) {
    await store.saveEvent(runId, {
      kind: "answer",
      at: startedAt.toISOString(),
      detail: {
        reader: input.reader,
        scorer: dataset.scorer,
        judge: judge ? input.judge : null,
        grading,
        cases: counts,
        // Shared by every run in this call: distinct inputs read, answers graded.
        readerCalls: uncached.size,
        gradeCalls: ungraded.size,
        readerTokens,
        estimatedReaderUsd: Math.round(estimate * 100) / 100,
      },
    });
  }
}

export interface RunSummary {
  runId: string;
  refSha: string;
  dataset: string;
  tier: string;
  cases: number;
  answered: number;
  isolationFailures: number;
  retrieval: { anyHit: number; allHit: number; mrr: number; withEvidence: number };
  score: { mean: number | null; interval95: [number, number] | null };
  categories: Record<string, { cases: number; score: number | null; allHit: number | null }>;
  latencyMs: { p50: number; p95: number };
  readerTokens: { input: number; output: number };
  /** The gradings behind the run's scores; one, once it is answered. */
  gradings: string[];
  /** Every step that touched the run, oldest first. */
  events: RunEvent[];
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export async function summarize(
  store: EvalStore,
  runId: string,
  binary: boolean,
): Promise<RunSummary> {
  const run = await store.run(runId);
  if (!run) throw new Error(`Run ${runId} is not in the store`);
  const results = await store.results(runId);
  const withEvidence = results.filter((result) => result.retrieval.gold > 0);
  const scored = results.filter((result) => result.score !== null);
  const scores = scored.map((result) => result.score ?? 0);
  const categories: RunSummary["categories"] = {};
  for (const category of [...new Set(results.map((result) => result.category))].sort()) {
    const inCategory = results.filter((result) => result.category === category);
    const categoryScores = inCategory.flatMap((result) =>
      result.score === null ? [] : [result.score],
    );
    categories[category] = {
      cases: inCategory.length,
      score: categoryScores.length ? average(categoryScores) : null,
      allHit: inCategory.some((result) => result.retrieval.gold > 0)
        ? average(
            inCategory
              .filter((result) => result.retrieval.gold > 0)
              .map((result) => Number(result.retrieval.allHit)),
          )
        : null,
    };
  }
  const answers = [
    ...(
      await store.answers(scored.flatMap((result) => (result.answerKey ? [result.answerKey] : [])))
    ).values(),
  ];
  return {
    runId,
    refSha: run.refSha,
    dataset: run.dataset,
    tier: run.tier,
    cases: results.length,
    answered: scored.length,
    isolationFailures: results.filter((result) => result.isolationFailure).length,
    retrieval: {
      anyHit: average(withEvidence.map((result) => Number(result.retrieval.anyHit))),
      allHit: average(withEvidence.map((result) => Number(result.retrieval.allHit))),
      mrr: average(withEvidence.map((result) => result.retrieval.reciprocalRank)),
      withEvidence: withEvidence.length,
    },
    score: {
      mean: scores.length ? average(scores) : null,
      interval95: scores.length
        ? binary
          ? wilson95(scores.filter((score) => score === 1).length, scores.length)
          : null
        : null,
    },
    categories,
    latencyMs: {
      p50: percentile(
        results.map((result) => result.latencyMs),
        50,
      ),
      p95: percentile(
        results.map((result) => result.latencyMs),
        95,
      ),
    },
    readerTokens: {
      input: answers.reduce((sum, stored) => sum + (stored.inputTokens ?? 0), 0),
      output: answers.reduce((sum, stored) => sum + (stored.outputTokens ?? 0), 0),
    },
    gradings: [
      ...new Set(scored.flatMap((result) => (result.grading ? [result.grading] : []))),
    ].sort(),
    events: await store.events(runId),
  };
}

export interface RunComparison {
  dataset: string;
  base: RunSummary;
  candidate: RunSummary;
  /** Answer quality under the dataset's scorer, when both runs were answered. */
  answers: GateResult | null;
  /** Every gold record retrieved, paired per case. */
  retrieval: GateResult;
  /** Cases whose evidence packet differs between the two runs. */
  changedPackets: number;
}

export async function compareRuns(
  store: EvalStore,
  baseRunId: string,
  candidateRunId: string,
  binary: boolean,
): Promise<RunComparison> {
  const base = new Map((await store.results(baseRunId)).map((result) => [result.caseId, result]));
  const candidate = await store.results(candidateRunId);
  const pairs = candidate.flatMap((result) => {
    const other = base.get(result.caseId);
    return other ? [{ base: other, candidate: result }] : [];
  });
  if (pairs.length !== candidate.length || pairs.length !== base.size) {
    throw new Error(
      "The two runs do not cover the same cases; compare runs of one dataset and tier",
    );
  }
  const gradings = new Set(
    pairs.flatMap(({ base: left, candidate: right }) =>
      [left, right].flatMap((result) => (result.score === null ? [] : [String(result.grading)])),
    ),
  );
  if (gradings.has("null")) {
    throw new Error(
      "A run holds scores from before gradings were recorded; answer it again (free from the store) before comparing",
    );
  }
  if (gradings.size > 1) {
    throw new Error(
      `The two runs were graded under ${gradings.size} reader/scorer/judge combinations; answer both under one before comparing`,
    );
  }
  const isolation = candidate.filter((result) => result.isolationFailure).length;
  const scorePairs: PairedScore[] = pairs.flatMap(({ base: left, candidate: right }) =>
    left.score === null || right.score === null
      ? []
      : [
          {
            caseId: right.caseId,
            category: right.category,
            base: left.score,
            candidate: right.score,
          },
        ],
  );
  const retrievalPairs: PairedScore[] = pairs
    .filter(({ candidate: right }) => right.retrieval.gold > 0)
    .map(({ base: left, candidate: right }) => ({
      caseId: right.caseId,
      category: right.category,
      base: Number(left.retrieval.allHit),
      candidate: Number(right.retrieval.allHit),
    }));
  const summaryBinary = binary;
  return {
    dataset: (await store.run(candidateRunId))?.dataset ?? "",
    base: await summarize(store, baseRunId, summaryBinary),
    candidate: await summarize(store, candidateRunId, summaryBinary),
    answers: scorePairs.length === pairs.length ? gate(scorePairs, binary, isolation) : null,
    retrieval: gate(retrievalPairs, true, isolation),
    changedPackets: pairs.filter(
      ({ base: left, candidate: right }) => left.packetSha !== right.packetSha,
    ).length,
  };
}

export function tierAnswers(tier: TierName): boolean {
  return TIERS[tier].answer;
}

export type { CaseResult };
