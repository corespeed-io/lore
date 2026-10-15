/**
 * Lore eval harness. Measure a change on fixed, stratified slices of public
 * memory benchmarks through the product's own code path, and compare it with a
 * base ref under one pre-registered rule.
 *
 *   bun tools/evaluation/harness/run-eval.ts run  --dataset locomo --tier smoke
 *   bun tools/evaluation/harness/run-eval.ts gate --base origin/main --dataset longmemeval-s,locomo --tier standard
 *   bun tools/evaluation/harness/run-eval.ts report --run <id> [--vs <id>]
 *   bun tools/evaluation/harness/run-eval.ts gc [--older-than-days 14]
 *   bun tools/evaluation/harness/run-eval.ts warm --from-database <name>
 *
 * Environment: LORE_EVAL_SERVER_URL (a PostgreSQL server the harness may create
 * lore_eval_bench_* databases on), GEMINI_API_KEY (embeddings and reader), and
 * Everything shared lives on that server: the store database (lore_eval_store),
 * and one corpus database per migration chain. Point every sandbox at one server
 * and they share embeddings, answers, verdicts, runs, and seeded corpora.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { DATASETS, type DatasetName, isDatasetName } from "./datasets";
import {
  answer,
  CORPUS_LOCK,
  collect,
  compareRuns,
  type RunComparison,
  type RunSummary,
  summarize,
  tierAnswers,
} from "./harness";
import { sha256 } from "./hash";
import {
  isJudgeProfile,
  isReaderProfile,
  type JudgeProfileName,
  type ReaderProfileName,
} from "./profiles";
import { createScorer } from "./scorers";
import { EvalStore, type RunEvent } from "./store";
import { memorySearchSystem } from "./systems";
import { isTier, type TierName } from "./tiers";
import { warmFromDatabase } from "./warm";

const log = (message: string) => process.stderr.write(`[eval] ${message}\n`);
const checkoutRoot = process.cwd();

function git(args: string[], cwd = checkoutRoot): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The working tree's identity: HEAD, plus a hash of any uncommitted change. */
function worktreeIdentity(): string {
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (!status) return head;
  const untracked = status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3))
    .sort()
    .map((path) => `${path}\u0000${readFileSync(join(checkoutRoot, path), "utf8")}`)
    .join("\u0001");
  return `${head}+${sha256(`${git(["diff", "HEAD"])}\u0001${untracked}`).slice(0, 12)}`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dataset: { type: "string" },
    tier: { type: "string", default: "smoke" },
    ref: { type: "string", default: "worktree" },
    base: { type: "string" },
    candidate: { type: "string", default: "worktree" },
    reader: { type: "string", default: "gemini-3.5-flash" },
    judge: { type: "string", default: "gpt-5.6-sol" },
    "budget-usd": { type: "string", default: "10" },
    "ref-sha": { type: "string" },
    run: { type: "string" },
    vs: { type: "string" },
    "older-than-days": { type: "string", default: "14" },
    "from-database": { type: "string" },
  },
});
const command = positionals[0];
const openStore = () => EvalStore.open(required("LORE_EVAL_SERVER_URL"), log);

function datasetsOption(): DatasetName[] {
  const names = (values.dataset ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) throw new Error(`--dataset needs one of ${Object.keys(DATASETS).join(", ")}`);
  for (const name of names) {
    if (!isDatasetName(name)) throw new Error(`Unknown dataset ${name}`);
  }
  return names as DatasetName[];
}
function tierOption(): TierName {
  if (!isTier(values.tier)) throw new Error("--tier must be smoke, standard, or full");
  return values.tier;
}
function profiles(): { reader: ReaderProfileName; judge: JudgeProfileName; budgetUsd: number } {
  if (!isReaderProfile(values.reader)) throw new Error(`Unknown reader ${values.reader}`);
  if (!isJudgeProfile(values.judge)) throw new Error(`Unknown judge ${values.judge}`);
  const budgetUsd = Number(values["budget-usd"]);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0)
    throw new Error("--budget-usd must be a number");
  return { reader: values.reader, judge: values.judge, budgetUsd };
}

/** Collect in this checkout, under the code it holds. */
async function collectHere(dataset: DatasetName, tier: TierName, refSha: string): Promise<string> {
  const store = await openStore();
  const system = memorySearchSystem({ store, geminiApiKey: required("GEMINI_API_KEY") });
  try {
    const runId = await collect({
      store,
      dataset: DATASETS[dataset](),
      tier,
      system,
      serverUrl: required("LORE_EVAL_SERVER_URL"),
      checkoutRoot,
      refSha,
      log,
    });
    const event = (await store.events(runId)).filter((entry) => entry.kind === "collect").at(-1);
    if (event) log(`${dataset}: ${provenance(event)}`);
    return runId;
  } finally {
    await system.close();
    await store.close();
  }
}

/**
 * Collect at a git ref: a detached worktree of that commit runs the product code,
 * with this checkout's harness copied over it, so a ref from before the harness
 * existed can still be measured. Datasets are shared through a symlink.
 */
async function collectAt(ref: string, dataset: DatasetName, tier: TierName): Promise<string> {
  if (ref === "worktree") return collectHere(dataset, tier, worktreeIdentity());
  const sha = git(["rev-parse", `${ref}^{commit}`]);
  const directory = join(homedir(), ".cache/lore-eval/worktrees", sha);
  if (!existsSync(directory)) {
    mkdirSync(join(homedir(), ".cache/lore-eval/worktrees"), { recursive: true });
    git(["worktree", "add", "--detach", directory, sha]);
  }
  if (!existsSync(join(directory, "node_modules"))) {
    log(`installing dependencies for ${sha.slice(0, 12)}`);
    const installed = spawnSync("bun", ["install", "--frozen-lockfile"], {
      cwd: directory,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (installed.status !== 0) throw new Error(`bun install failed in ${directory}`);
  }
  const harness = join(directory, "tools/evaluation/harness");
  rmSync(harness, { recursive: true, force: true });
  cpSync(join(checkoutRoot, "tools/evaluation/harness"), harness, { recursive: true });
  const datasets = join(directory, "evaluation/datasets");
  if (!existsSync(datasets)) {
    // The target must exist: a fresh sandbox downloads datasets through this link.
    mkdirSync(join(checkoutRoot, "evaluation/datasets"), { recursive: true });
    mkdirSync(join(directory, "evaluation"), { recursive: true });
    symlinkSync(join(checkoutRoot, "evaluation/datasets"), datasets);
  }
  log(`collecting ${dataset} ${tier} at ${ref} (${sha.slice(0, 12)})`);
  const collected = spawnSync(
    "bun",
    [
      "--no-env-file",
      "tools/evaluation/harness/run-eval.ts",
      "collect",
      "--dataset",
      dataset,
      "--tier",
      tier,
      "--ref-sha",
      sha,
    ],
    { cwd: directory, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const runId = collected.stdout.match(/^RUN (\w+)$/m)?.[1];
  if (collected.status !== 0 || !runId) throw new Error(`Collecting at ${ref} failed`);
  return runId;
}

const percent = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const count = (value: number | undefined) => (value ?? 0).toLocaleString("en-US");
const home = (path: string) => path.replace(homedir(), "~");
const signed = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;

/** One line saying where a step ran, what it reused, and what it paid for. */
function provenance(event: RunEvent): string {
  if (event.kind === "collect") {
    const { detail } = event;
    const own = detail.engine.startsWith(`${detail.checkout}/`)
      ? "its own engine"
      : `engine ${home(detail.engine)}`;
    return [
      `collect ${event.at} · ${detail.refSha.slice(0, 25)} in ${home(detail.checkout)} (${own})`,
      `code ${detail.runCode.digest.slice(0, 12)} (${detail.runCode.files} files), corpus code ${detail.corpusCode.digest.slice(0, 12)}`,
      `units ${count(detail.units.seeded)} seeded, ${count(detail.units.reused)} reused (${count(detail.units.verifiedChunks)} chunks checked for vectors)`,
      `cases ${count(detail.cases.searched)} searched, ${count(detail.cases.alreadyStored)} already stored`,
      `embeddings ${count(detail.usage.embeddingsFromStore)} from store, ${count(detail.usage.embeddingsNew)} new in ${count(detail.usage.embeddingRequests)} requests`,
      `${detail.seconds} s${detail.failure ? ` · FAILED: ${detail.failure}` : ""}`,
    ].join(" · ");
  }
  const { detail } = event;
  return [
    `answer ${event.at} · reader ${detail.reader}${detail.judge ? `, judge ${detail.judge}` : ""} (grading ${detail.grading ?? "unrecorded"})`,
    `answers ${count(detail.cases.answersFromStore)} from store, ${count(detail.cases.answersNew)} new`,
    `verdicts ${count(detail.cases.verdictsFromStore)} from store, ${count(detail.cases.verdictsNew)} new`,
    `this call: ${count(detail.readerCalls)} reader calls (~$${detail.estimatedReaderUsd}), ${count(detail.gradeCalls)} gradings`,
  ].join(" · ");
}

function summaryMarkdown(summary: RunSummary): string {
  const lines = [
    `### ${summary.dataset} · ${summary.tier} · run ${summary.runId} · ${summary.refSha.slice(0, 12)}`,
    "",
    `- Cases: ${summary.cases}; isolation failures: ${summary.isolationFailures}`,
    `- Retrieval (${summary.retrieval.withEvidence} cases with gold): all gold ${percent(summary.retrieval.allHit)}, any gold ${percent(summary.retrieval.anyHit)}, MRR ${summary.retrieval.mrr.toFixed(3)}`,
    `- Search latency: p50 ${summary.latencyMs.p50.toFixed(0)} ms, p95 ${summary.latencyMs.p95.toFixed(0)} ms`,
  ];
  if (summary.score.mean !== null) {
    const interval = summary.score.interval95
      ? ` (95% ${percent(summary.score.interval95[0])}–${percent(summary.score.interval95[1])})`
      : "";
    lines.push(
      `- Answer score: ${percent(summary.score.mean)}${interval} over ${summary.answered} cases, grading ${summary.gradings.join(" + ") || "unrecorded"}; reader input ${Math.round(summary.readerTokens.input / Math.max(1, summary.answered))} tokens per case`,
    );
  }
  lines.push("- Provenance:", ...summary.events.map((event) => `  - ${provenance(event)}`));
  lines.push(
    "",
    "| Category | Cases | All gold retrieved | Answer score |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const [category, entry] of Object.entries(summary.categories)) {
    lines.push(
      `| ${category} | ${entry.cases} | ${percent(entry.allHit)} | ${percent(entry.score)} |`,
    );
  }
  return lines.join("\n");
}

function comparisonMarkdown(comparison: RunComparison): string {
  const sections = [`## ${comparison.dataset}`, ""];
  const describe = (label: string, result: NonNullable<RunComparison["answers"]>) => {
    const { overall } = result;
    const icon = result.verdict === "improved" ? "✓" : result.verdict === "regressed" ? "✕" : "=";
    sections.push(
      `**${label}: ${icon} ${result.verdict}** — ${percent(overall.baseMean)} → ${percent(overall.candidateMean)} (${signed(overall.delta)} points, 95% [${signed(overall.interval95[0])}, ${signed(overall.interval95[1])}]` +
        (overall.mcnemarP === null
          ? ")"
          : `; ${overall.wins} fixed / ${overall.losses} broken, McNemar p = ${overall.mcnemarP.toPrecision(2)})`) +
        `. ${result.reasons.join("; ")}.`,
      "",
      "| Category | Base | Candidate | Δ | Fixed / broken |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...Object.entries(result.categories).map(
        ([category, entry]) =>
          `| ${category} | ${percent(entry.baseMean)} | ${percent(entry.candidateMean)} | ${signed(entry.delta)} | ${entry.wins} / ${entry.losses} |`,
      ),
      "",
    );
  };
  if (comparison.base.runId === comparison.candidate.runId) {
    sections.push(
      "Base and candidate import byte-identical code, so they share one run. Nothing below can differ.",
      "",
    );
  }
  if (comparison.answers) describe("Answers", comparison.answers);
  describe("Retrieval (all gold retrieved)", comparison.retrieval);
  sections.push(
    `${comparison.changedPackets} of ${comparison.candidate.cases} evidence packets changed.`,
    "",
    "<details><summary>Run details</summary>",
    "",
    summaryMarkdown(comparison.base),
    "",
    ...(comparison.base.runId === comparison.candidate.runId
      ? []
      : [summaryMarkdown(comparison.candidate), ""]),
    "</details>",
  );
  return sections.join("\n");
}

function writeReport(name: string, markdown: string, json: unknown): void {
  const directory = resolve("evaluation/results/harness/reports");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), `${markdown}\n`);
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(json, null, 2));
  log(`report: ${join(directory, `${name}.md`)}`);
}

async function answerRuns(dataset: DatasetName, runIds: string[], tier: TierName) {
  if (!tierAnswers(tier)) return;
  const { reader, judge, budgetUsd } = profiles();
  const store = await openStore();
  try {
    await answer({
      store,
      dataset: DATASETS[dataset](),
      runIds,
      reader,
      judge,
      geminiApiKey: required("GEMINI_API_KEY"),
      budgetUsd,
      log,
    });
  } finally {
    await store.close();
  }
}

if (command === "collect") {
  // Internal: run by collectAt inside a ref's worktree.
  const [dataset] = datasetsOption();
  if (!dataset) throw new Error("collect takes one --dataset");
  const runId = await collectHere(dataset, tierOption(), values["ref-sha"] ?? worktreeIdentity());
  process.stdout.write(`RUN ${runId}\n`);
} else if (command === "run") {
  const tier = tierOption();
  const sections: string[] = [];
  const runs: Record<string, string> = {};
  for (const dataset of datasetsOption()) {
    const runId = await collectAt(values.ref ?? "worktree", dataset, tier);
    await answerRuns(dataset, [runId], tier);
    const store = await openStore();
    sections.push(
      summaryMarkdown(
        await summarize(store, runId, createScorer(DATASETS[dataset]().scorer).binary),
      ),
    );
    await store.close();
    runs[dataset] = runId;
  }
  const markdown = sections.join("\n\n");
  process.stdout.write(`${markdown}\n`);
  writeReport(`run-${Object.values(runs).join("-")}`, markdown, runs);
} else if (command === "gate") {
  const tier = tierOption();
  if (!values.base) throw new Error("gate needs --base <git ref>");
  const comparisons: RunComparison[] = [];
  for (const dataset of datasetsOption()) {
    const baseRun = await collectAt(values.base, dataset, tier);
    const candidateRun = await collectAt(values.candidate ?? "worktree", dataset, tier);
    await answerRuns(dataset, [baseRun, candidateRun], tier);
    const store = await openStore();
    try {
      comparisons.push(
        await compareRuns(
          store,
          baseRun,
          candidateRun,
          createScorer(DATASETS[dataset]().scorer).binary,
        ),
      );
    } finally {
      await store.close();
    }
  }
  const verdicts = comparisons.map(
    (comparison) => (comparison.answers ?? comparison.retrieval).verdict,
  );
  const overall = verdicts.includes("regressed")
    ? "regressed"
    : verdicts.includes("improved")
      ? "improved"
      : "no-evidence";
  const markdown = [
    `# Eval gate: ${values.candidate} vs ${values.base} · ${tier} · ${overall}`,
    "",
    ...comparisons.map(comparisonMarkdown),
  ].join("\n");
  process.stdout.write(`${markdown}\n`);
  writeReport(
    `gate-${comparisons.map((comparison) => comparison.candidate.runId).join("-")}`,
    markdown,
    comparisons,
  );
  process.exitCode = overall === "regressed" ? 1 : 0;
} else if (command === "report") {
  if (!values.run) throw new Error("report needs --run <id>");
  const store = await openStore();
  try {
    const run = await store.run(values.run);
    if (!run) throw new Error(`Unknown run ${values.run}`);
    const dataset = run.dataset as DatasetName;
    const binary = createScorer(DATASETS[dataset]().scorer).binary;
    process.stdout.write(
      `${values.vs ? comparisonMarkdown(await compareRuns(store, values.vs, values.run, binary)) : summaryMarkdown(await summarize(store, values.run, binary))}\n`,
    );
  } finally {
    await store.close();
  }
} else if (command === "gc") {
  // Drop eval Workspaces no run has used lately, then databases left with none.
  const days = Number(values["older-than-days"]);
  if (!Number.isFinite(days) || days < 0) throw new Error("--older-than-days must be a number");
  const since = new Date(Date.now() - days * 86_400_000);
  const serverUrl = required("LORE_EVAL_SERVER_URL");
  const server = new pg.Client({ connectionString: serverUrl });
  await server.connect();
  const store = await openStore();
  try {
    const databases = await server.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'lore\\_eval\\_bench\\_%' ORDER BY datname",
    );
    for (const { datname } of databases.rows) {
      const url = new URL(serverUrl);
      url.pathname = `/${datname}`;
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      let remaining = -1;
      try {
        const locked = await client.query<{ ok: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
          [CORPUS_LOCK],
        );
        if (!locked.rows[0]?.ok) {
          log(`${datname}: a collection is running there; skipped`);
          continue;
        }
        const keep = await store.corporaUsedSince(datname, since);
        const workspaces = await client.query<{ id: string }>(
          "SELECT id FROM workspaces WHERE name LIKE 'eval ready %' OR name LIKE 'eval building %'",
        );
        const stale = workspaces.rows.map((row) => row.id).filter((id) => !keep.has(id));
        for (const id of stale) await client.query("DELETE FROM workspaces WHERE id = $1", [id]);
        await store.forgetCorpora(datname, stale);
        remaining = Number(
          (await client.query<{ n: string }>("SELECT count(*)::text AS n FROM workspaces")).rows[0]
            ?.n ?? 0,
        );
        log(
          `${datname}: removed ${stale.length} of ${workspaces.rows.length} eval Workspaces; ${remaining} left`,
        );
      } finally {
        await client.end();
      }
      if (remaining === 0) {
        await server.query(`DROP DATABASE "${datname}"`);
        log(`${datname}: dropped, it held no Workspace`);
      }
    }
  } finally {
    await store.close();
    await server.end();
  }
} else if (command === "warm") {
  // Copy vectors another Lore database on the same server holds, read-only.
  const name = values["from-database"];
  if (!name) throw new Error("warm needs --from-database <name> on the eval server");
  const source = new URL(required("LORE_EVAL_SERVER_URL"));
  source.pathname = `/${name}`;
  const client = new pg.Client({
    connectionString: source.toString(),
    options: "-c default_transaction_read_only=on -c statement_timeout=120000",
  });
  await client.connect();
  const store = await openStore();
  try {
    const report = await warmFromDatabase({
      source: (text, params) => client.query(text, params),
      store,
      log,
    });
    log(
      `warm from ${name}: read ${report.read.toLocaleString("en-US")} vectors, added ${report.added.toLocaleString("en-US")}, compared ${report.compared.toLocaleString("en-US")} the store already held (largest difference ${report.maxDifference}), ${report.seconds} s`,
    );
  } finally {
    await store.close();
    await client.end();
  }
} else {
  process.stderr.write(
    "Usage: run-eval.ts run|gate|report|gc|warm — see the header of tools/evaluation/harness/run-eval.ts\n",
  );
  process.exitCode = 2;
}
