/**
 * PROTOTYPE — temporal joint Memory + Code evaluation over two real Lore commits.
 *
 * Question: does the selective grouped-evidence state model still help when Code
 * comes from trusted Git objects and a fixed reader must produce cited answers?
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import type { ActorContext } from "../src/lib/actor-context";
import {
  type CodeEvidenceAssessment,
  createCodeEvidenceModule,
  type MemoryCodeEvidence,
} from "../src/lib/code-evidence";
import { type CodeArtifact, createCodeIndexModule } from "../src/lib/code-index";
import { createContextRetrievalModule } from "../src/lib/context-retrieval";
import type { PostgresDatabase } from "../src/lib/db";
import {
  assembleGroupedJointEvidence,
  type GroupedJointEvidencePacket,
  type JointAnchorEvidence,
  type JointCodeEvidence,
  type JointEvidenceRoute,
  type JointMemoryEvidence,
  planJointEvidenceRoute,
  prioritizeAnchoredMemories,
} from "../src/lib/joint-memory-code-prototype";
import {
  buildJointReaderPrompt,
  type JointReaderExpectation,
  type JointReaderOutput,
  type JointReaderScore,
  scoreJointReaderOutput,
} from "../src/lib/joint-memory-code-reader-prototype";
import { createMemoryModule, type Memory } from "../src/lib/memory";

const USER_ID = "10000000-0000-4000-8000-000000000091";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000091";
const REPOSITORY_KEY = "evaluation/lore-real-temporal-v1";
const BASE_COMMIT = "f6a248c50730e5af99e8901dc3382e0a8218fedd";
const TARGET_COMMIT = "2e3dbf00a1c7a2eccccb0ea6cbdcf710e15fefc2";
const migrationsUrl = new URL("../db/migrations/", import.meta.url);

type RealVariantId = "always-on-union" | "code-only" | "selective-final";

interface RealVariant {
  id: RealVariantId;
  evaluateReader: boolean;
  forcedRoute: "both" | "code-only" | null;
  expandAnchors: boolean;
  assessAnchors: boolean;
  prioritizeAnchors: boolean;
}

interface RealCase {
  id: string;
  query: string;
  memoryQuery: string;
  codeQuery: string;
  expectedRoute: JointEvidenceRoute;
  expectedMemoryKeys: string[];
  expectedCodePaths: string[];
  expectedAnchorState?: MemoryCodeEvidence["validationState"];
  reader: JointReaderExpectation;
}

interface CaseRun {
  case: RealCase;
  packet: GroupedJointEvidencePacket;
  packetChecks: {
    anchorState: boolean | null;
    codeRecall: boolean;
    memoryRecall: boolean;
    route: boolean;
  };
  reader: {
    output: JointReaderOutput;
    score: JointReaderScore;
  } | null;
}

const VARIANTS: RealVariant[] = [
  {
    id: "code-only",
    evaluateReader: false,
    forcedRoute: "code-only",
    expandAnchors: false,
    assessAnchors: false,
    prioritizeAnchors: false,
  },
  {
    id: "always-on-union",
    evaluateReader: true,
    forcedRoute: "both",
    expandAnchors: false,
    assessAnchors: false,
    prioritizeAnchors: false,
  },
  {
    id: "selective-final",
    evaluateReader: true,
    forcedRoute: null,
    expandAnchors: true,
    assessAnchors: true,
    prioritizeAnchors: true,
  },
];

function optionalArgument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value?.trim()) throw new Error(`--${name} requires a value`);
  return value;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const found = new Map<string, T>();
  for (const value of values) found.set(key(value), value);
  return [...found.values()];
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function rate(values: readonly boolean[]): number {
  return values.length ? rounded(values.filter(Boolean).length / values.length) : 1;
}

function codeEvidence(artifact: CodeArtifact, matchText?: string | null): JointCodeEvidence {
  return {
    artifactId: artifact.id,
    commitOid: artifact.commitOid,
    content: artifact.content,
    contentSha256: artifact.contentSha256,
    matchText,
    path: artifact.path,
    score: artifact.score,
    symbol: artifact.symbol,
  };
}

function citedSymbolSearchText(evidence: MemoryCodeEvidence): string | null {
  if (!evidence.citedSymbolKey) return null;
  const identity = evidence.citedSymbolKey.slice(evidence.citedSymbolKey.indexOf("#") + 1);
  const separator = identity.indexOf(":");
  return separator < 0 ? identity : identity.slice(separator + 1);
}

function anchorEvidence(
  evidence: MemoryCodeEvidence,
  assessment: CodeEvidenceAssessment | null = null,
): JointAnchorEvidence {
  return {
    id: evidence.id,
    memoryId: evidence.memoryId,
    relationship: evidence.relationship,
    localState: assessment?.validationState ?? evidence.validationState,
    citedCommitOid: evidence.citedCommitOid,
    citedPath: evidence.citedPath,
    citedDeclarationChunkOrdinal: evidence.citedDeclarationChunkOrdinal,
    citedDeclarationContextSha256: evidence.citedDeclarationContextSha256,
    validatedCommitOid: assessment ? assessment.validatedCommitOid : evidence.validatedCommitOid,
    validatedPath: assessment ? assessment.validatedPath : evidence.validatedPath,
  };
}

function anchorMatchesExpectedState(
  anchor: JointAnchorEvidence,
  state: MemoryCodeEvidence["validationState"],
): boolean {
  if (anchor.localState !== state) return false;
  if (state === "unverifiable") {
    return anchor.validatedCommitOid === null && anchor.validatedPath === null;
  }
  if (state === "ambiguous" || state === "deleted") {
    return anchor.validatedCommitOid === TARGET_COMMIT && anchor.validatedPath === null;
  }
  return anchor.validatedCommitOid === TARGET_COMMIT && anchor.validatedPath !== null;
}

async function createDatabase(dataDir: string | null): Promise<{
  actor: ActorContext;
  database: PostgresDatabase;
  postgres: PGlite;
}> {
  const postgres = dataDir
    ? new PGlite(dataDir, { extensions: { pg_trgm, vector } })
    : new PGlite({ extensions: { pg_trgm, vector } });
  await postgres.waitReady;
  const schema = await postgres.query<{ users: string | null }>(
    "SELECT to_regclass('public.users')::text AS users",
  );
  if (!schema.rows[0]?.users) {
    const migrationIds = (await readdir(migrationsUrl))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const migrationId of migrationIds) {
      await postgres.exec(await readFile(new URL(migrationId, migrationsUrl), "utf8"));
    }
    await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, $2)", [
      USER_ID,
      "Real Temporal Evaluation",
    ]);
    await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [
      WORKSPACE_ID,
      "Real Temporal Evaluation",
    ]);
    await postgres.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [WORKSPACE_ID, USER_ID],
    );
  } else {
    await postgres.query("DELETE FROM memories WHERE workspace_id = $1", [WORKSPACE_ID]);
  }
  await postgres.exec("SET ROLE lore_app");
  const database: PostgresDatabase = {
    transaction: (use) =>
      postgres.transaction(async (transaction) => {
        await transaction.query("SET LOCAL ROLE lore_app");
        return use({ query: (sql, params) => transaction.query(sql, params) });
      }),
  };
  return { actor: { workspaceId: WORKSPACE_ID, userId: USER_ID }, database, postgres };
}

async function findArtifact(input: {
  actor: ActorContext;
  code: ReturnType<typeof createCodeIndexModule>;
  commitOid: string;
  query: string;
  path: string;
  contentIncludes: string;
}): Promise<CodeArtifact> {
  const candidates = await input.code.search(input.actor, {
    repositoryKey: REPOSITORY_KEY,
    commitOid: input.commitOid,
    query: input.query,
    limit: 100,
  });
  const artifact = candidates.find(
    (candidate) =>
      candidate.path === input.path && candidate.content.includes(input.contentIncludes),
  );
  if (!artifact) {
    throw new Error(
      `Real fixture did not find ${input.path} containing ${JSON.stringify(input.contentIncludes)}; candidates=${candidates.map((candidate) => `${candidate.path}:${candidate.symbol ?? candidate.kind}`).join(",")}`,
    );
  }
  return artifact;
}

function parseReaderOutput(value: unknown): JointReaderOutput {
  if (!value || typeof value !== "object") throw new Error("Reader output must be an object");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.answer !== "string" || typeof candidate.abstain !== "boolean") {
    throw new Error("Reader output answer/abstain is invalid");
  }
  if (!Array.isArray(candidate.claims)) throw new Error("Reader output claims must be an array");
  const claims = candidate.claims.map((claim) => {
    if (!claim || typeof claim !== "object") throw new Error("Reader claim must be an object");
    const row = claim as Record<string, unknown>;
    if (
      typeof row.text !== "string" ||
      !Array.isArray(row.citations) ||
      !row.citations.every((citation) => typeof citation === "string")
    ) {
      throw new Error("Reader claim text/citations is invalid");
    }
    return { text: row.text, citations: row.citations as string[] };
  });
  return { answer: candidate.answer, abstain: candidate.abstain, claims };
}

async function callOllamaReader(model: string, prompt: string): Promise<JointReaderOutput> {
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: "json",
      keep_alive: "10m",
      options: { temperature: 0, seed: 7, num_ctx: 8192, num_predict: 384 },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    throw new Error(`Reader request failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { message?: { content?: unknown } };
  if (typeof body.message?.content !== "string") throw new Error("Reader response has no content");
  return parseReaderOutput(JSON.parse(body.message.content));
}

const codexReaderSchemaPath = fileURLToPath(
  new URL("./fixtures/joint-reader-output.schema.json", import.meta.url),
);
const codexReaderWorkdir = join(tmpdir(), "lore-joint-reader-empty.PROTOTYPE");

async function callCodexReader(model: string, prompt: string): Promise<JointReaderOutput> {
  await mkdir(codexReaderWorkdir, { recursive: true });
  const outputPath = join(tmpdir(), `lore-joint-reader-${crypto.randomUUID()}.json`);
  const command = [
    "codex",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    codexReaderWorkdir,
    "-m",
    model,
    "-c",
    'model_reasoning_effort="low"',
    "--disable",
    "plugins",
    "--disable",
    "skill_search",
    "--disable",
    "apps",
    "--disable",
    "tool_suggest",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "browser_use_full_cdp_access",
    "--disable",
    "in_app_browser",
    "--disable",
    "hooks",
    "--output-schema",
    codexReaderSchemaPath,
    "--output-last-message",
    outputPath,
    "-",
  ];
  const subprocess = spawn(command[0] ?? "codex", command.slice(1), {
    cwd: codexReaderWorkdir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => subprocess.kill(), 180_000);
  try {
    let stdout = "";
    let stderr = "";
    subprocess.stdout.setEncoding("utf8");
    subprocess.stderr.setEncoding("utf8");
    subprocess.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    subprocess.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    subprocess.stdin.end(prompt);
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      subprocess.once("error", rejectExit);
      subprocess.once("close", resolveExit);
    });
    if (exitCode !== 0) {
      throw new Error(
        `Codex reader failed (${exitCode}): ${stderr.trim() || stdout.trim() || "no output"}`,
      );
    }
    return parseReaderOutput(JSON.parse(await readFile(outputPath, "utf8")));
  } finally {
    clearTimeout(timeout);
    await rm(outputPath, { force: true });
  }
}

async function callReader(
  provider: "codex" | "ollama",
  model: string,
  prompt: string,
): Promise<JointReaderOutput> {
  return provider === "codex" ? callCodexReader(model, prompt) : callOllamaReader(model, prompt);
}

const outputPath = optionalArgument("output");
const dataDir = optionalArgument("database");
const readerProviderValue =
  optionalArgument("reader-provider") ?? process.env.JOINT_READER_PROVIDER ?? "ollama";
if (readerProviderValue !== "codex" && readerProviderValue !== "ollama") {
  throw new Error("--reader-provider must be codex or ollama");
}
const readerProvider = readerProviderValue;
const model =
  optionalArgument("model") ??
  process.env.JOINT_READER_MODEL ??
  (readerProvider === "codex" ? "gpt-5.6-sol" : "qwen3.5:9b");
const noReader = process.argv.includes("--no-reader");
const strict = process.argv.includes("--strict");
const caseFilter = optionalArgument("case");
const variantFilter = optionalArgument("variant");
if (variantFilter && !VARIANTS.some((variant) => variant.id === variantFilter)) {
  throw new Error(`Unknown --variant: ${variantFilter}`);
}
const { actor, database, postgres } = await createDatabase(dataDir);

try {
  const code = createCodeIndexModule(database);
  const productionContext = createContextRetrievalModule(database);
  const evidence = createCodeEvidenceModule(database);
  const memories = createMemoryModule(database);
  const repositoryPath = process.cwd();
  const baseIndex = await code.indexGitRevision(actor, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Lore real temporal prototype",
    repositoryPath,
    commitOid: BASE_COMMIT,
    sourceRef: "feature-memory-proposals",
  });
  const targetIndex = await code.indexGitRevision(actor, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Lore real temporal prototype",
    repositoryPath,
    commitOid: TARGET_COMMIT,
    sourceRef: "harden-memory-proposal-review",
  });

  const baseRetention = await findArtifact({
    actor,
    code,
    commitOid: BASE_COMMIT,
    query: "remain in review history",
    path: "src/components/MemoryProposalsView.tsx",
    contentIncludes: "remain in review history",
  });
  const baseSubmission = await findArtifact({
    actor,
    code,
    commitOid: BASE_COMMIT,
    query: "INSERT INTO memory_proposals",
    path: "src/lib/memory.ts",
    contentIncludes: "INSERT INTO memory_proposals",
  });
  const baseGovernance = await findArtifact({
    actor,
    code,
    commitOid: BASE_COMMIT,
    query: "Nothing here becomes searchable Memory",
    path: "src/components/MemoryProposalsView.tsx",
    contentIncludes: "Nothing here becomes searchable Memory",
  });
  const baseCache = await findArtifact({
    actor,
    code,
    commitOid: BASE_COMMIT,
    query: "cacheKeyMatches",
    path: "src/components/MemoryProposalsView.tsx",
    contentIncludes: "cacheKeyMatches",
  });

  const memoryByKey = new Map<string, Memory>();
  async function remember(key: string, content: string): Promise<Memory> {
    const memory = await memories.remember(actor, {
      content,
      scope: "shared",
      metadata: { evaluationKey: key, observedCommit: BASE_COMMIT },
    });
    memoryByKey.set(key, memory);
    return memory;
  }

  const retentionMemory = await remember(
    "retention-history",
    "At the feature commit, rejecting a Memory Proposal left it in review history and it could not be reopened.",
  );
  const submissionMemory = await remember(
    "submission-history",
    "At the feature commit, createMemoryModule inserted a submitted proposal directly into memory_proposals.",
  );
  const governanceMemory = await remember(
    "proposal-governance",
    "Pending Memory Proposals are not canonical or searchable until the owner human accepts them.",
  );
  const cacheMemory = await remember(
    "cache-history",
    "At the feature commit, MemoryProposalsView used cacheKeyMatches to invalidate proposal, Memory, search, and graph caches directly.",
  );
  await remember(
    "cache-distractor",
    "A design discussion mentioned proposal cache invalidation but did not specify the implemented callback contract.",
  );

  const historicalCitations = [
    await evidence.cite(actor, {
      memoryId: retentionMemory.id,
      artifactId: baseRetention.id,
      relationship: "supports",
    }),
    await evidence.cite(actor, {
      memoryId: submissionMemory.id,
      artifactId: baseSubmission.id,
      relationship: "supports",
    }),
    await evidence.cite(actor, {
      memoryId: governanceMemory.id,
      artifactId: baseGovernance.id,
      relationship: "rationale",
    }),
    await evidence.cite(actor, {
      memoryId: cacheMemory.id,
      artifactId: baseCache.id,
      relationship: "supports",
    }),
  ];

  const cases: RealCase[] = [
    {
      id: "change/rejected-retention",
      query: "What changed about rejected Memory Proposal review history?",
      memoryQuery: "review history",
      codeQuery: "30 days",
      expectedRoute: "both",
      expectedMemoryKeys: ["retention-history"],
      expectedCodePaths: ["src/components/MemoryProposalsView.tsx"],
      expectedAnchorState: "changed",
      reader: {
        abstain: false,
        requiredTerms: ["30", "days"],
        forbiddenTerms: ["forever"],
        requiredCitationKinds: ["memory", "code", "anchor"],
      },
    },
    {
      id: "change/submission-boundary",
      query: "Does proposal submission still insert directly into memory_proposals?",
      memoryQuery: "inserted submitted proposal directly",
      codeQuery: "submit_memory_proposal",
      expectedRoute: "both",
      expectedMemoryKeys: ["submission-history"],
      expectedCodePaths: ["src/lib/memory.ts"],
      expectedAnchorState: "ambiguous",
      reader: {
        abstain: false,
        requiredTerms: ["submit_memory_proposal"],
        requiredCitationKinds: ["memory", "code", "anchor"],
      },
    },
    {
      id: "rationale/proposal-governance",
      query: "Why are pending Memory Proposals absent from canonical search?",
      memoryQuery: "canonical searchable owner human accepts",
      codeQuery: "Nothing here becomes searchable Memory",
      expectedRoute: "both",
      expectedMemoryKeys: ["proposal-governance"],
      expectedCodePaths: ["src/components/MemoryProposalsView.tsx"],
      reader: {
        abstain: false,
        requiredTerms: ["human", "accept"],
        requiredCitationKinds: ["memory", "code"],
      },
    },
    {
      id: "current/cache-callback",
      query: "Where is proposal review cache update code implemented now?",
      memoryQuery: "proposal cache",
      codeQuery: "onReviewed",
      expectedRoute: "code-only",
      expectedMemoryKeys: [],
      expectedCodePaths: ["src/components/MemoryProposalsView.tsx"],
      reader: {
        abstain: false,
        requiredTerms: ["onreviewed"],
        requiredCitationKinds: ["code"],
      },
    },
    {
      id: "current/deleted-cache-helper",
      query: "Where is cacheKeyMatches implemented now?",
      memoryQuery: "cacheKeyMatches",
      codeQuery: "cacheKeyMatches",
      expectedRoute: "code-only",
      expectedMemoryKeys: [],
      expectedCodePaths: [],
      reader: { abstain: true },
    },
    {
      id: "no-answer/real-revision",
      query: "Where is definitelyAbsentRealGitSymbol implemented now?",
      memoryQuery: "definitelyAbsentRealGitSymbol",
      codeQuery: "definitelyAbsentRealGitSymbol",
      expectedRoute: "code-only",
      expectedMemoryKeys: [],
      expectedCodePaths: [],
      reader: { abstain: true },
    },
  ];
  const selectedCases = caseFilter ? cases.filter((entry) => entry.id === caseFilter) : cases;
  if (selectedCases.length === 0) throw new Error(`Unknown --case: ${caseFilter}`);
  const selectedVariants = variantFilter
    ? VARIANTS.filter((variant) => variant.id === variantFilter)
    : VARIANTS;

  async function runCase(evaluationCase: RealCase, variant: RealVariant): Promise<CaseRun> {
    const basePlan = planJointEvidenceRoute({
      query: evaluationCase.query,
      hasRepositoryContext: true,
    });
    const plan = {
      ...basePlan,
      route: variant.forcedRoute ?? basePlan.route,
      needsAnchorExpansion: variant.expandAnchors && basePlan.route === "both",
      needsLocalAssessment: variant.assessAnchors && basePlan.route === "both",
      needsContextualImpact: false,
      reasons: [...basePlan.reasons, `real-git-ablation:${variant.id}`],
    };
    const memoryResults =
      plan.route === "memory-only" || plan.route === "both"
        ? await memories.search(actor, { query: evaluationCase.memoryQuery, limit: 5 })
        : [];
    const packetMemories: JointMemoryEvidence[] = memoryResults.map((result) => ({
      id: result.memory.id,
      content: result.memory.content,
      score: result.score,
    }));
    const directCode =
      plan.route === "code-only" || plan.route === "both"
        ? await code.search(actor, {
            repositoryKey: REPOSITORY_KEY,
            commitOid: TARGET_COMMIT,
            query: evaluationCase.codeQuery,
            limit: 4,
          })
        : [];
    const packetCode = directCode.map((artifact) =>
      codeEvidence(artifact, evaluationCase.codeQuery),
    );
    const packetAnchors: JointAnchorEvidence[] = [];
    if (plan.needsAnchorExpansion) {
      for (const result of memoryResults) {
        const attached = await evidence.list(actor, { memoryId: result.memory.id });
        for (const original of attached) {
          const assessment = plan.needsLocalAssessment
            ? await evidence.assess(actor, {
                evidenceId: original.id,
                repositoryKey: REPOSITORY_KEY,
                commitOid: TARGET_COMMIT,
              })
            : null;
          packetAnchors.push(anchorEvidence(original, assessment));
          const validatedArtifactId = assessment
            ? assessment.validatedArtifactId
            : original.validatedArtifactId;
          if (validatedArtifactId) {
            const targetQuery =
              citedSymbolSearchText(original) ??
              (assessment ? assessment.validatedPath : original.validatedPath) ??
              original.citedPath;
            const expanded = await code.search(actor, {
              repositoryKey: REPOSITORY_KEY,
              commitOid: TARGET_COMMIT,
              query: targetQuery,
              limit: 100,
            });
            const selected = expanded.find((artifact) => artifact.id === validatedArtifactId);
            if (selected && !packetCode.some((artifact) => artifact.artifactId === selected.id)) {
              packetCode.push(codeEvidence(selected, targetQuery));
            }
          }
        }
      }
    }
    const anchors = uniqueBy(packetAnchors, (anchor) => anchor.id);
    const distinctMemories = uniqueBy(packetMemories, (memory) => memory.id);
    const packet = assembleGroupedJointEvidence({
      query: evaluationCase.query,
      plan,
      memories: variant.prioritizeAnchors
        ? prioritizeAnchoredMemories(distinctMemories, anchors)
        : distinctMemories,
      code: uniqueBy(packetCode, (artifact) => artifact.artifactId),
      anchors,
      requestedCommitOid: TARGET_COMMIT,
    });
    const memoryKeys = new Set(
      packet.memories.flatMap((candidate) => {
        const found = [...memoryByKey.entries()].find(([, memory]) => memory.id === candidate.id);
        return found ? [found[0]] : [];
      }),
    );
    const prompt = buildJointReaderPrompt(packet);
    const readerOutput =
      noReader || !variant.evaluateReader
        ? null
        : await callReader(readerProvider, model, prompt.prompt);
    return {
      case: evaluationCase,
      packet,
      packetChecks: {
        route: plan.route === evaluationCase.expectedRoute,
        memoryRecall: evaluationCase.expectedMemoryKeys.every((key) => memoryKeys.has(key)),
        codeRecall: evaluationCase.expectedCodePaths.every((path) =>
          packet.code.some((artifact) => artifact.path === path),
        ),
        anchorState: evaluationCase.expectedAnchorState
          ? packet.anchors.some((anchor) =>
              anchorMatchesExpectedState(
                anchor,
                evaluationCase.expectedAnchorState as MemoryCodeEvidence["validationState"],
              ),
            )
          : null,
      },
      reader: readerOutput
        ? {
            output: readerOutput,
            score: scoreJointReaderOutput({
              evidence: prompt.evidence,
              expectation: evaluationCase.reader,
              output: readerOutput,
            }),
          }
        : null,
    };
  }

  const results = new Map<RealVariantId, CaseRun[]>();
  for (const variant of selectedVariants) {
    const runs: CaseRun[] = [];
    for (const evaluationCase of selectedCases) runs.push(await runCase(evaluationCase, variant));
    results.set(variant.id, runs);
  }

  const variants = Object.fromEntries(
    [...results.entries()].map(([variant, runs]) => {
      const readerScores = runs.flatMap((run) => (run.reader ? [run.reader.score] : []));
      const scoreFields: Array<keyof JointReaderScore> = [
        "abstentionCorrect",
        "citationCompleteness",
        "citationIdsValid",
        "forbiddenTermsAbsent",
        "requiredCitationKindsPresent",
        "requiredTermsPresent",
      ];
      return [
        variant,
        {
          metrics: {
            routeAccuracy: rate(runs.map((run) => run.packetChecks.route)),
            memoryRecall: rate(runs.map((run) => run.packetChecks.memoryRecall)),
            codeRecall: rate(runs.map((run) => run.packetChecks.codeRecall)),
            anchorStateAccuracy: rate(
              runs.flatMap((run) =>
                run.packetChecks.anchorState === null ? [] : [run.packetChecks.anchorState],
              ),
            ),
            readerPassRate: readerScores.length
              ? rate(
                  readerScores.map((readerScore) =>
                    scoreFields.every((field) => readerScore[field]),
                  ),
                )
              : null,
            averageEvidenceCharacters: rounded(
              runs.reduce(
                (total, run) =>
                  total +
                  run.packet.memories.reduce((sum, memory) => sum + memory.content.length, 0) +
                  run.packet.code.reduce((sum, artifact) => sum + artifact.content.length, 0),
                0,
              ) / runs.length,
            ),
            averageReaderEvidenceCharacters: rounded(
              runs.reduce((total, run) => {
                const readerInput = buildJointReaderPrompt(run.packet);
                return (
                  total + readerInput.evidence.reduce((sum, item) => sum + item.text.length, 0)
                );
              }, 0) / runs.length,
            ),
          },
          cases: runs.map((run) => ({
            id: run.case.id,
            expectedRoute: run.case.expectedRoute,
            plannedRoute: run.packet.plan.route,
            deliveredRoute: run.packet.deliveredRoute,
            packetChecks: run.packetChecks,
            memoryCount: run.packet.memories.length,
            codeCount: run.packet.code.length,
            anchors: run.packet.anchors.map((anchor) => ({
              relationship: anchor.relationship,
              state: anchor.localState,
              citedPath: anchor.citedPath,
              validatedPath: anchor.validatedPath,
            })),
            conflicts: run.packet.conflicts,
            readerEvidence: buildJointReaderPrompt(run.packet).evidence,
            reader: run.reader,
          })),
        },
      ];
    }),
  );
  const productionContextCases = [];
  for (const evaluationCase of selectedCases) {
    const packet = await productionContext.retrieve(actor, {
      query: evaluationCase.query,
      memoryQuery: evaluationCase.memoryQuery,
      codeQuery: evaluationCase.codeQuery,
      repositoryKey: REPOSITORY_KEY,
      commitOid: TARGET_COMMIT,
      memoryLimit: 5,
      codeLimit: 4,
    });
    const memoryKeys = new Set(
      packet.memories.flatMap((candidate) => {
        const found = [...memoryByKey.entries()].find(([, memory]) => memory.id === candidate.id);
        return found ? [found[0]] : [];
      }),
    );
    productionContextCases.push({
      id: evaluationCase.id,
      plannedRoute: packet.plan.route,
      deliveredRoute: packet.deliveredRoute,
      memoryQuery: packet.receipt.memoryQuery,
      codeQuery: packet.receipt.codeQuery,
      contextualImpact: packet.receipt.contextualImpact,
      checks: {
        route: packet.plan.route === evaluationCase.expectedRoute,
        memoryRecall: evaluationCase.expectedMemoryKeys.every((key) => memoryKeys.has(key)),
        codeRecall: evaluationCase.expectedCodePaths.every((path) =>
          packet.code.some((artifact) => artifact.path === path),
        ),
        anchorState: evaluationCase.expectedAnchorState
          ? packet.anchors.some(
              (anchor) => anchor.localState === evaluationCase.expectedAnchorState,
            )
          : true,
        receiptQueries:
          packet.receipt.memoryQuery ===
            (packet.plan.route === "memory-only" || packet.plan.route === "both"
              ? evaluationCase.memoryQuery
              : null) &&
          packet.receipt.codeQuery ===
            (packet.plan.route === "code-only" || packet.plan.route === "both"
              ? evaluationCase.codeQuery
              : null),
        contextualImpact:
          packet.plan.needsContextualImpact === (packet.receipt.contextualImpact !== null) &&
          !packet.receipt.contextualImpact?.changes.some((change) =>
            change.includes("not_assessed"),
          ),
      },
    });
  }
  const productionContextSurface = productionContextCases.every((evaluationCase) =>
    Object.values(evaluationCase.checks).every(Boolean),
  );
  const finalMetrics = variants["selective-final"]?.metrics;
  if (!finalMetrics) throw new Error("The selective-final variant is required for release gates");
  const storedCitations = (
    await Promise.all(
      [...new Set(historicalCitations.map((citation) => citation.memoryId))].map((memoryId) =>
        evidence.list(actor, { memoryId }),
      ),
    )
  ).flat();
  const storedCitationById = new Map(storedCitations.map((citation) => [citation.id, citation]));
  const sideEffectFreeAssessment = historicalCitations.every((historical) => {
    const stored = storedCitationById.get(historical.id);
    return (
      stored?.validationState === historical.validationState &&
      stored.validatedRevisionId === historical.validatedRevisionId &&
      stored.validatedGenerationId === historical.validatedGenerationId &&
      stored.validatedArtifactId === historical.validatedArtifactId &&
      stored.validatedCommitOid === historical.validatedCommitOid &&
      stored.validatedPath === historical.validatedPath &&
      stored.validatedAt === historical.validatedAt
    );
  });
  const gates = {
    trustedGitBaseCommit:
      baseIndex.commitOid === BASE_COMMIT && baseIndex.manifest.entries.length > 0,
    trustedGitTargetCommit:
      targetIndex.commitOid === TARGET_COMMIT && targetIndex.manifest.entries.length > 0,
    routeAccuracy: finalMetrics.routeAccuracy === 1,
    memoryRecall: finalMetrics.memoryRecall === 1,
    codeRecall: finalMetrics.codeRecall === 1,
    anchorStateAccuracy: finalMetrics.anchorStateAccuracy === 1,
    productionContextSurface,
    sideEffectFreeAssessment,
    fixedReader: noReader ? null : finalMetrics.readerPassRate === 1,
  };
  const report = {
    revision: "joint-memory-code-real-git-v6",
    decision:
      Object.values(gates).every((gate) => gate === true || gate === null) &&
      (!noReader || gates.fixedReader === null)
        ? noReader
          ? "retrieval-pass-reader-skipped"
          : "pass"
        : "fail",
    corpus: {
      repositoryPath,
      scratchDatabase: dataDir,
      baseCommit: BASE_COMMIT,
      targetCommit: TARGET_COMMIT,
      baseManifestEntries: baseIndex.manifest.totalEntryCount,
      targetManifestEntries: targetIndex.manifest.totalEntryCount,
      baseArtifacts: baseIndex.artifactCount,
      targetArtifacts: targetIndex.artifactCount,
      targetReusedFiles: targetIndex.reusedFileCount,
      caseFilter,
      variantFilter,
    },
    reader: noReader
      ? { enabled: false }
      : {
          enabled: true,
          provider: readerProvider === "codex" ? "OpenAI via Codex exec" : "Ollama /api/chat",
          model,
          ...(readerProvider === "codex"
            ? {
                reasoningEffort: "low",
                isolation: "ephemeral empty-directory read-only; prompt evidence only",
              }
            : {
                thinking: false,
                temperature: 0,
                seed: 7,
                numCtx: 8192,
                numPredict: 384,
              }),
        },
    gates,
    productionContext: {
      revision: "joint-memory-code-v2",
      cases: productionContextCases,
    },
    variants,
    limitations: [
      "Six hand-authored cases from one adjacent commit pair are not a repository-disjoint benchmark.",
      "Answer scoring uses deterministic terms and citation-shape checks, not an independent semantic judge.",
      "The fixed reader is evaluated only against bounded evidence passages, not patch generation or tests.",
      "The route policy remains a deterministic English keyword baseline.",
      "Production contextual impact is deliberately one-hop and bounded to five anchors by 25 direct dependency edges; it is not a transitive blast-radius analysis.",
      "Declaration chunk ordinals are accepted for changed content only when the immutable masked declaration-sequence context fingerprint still matches; structural reorder/replacement abstains as ambiguous.",
    ],
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, serialized, "utf8");
  }
  if (strict && report.decision === "fail") process.exitCode = 1;
} finally {
  await postgres.close();
}
