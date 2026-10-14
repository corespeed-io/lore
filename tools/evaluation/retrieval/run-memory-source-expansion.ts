/**
 * LongMemEval-S: Memory hit → bounded raw-source expansion, against the frozen
 * Memory packets of the dual-memory-evidence baseline (run-memory-evidence.ts).
 * Memory retrieval is replayed from that baseline, never re-run, so every arm
 * shares exactly the same facts evidence and the Memory-only answers are reused.
 *
 * The source mapping is the benchmark's session metadata: a fact Memory's key
 * names the session it was extracted from. Production Memories carry no such
 * link to Observations; this measures the strategy, not an implemented feature.
 *
 * Phases (BENCHMARK_DATABASE_URL names a disposable database containing "bench"):
 *   --prepare            seed every raw session as an Observation (no model call)
 *   --embed              embed raw chunks with gemini-embedding-2 (GEMINI_API_KEY)
 *   --retrieve           build every arm's packet and offline diagnostics; the
 *                        dense arms only for questions whose chunks are embedded
 *   --answer <arm> --profile <name>
 *                        reader + judge for one arm under one answer profile
 *   --rejudge <arm>      a second gemini-codex judgment of Memory-only and one arm
 *   --summarize [--profile <name>]
 *                        retrieval diagnostics, plus paired answers for a profile
 * --smoke limits --embed/--answer/--summarize to the fixed stratified smoke sample.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EPISODE_EVIDENCE_RETRIEVAL_POLICY } from "@corespeed/lore-core/episodes";
import OpenAI from "openai";
import pg from "pg";
import { createEpisodeEvidenceModule } from "../../../src/modules/episodes/evidence";
import { createObservationModule } from "../../../src/modules/episodes/service";
import { createPostgresDatabase } from "../../../src/server/database/postgres";
import { createGoogleEmbeddingProvider } from "../../../src/server/providers/embedding/google";
import {
  createBenchmarkReaderFromEnvironment,
  renderBenchmarkReaderInput,
} from "../shared/benchmark-reader";
import { requireMigratedBenchmarkSchema } from "../shared/benchmark-schema";
import { runCodexText } from "../shared/codex-exec";
import { verifyFile } from "../shared/file-integrity";
import { readJsonArray } from "../shared/json-array";
import { type LongMemEvalRecord, longMemEvalManifest, parseLongMemEvalRecord } from "./longmemeval";
import {
  alternatePacket,
  answerDeclines,
  answerTextPresent,
  attachSourcesToMemory,
  combineSourcesWithRaw,
  type EvidencePacketItem,
  evidenceTurnCoverage,
  keywordOrQuery,
  mcnemarExactP,
  memoryKeyOf,
  pairedBootstrap95,
  rawSourceKeyForMemory,
  requireMemoryInsideCap,
} from "./memory-source-expansion";

function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Required benchmark value is missing");
  return value;
}
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const alice = "00000000-0000-4000-8000-000000000701";
const bob = "00000000-0000-4000-8000-000000000702";
const tripwireKey = "__bob_private_tripwire__";
const corpus = "longmemeval-raw-v1";
const maximumCharacters = 24_000;
const baselineDirectory = resolve(
  process.env.LORE_SOURCE_EXPANSION_BASELINE ??
    "evaluation/results/dual-memory-evidence-20261012-v2",
);
const directory = resolve(
  process.env.LORE_SOURCE_EXPANSION_OUTPUT ?? "evaluation/results/memory-source-expansion-20261013",
);
const benchmarkUrl = process.env.BENCHMARK_DATABASE_URL;
if (!benchmarkUrl) throw new Error("BENCHMARK_DATABASE_URL is required");
if (!/(^|_)bench(mark)?($|_)/i.test(new URL(benchmarkUrl).pathname.slice(1))) {
  throw new Error("Use a disposable database whose name contains bench or benchmark");
}

/**
 * Every arm keeps the baseline's ten frozen Memory excerpts intact and adds raw
 * Observation text only inside the same 24,000-unit reader cap. Arms change one
 * thing at a time against `memory`; `dual-lexical` is the earlier parallel arm.
 */
const ARMS = {
  memory: "Frozen Memory top 10 only (baseline answers reused)",
  "dual-lexical": "Frozen Memory + independent raw lexical, original question (baseline)",
  "source-question":
    "Memory hit sources, source-scoped raw search with the original question, anchor chunk",
  "source-keywords":
    "Memory hit sources, source-scoped raw search with the keyword OR rewrite, anchor chunk",
  "source-keywords-neighbors":
    "As source-keywords with one neighbor chunk on each side of the anchor",
  "source-session": "Memory hit sources, whole raw session read in Memory rank order",
  "raw-keywords": "Independent raw lexical with the keyword OR rewrite, alternated like dual",
  "raw-hybrid": "Independent raw lexical + dense, original question, alternated like dual",
  "source-hybrid": "Memory hit sources, source-scoped raw lexical + dense, original question",
  "combined-keywords":
    "Half the raw budget to whole Memory-hit sessions, the rest to raw-keywords excerpts from other sessions",
  "combined-hybrid":
    "Half the raw budget to whole Memory-hit sessions, the rest to raw-hybrid excerpts from other sessions",
} as const;
type ArmName = keyof typeof ARMS;
const DENSE_ARMS: readonly ArmName[] = ["raw-hybrid", "source-hybrid", "combined-hybrid"];
const isArm = (value: string | undefined): value is ArmName =>
  value !== undefined && Object.hasOwn(ARMS, value);

const datasetPath = resolve("evaluation/datasets/longmemeval/longmemeval_s_cleaned.json");
await verifyFile(datasetPath, longMemEvalManifest.files.s);
const records: LongMemEvalRecord[] = [];
for await (const value of readJsonArray(datasetPath)) records.push(parseLongMemEvalRecord(value));
if (records.length !== 500) throw new Error("Expected the complete 500-question S split");
const category = (record: LongMemEvalRecord) =>
  record.question_id.endsWith("_abs") ? "abstention" : record.question_type;
/** Five questions per category, chosen by a hash of the id rather than by outcome. */
const smokeIds = new Set(
  [...new Set(records.map(category))].flatMap((name) =>
    records
      .filter((record) => category(record) === name)
      .map((record) => record.question_id)
      .sort((left, right) => sha(left).localeCompare(sha(right)))
      .slice(0, 5),
  ),
);

type Source = { key: string; sessionId: string; date: string; text: string };
function sources(record: LongMemEvalRecord): Source[] {
  const counts = new Map<string, number>();
  return record.haystack_sessions.map((turns, index) => {
    const sessionId = present(record.haystack_session_ids[index]);
    const occurrence = (counts.get(sessionId) ?? 0) + 1;
    counts.set(sessionId, occurrence);
    return {
      key: occurrence === 1 ? sessionId : `${sessionId}::occurrence:${occurrence}`,
      sessionId,
      date: present(record.haystack_dates[index]),
      text:
        `Conversation session at ${record.haystack_dates[index]}:\n` +
        turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n\n"),
    };
  });
}
function workspaceIdFor(questionId: string): string {
  const hex = sha(`lore-memory-source-expansion:${questionId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function parallel<T>(items: T[], concurrency: number, use: (item: T) => Promise<void>) {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) await use(present(items[next++]));
    }),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
async function save(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}
async function load<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

type BaselineArm = {
  packet: EvidencePacketItem[];
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  correct: boolean;
  judgment: string;
};
type BaselineResult = {
  questionId: string;
  category: string;
  expected: string[];
  arms: { memory: BaselineArm; dual: BaselineArm };
  retrieval: { memory: string[]; raw: string[] };
};
const baselineProtocol = present(
  await load<{ protocolHash: string; protocol: { reader: Record<string, unknown> } }>(
    `${baselineDirectory}/protocol.json`,
  ),
);
if (
  baselineProtocol.protocolHash !==
  "5632361acc13fee7ff915800542942e12112aaaa0831098d15d9e39ebee86e94"
)
  throw new Error("The baseline directory is not the 2026-10-12 dual-memory-evidence run");
const baseline = async (record: LongMemEvalRecord) => {
  const result = present(
    await load<BaselineResult>(`${baselineDirectory}/${record.question_id}.json`),
  );
  if (!result.arms.memory.packet.length || result.arms.memory.packet.length > 10)
    throw new Error(`${record.question_id}: baseline Memory packet is missing`);
  return result;
};

const baselineReader = baselineProtocol.protocol.reader as {
  instructionSha256: string;
  decoding: unknown;
  profile: string;
  maximumContextCharacters: number;
};
/**
 * A profile fixes the reader and judge, and arms pair only within one profile.
 * `baseline` is the 2026-10-12 pair and reuses its Memory-only and dual answers.
 * `gemini-codex` keeps the reader model, instruction, decoding, and cap but calls
 * Google directly, judges with GPT-5.5 through Codex, and re-answers every arm.
 */
const ANSWER_PROFILES = {
  baseline: {
    reader: baselineProtocol.protocol.reader,
    judge: { transport: "vercel-ai-gateway", model: "openai/gpt-4o", maximumOutputTokens: 16 },
  },
  "gemini-codex": {
    reader: {
      model: "gemini-3.5-flash",
      transport: "google-interactions-v1beta",
      instructionSha256: baselineReader.instructionSha256,
      decoding: baselineReader.decoding,
      profile: baselineReader.profile,
      maximumContextCharacters: baselineReader.maximumContextCharacters,
    },
    judge: { transport: "codex-exec-chatgpt", model: "gpt-5.5", reasoningEffort: "low" as const },
  },
} as const;
type ProfileName = keyof typeof ANSWER_PROFILES;
const isProfile = (value: string | undefined): value is ProfileName =>
  value !== undefined && Object.hasOwn(ANSWER_PROFILES, value);

const protocol = {
  revision: "longmemeval-memory-source-expansion-v1",
  baseline: {
    directory: "dual-memory-evidence-20261012-v2",
    protocolHash: baselineProtocol.protocolHash,
  },
  dataset: longMemEvalManifest,
  memory: "frozen baseline top-10 fact excerpts, replayed verbatim",
  sourceMapping: "benchmark session key from fact Memory metadata; ::part:N maps to its session",
  episodePolicy: EPISODE_EVIDENCE_RETRIEVAL_POLICY,
  episodeDenseEmbeddings: {
    provider: "google",
    model: "gemini-embedding-2",
    dimensions: 1536,
    revision: "lore-embedding-v1",
    transport: "native Google Gen AI embedContent with the adapter's retrieval prefixes",
    semanticDistanceThreshold: 0.5,
    indexedBy: "Core Episode evidence index(), Bob's private tripwire included",
  },
  keywordRewrite: "relaxedEnglishTerms minus PostgreSQL english.stop, joined with websearch OR",
  arms: ARMS,
  packet: {
    maximumCharacters,
    units: "UTF-16 code units including question and evidence wrappers",
    sourceArms: "raw block after its Memory hit, Memory rank order, Memory never cut",
    perSourceLimit: "one Observation; anchor chunk, neighbors only where named",
    minimumTrimmedSource: 200,
    combinedSourceShare: 0.5,
    combinedRawOrder: "excerpts from sessions not already attached, appended in raw rank order",
  },
  answerProfiles: ANSWER_PROFILES,
  rubric: {
    upstreamCommit: "d6dc8b50a2d9ac0c99485ea28fa5755c62414c34",
    sourceSha256: "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251",
    templates: "five official V1 templates, unchanged; strict yes/no",
  },
  smoke: "five per category by sha256(question_id) order",
};
const protocolHash = sha(JSON.stringify(protocol));
/**
 * A protocol may grow (a new arm, a new field) but never change what earlier
 * results ran with: every value the previous protocol recorded must be unchanged.
 */
function extendsProtocol(previous: unknown, current: unknown): boolean {
  if (typeof previous !== "object" || previous === null || Array.isArray(previous))
    return JSON.stringify(previous) === JSON.stringify(current);
  if (typeof current !== "object" || current === null || Array.isArray(current)) return false;
  return Object.entries(previous).every(([key, value]) =>
    extendsProtocol(value, (current as Record<string, unknown>)[key]),
  );
}
await mkdir(`${directory}/retrieval`, { recursive: true });
await mkdir(`${directory}/answers`, { recursive: true });
const previous = await load<{
  protocolHash: string;
  protocol: unknown;
  priorProtocolHashes?: string[];
}>(`${directory}/protocol.json`);
if (previous && !extendsProtocol(previous.protocol, protocol))
  throw new Error("Output directory belongs to a different protocol");
await save(`${directory}/protocol.json`, {
  protocolHash,
  protocol,
  priorProtocolHashes: [
    ...new Set([
      ...(previous?.priorProtocolHashes ?? []),
      ...(previous && previous.protocolHash !== protocolHash ? [previous.protocolHash] : []),
    ]),
  ],
});

const admin = new pg.Pool({ connectionString: benchmarkUrl, max: 4 });
const database = createPostgresDatabase({ connectionString: benchmarkUrl, max: 12 });
const generationId = "00000000-0000-4000-8000-000000000703";
const embeddingUsage = { requests: 0, texts: 0, characters: 0, failures: 0 };
const geminiKey = process.env.GEMINI_API_KEY?.trim();
const google = geminiKey
  ? createGoogleEmbeddingProvider(
      {
        provider: "google",
        model: protocol.episodeDenseEmbeddings.model,
        dimensions: protocol.episodeDenseEmbeddings.dimensions,
        revision: protocol.episodeDenseEmbeddings.revision,
      },
      { apiKey: geminiKey, maxRetries: 5 },
    )
  : undefined;
// The engine treats a failed query embedding as lexical-only. Count every call so
// a dense arm can never silently become a lexical one.
const embeddingProvider = google && {
  ...google,
  embed: async (texts: string[], task: "query" | "document") => {
    embeddingUsage.requests++;
    embeddingUsage.texts += texts.length;
    embeddingUsage.characters += texts.reduce((sum, text) => sum + text.length, 0);
    return google.embed(texts, task).catch((error: unknown) => {
      embeddingUsage.failures++;
      throw error;
    });
  },
};

async function seed(record: LongMemEvalRecord) {
  const qid = record.question_id;
  const workspaceId = workspaceIdFor(qid);
  const existing = (await admin.query("SELECT name FROM workspaces WHERE id=$1", [workspaceId]))
    .rows[0];
  if (existing?.name === `Raw evidence ready ${qid}`) return;
  if (existing) throw new Error(`${qid}: partial seed found; inspect it before retrying`);
  await admin.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
    workspaceId,
    `Raw evidence building ${qid}`,
  ]);
  await admin.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",
    [workspaceId, alice, bob],
  );
  const actor = { workspaceId, userId: alice };
  const observations = createObservationModule(database);
  // The baseline's exact batching, rendering, dates, and metadata, so the same
  // Observations produce the same exact evidence chunks.
  const raw = sources(record);
  let batch: Source[] = [];
  let characters = 0;
  const flush = async () => {
    if (!batch.length) return;
    await observations.record(actor, {
      kind: "conversation",
      scope: "private",
      observations: batch.map((source) => ({
        kind: "document_fragment",
        content: source.text,
        observedAt: new Date(
          `${source.date
            .replace(/ \([^)]*\)/, "")
            .replaceAll("/", "-")
            .replace(" ", "T")}:00Z`,
        ).toISOString(),
        metadata: {
          questionId: qid,
          sessionId: source.sessionId,
          benchmarkKey: source.key,
          sessionDate: source.date,
          corpus,
        },
      })),
    });
    batch = [];
    characters = 0;
  };
  for (const source of raw) {
    if (source.text.length > 100_000) throw new Error("Source exceeds Observation bounds");
    if (batch.length === 100 || characters + source.text.length > 900_000) await flush();
    batch.push(source);
    characters += source.text.length;
  }
  await flush();
  await observations.record(
    { workspaceId, userId: bob },
    {
      kind: "conversation",
      scope: "private",
      observations: [
        {
          kind: "message",
          content: `Confidential Bob private answer. ${record.question}\n${record.answer}`,
          metadata: { questionId: qid, sessionId: tripwireKey, benchmarkKey: tripwireKey, corpus },
        },
      ],
    },
  );
  const coverage = (
    await admin.query<{ observations: number; chunks: number }>(
      `SELECT
        (SELECT count(*)::int FROM observations o JOIN episodes e ON e.id=o.episode_id
          WHERE o.workspace_id=$1 AND e.owner_user_id=$2) AS observations,
        (SELECT count(*)::int FROM episode_evidence_chunks c JOIN episodes e ON e.id=c.episode_id
          WHERE c.workspace_id=$1 AND e.owner_user_id=$2) AS chunks`,
      [workspaceId, alice],
    )
  ).rows[0];
  if (coverage?.observations !== raw.length || !coverage.chunks)
    throw new Error(`${qid}: seed coverage incomplete`);
  await admin.query("UPDATE workspaces SET name=$2 WHERE id=$1", [
    workspaceId,
    `Raw evidence ready ${qid}`,
  ]);
  console.log(`seed ${qid}: ${raw.length} raw sessions, ${coverage.chunks} chunks`);
}

async function embed(record: LongMemEvalRecord) {
  const provider = present(embeddingProvider);
  const workspaceId = workspaceIdFor(record.question_id);
  const evidence = createEpisodeEvidenceModule(database, {
    embeddingProvider: provider,
    embeddingDimensions: protocol.episodeDenseEmbeddings.dimensions,
  });
  let chunks = 0;
  // Bob's private tripwire shares the vector path, so dense search proves RLS too.
  for (const userId of [alice, bob]) {
    const actor = { workspaceId, userId };
    const episodes = await createObservationModule(database).list(actor, { limit: 100 });
    for (const episode of episodes.filter((summary) => summary.ownerUserId === userId)) {
      // index() stops at a failed provider batch; later attempts embed only the rest.
      let result = await evidence.index(actor, { episodeId: episode.id });
      for (let attempt = 1; result.embeddedChunkCount < result.chunkCount; attempt++) {
        if (attempt > 6) throw new Error(`${record.question_id}: embedding stayed incomplete`);
        await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
        result = await evidence.index(actor, { episodeId: episode.id });
      }
      if (result.embeddingGenerationId !== generationId)
        throw new Error("Episode evidence embedded into an unexpected generation");
      await evidence.index(actor, { episodeId: episode.id, mode: "verify" });
      chunks += result.chunkCount;
    }
  }
  console.log(`embedded ${record.question_id}: ${chunks} chunks`);
}

async function denseReady(record: LongMemEvalRecord): Promise<boolean> {
  const row = (
    await admin.query<{ missing: number }>(
      `SELECT count(*)::int AS missing FROM episode_evidence_chunks chunk
       WHERE chunk.workspace_id=$1 AND NOT EXISTS (
         SELECT 1 FROM episode_evidence_chunk_embeddings embedded
         WHERE embedded.chunk_id=chunk.id AND embedded.generation_id=$2)`,
      [workspaceIdFor(record.question_id), generationId],
    )
  ).rows[0];
  return row?.missing === 0;
}

type ArmPacket = {
  packet: EvidencePacketItem[];
  query?: string;
  diagnostics: {
    inputCharacters: number;
    rawCharacters: number;
    rawSources: string[];
    goldRawSources: string[];
    newGoldRawSources: string[];
    evidenceTurnCoverage: number | null;
    answerTextPresent: boolean | null;
  };
};
type RetrievalRecord = {
  questionId: string;
  category: string;
  expected: string[];
  memorySessions: string[];
  rawQuestionReproduced: boolean;
  arms: Partial<Record<ArmName, ArmPacket>>;
};

async function retrieve(record: LongMemEvalRecord): Promise<void> {
  const path = `${directory}/retrieval/${record.question_id}.json`;
  const existing = await load<RetrievalRecord>(path);
  const missing = (Object.keys(ARMS) as ArmName[]).filter((arm) => !existing?.arms[arm]);
  if (!missing.length) return;
  const dense =
    embeddingProvider !== undefined &&
    missing.some((arm) => DENSE_ARMS.includes(arm)) &&
    (await denseReady(record));
  // Existing arms are never rebuilt; dense arms wait for complete embeddings.
  const wanted = missing.filter((arm) => dense || !DENSE_ARMS.includes(arm));
  if (!wanted.length) return;
  const prior = await baseline(record);
  const actor = { workspaceId: workspaceIdFor(record.question_id), userId: alice };
  const ready = (await admin.query("SELECT name FROM workspaces WHERE id=$1", [actor.workspaceId]))
    .rows[0];
  if (ready?.name !== `Raw evidence ready ${record.question_id}`)
    throw new Error(`${record.question_id}: run --prepare first`);
  const filter = { questionId: record.question_id, corpus };
  const anchor = createEpisodeEvidenceModule(database);
  const neighbors = createEpisodeEvidenceModule(database, { evidenceNeighborChunks: 1 });
  const memory = prior.arms.memory.packet;
  const sourceKeys = [...new Set(memory.map((item) => rawSourceKeyForMemory(memoryKeyOf(item))))];
  const keywords = keywordOrQuery(record.question);
  const search = (module: typeof anchor, query: string, scoped: boolean) =>
    module.search(actor, {
      query,
      limit: 10,
      metadataFilter: filter,
      groupMetadataKey: "benchmarkKey",
      ...(scoped ? { sourceKeys } : {}),
    });
  const [rawQuestion, rawKeywords, sourceQuestion, sourceKeywords, sourceNeighbors] =
    await Promise.all([
      search(anchor, record.question, false),
      search(anchor, keywords, false),
      search(anchor, record.question, true),
      search(anchor, keywords, true),
      search(neighbors, keywords, true),
    ]);
  const hybrid = dense
    ? createEpisodeEvidenceModule(database, {
        embeddingProvider: present(embeddingProvider),
        embeddingDimensions: protocol.episodeDenseEmbeddings.dimensions,
        semanticDistanceThreshold: protocol.episodeDenseEmbeddings.semanticDistanceThreshold,
      })
    : undefined;
  const failuresBefore = embeddingUsage.failures;
  const [rawHybrid, sourceHybrid] = hybrid
    ? await Promise.all([
        search(hybrid, record.question, false),
        search(hybrid, record.question, true),
      ])
    : [[], []];
  if (embeddingUsage.failures !== failuresBefore)
    throw new Error("Query embedding failed; refusing a silent lexical-only dense arm");
  for (const results of [
    rawQuestion,
    rawKeywords,
    sourceQuestion,
    sourceKeywords,
    sourceNeighbors,
    rawHybrid,
    sourceHybrid,
  ])
    if (results.some((result) => result.sourceKey === tripwireKey))
      throw new Error("RLS ISOLATION FAILURE");
  const toPacket = (results: typeof rawQuestion): EvidencePacketItem[] =>
    results.map((result) => ({
      id: `raw:${result.sourceKey}`,
      channel: "raw",
      sessionId: String(result.metadata.sessionId),
      text: `Session date: ${result.metadata.sessionDate}\n${result.evidence}`,
    }));
  // The whole session comes from the exact Observation, read under RLS.
  const episodes = createObservationModule(database);
  const sessions = new Map<string, EvidencePacketItem>();
  for (const summary of await episodes.list(actor, { limit: 100 })) {
    const episode = present(await episodes.retrieve(actor, summary.id));
    for (const observation of episode.observations) {
      const key = observation.metadata.benchmarkKey;
      if (key === tripwireKey) throw new Error("RLS ISOLATION FAILURE");
      if (typeof key !== "string" || !sourceKeys.includes(key)) continue;
      sessions.set(key, {
        id: `raw:${key}`,
        channel: "raw",
        sessionId: String(observation.metadata.sessionId),
        text: `Session date: ${observation.metadata.sessionDate}\n${observation.content}`,
      });
    }
  }
  const bySource = (results: typeof rawQuestion) =>
    new Map(toPacket(results).map((item) => [item.id.slice("raw:".length), item]));
  const question = `Question time: ${record.question_date}\n${record.question}`;
  const attach = (map: Map<string, EvidencePacketItem>) =>
    attachSourcesToMemory({ question, memory, sources: map, maximumCharacters });
  const combine = (raw: EvidencePacketItem[]) =>
    combineSourcesWithRaw({
      question,
      memory,
      sources: sessions,
      raw,
      maximumCharacters,
      sourceShare: protocol.packet.combinedSourceShare,
    });
  type Built = { packet: EvidencePacketItem[]; query?: string };
  const builders: Record<ArmName, () => Built> = {
    memory: () => ({ packet: memory }),
    "dual-lexical": () => ({ packet: prior.arms.dual.packet, query: record.question }),
    "source-question": () => ({ packet: attach(bySource(sourceQuestion)), query: record.question }),
    "source-keywords": () => ({ packet: attach(bySource(sourceKeywords)), query: keywords }),
    "source-keywords-neighbors": () => ({
      packet: attach(bySource(sourceNeighbors)),
      query: keywords,
    }),
    "source-session": () => ({ packet: attach(sessions) }),
    "raw-keywords": () => ({
      packet: alternatePacket(memory, toPacket(rawKeywords)),
      query: keywords,
    }),
    "raw-hybrid": () => ({
      packet: alternatePacket(memory, toPacket(rawHybrid)),
      query: record.question,
    }),
    "source-hybrid": () => ({ packet: attach(bySource(sourceHybrid)), query: record.question }),
    "combined-keywords": () => ({ packet: combine(toPacket(rawKeywords)), query: keywords }),
    "combined-hybrid": () => ({ packet: combine(toPacket(rawHybrid)), query: record.question }),
  };
  const packets = Object.fromEntries(wanted.map((arm) => [arm, builders[arm]()]));
  const arms = { ...existing?.arms, ...describeArms(record, question, memory, packets) };
  const reproduced = alternatePacket(memory, toPacket(rawQuestion));
  await save(
    path,
    existing
      ? { ...existing, arms }
      : ({
          questionId: record.question_id,
          category: category(record),
          expected: record.answer_session_ids,
          memorySessions: memory.map((item) => item.sessionId),
          // The local engine must reproduce the baseline's independent raw packet.
          rawQuestionReproduced:
            JSON.stringify(reproduced) === JSON.stringify(prior.arms.dual.packet),
          arms,
        } satisfies RetrievalRecord),
  );
}

function describeArms(
  record: LongMemEvalRecord,
  question: string,
  memory: readonly EvidencePacketItem[],
  packets: Partial<Record<ArmName, { packet: EvidencePacketItem[]; query?: string }>>,
): Partial<Record<ArmName, ArmPacket>> {
  const memorySessions = memory.map((item) => item.sessionId);
  const evidenceTurns = record.haystack_sessions.flatMap((turns) =>
    turns.filter((turn) => turn.has_answer).map((turn) => turn.content),
  );
  const answerable = category(record) !== "abstention";
  return Object.fromEntries(
    Object.entries(packets).map(([name, { packet, query }]) => {
      const rendered = requireMemoryInsideCap(question, memory, packet, maximumCharacters);
      const raw = packet.filter((item) => item.channel === "raw");
      const rawSessions = [...new Set(raw.map((item) => item.sessionId))];
      const gold = answerable
        ? rawSessions.filter((id) => record.answer_session_ids.includes(id))
        : [];
      return [
        name,
        {
          packet,
          ...(query === undefined ? {} : { query }),
          diagnostics: {
            inputCharacters: rendered.length,
            rawCharacters: raw.reduce((sum, item) => sum + item.text.length, 0),
            rawSources: raw.map((item) => item.id.slice("raw:".length)),
            goldRawSources: gold,
            newGoldRawSources: gold.filter((id) => !memorySessions.includes(id)),
            evidenceTurnCoverage: answerable ? evidenceTurnCoverage(rendered, evidenceTurns) : null,
            answerTextPresent: answerable
              ? answerTextPresent(rendered, String(record.answer))
              : null,
          },
        } satisfies ArmPacket,
      ];
    }),
  );
}

type AnswerArm = {
  inputSha256: string;
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reused?: "baseline-memory" | "baseline-dual" | "identical-input";
  correct?: boolean;
  judgment?: string;
  judgeInputTokens?: number | null;
  judgeOutputTokens?: number | null;
};
type AnswerRecord = { questionId: string; arms: Partial<Record<ArmName, AnswerArm>> };

async function judgeTemplates(): Promise<string[]> {
  const source = await readFile("evaluation/datasets/longmemeval/evaluate_qa.d6dc8b50.py", "utf8");
  if (sha(source) !== protocol.rubric.sourceSha256)
    throw new Error("Judge source checksum mismatch");
  const templates = [...source.matchAll(/template = "([^"\n]*)"/g)].map((match) =>
    present(match[1]).replaceAll("\\n", "\n"),
  );
  if (templates.length !== 5) throw new Error("Pinned judge templates changed");
  return templates;
}

const answersDirectory = (profile: ProfileName) => `${directory}/answers/${profile}`;

/** The pinned V1 template for the question's type, filled as evaluate_qa.py does. */
function rubricPrompt(templates: string[], record: LongMemEvalRecord, answer: string): string {
  const index = record.question_id.endsWith("_abs")
    ? 4
    : record.question_type === "temporal-reasoning"
      ? 1
      : record.question_type === "knowledge-update"
        ? 2
        : record.question_type === "single-session-preference"
          ? 3
          : 0;
  const values = [record.question, String(record.answer), answer];
  let at = 0;
  return present(templates[index]).replace(/\{\}/g, () => present(values[at++]));
}

function verdict(text: string): "yes" | "no" {
  const value = text.trim().toLowerCase().replace(/[.!]$/, "");
  if (value !== "yes" && value !== "no")
    throw new Error(`Judge did not return yes/no: ${JSON.stringify(text)}`);
  return value;
}

type Rejudgment = {
  questionId: string;
  arm: ArmName;
  memory: { first: boolean; second: boolean };
  other: { first: boolean; second: boolean };
};

/**
 * A second, independent Codex judgment of Memory-only and one arm. The Codex judge
 * has no temperature control, so this measures how much of a paired difference
 * survives judge resampling. Identical answers share one second judgment.
 */
async function rejudge(arm: ArmName, selected: LongMemEvalRecord[]) {
  const templates = await judgeTemplates();
  const { model, reasoningEffort } = ANSWER_PROFILES["gemini-codex"].judge;
  const output = `${directory}/rejudge/gemini-codex/${arm}`;
  await mkdir(output, { recursive: true });
  let completed = 0;
  await parallel(selected, 12, async (record) => {
    const path = `${output}/${record.question_id}.json`;
    if (await load(path)) return;
    const answers = present(
      await load<AnswerRecord>(`${answersDirectory("gemini-codex")}/${record.question_id}.json`),
    ).arms;
    const memory = present(answers.memory);
    const other = present(answers[arm]);
    const second = new Map<string, boolean>();
    for (const answer of new Set([memory.answer, other.answer])) {
      const prompt = rubricPrompt(templates, record, answer);
      const result = await withRetries(`${record.question_id} rejudge`, async () =>
        verdict((await runCodexText({ model, prompt, reasoningEffort })).text),
      );
      second.set(answer, result === "yes");
    }
    await save(path, {
      questionId: record.question_id,
      arm,
      memory: { first: present(memory.correct), second: present(second.get(memory.answer)) },
      other: { first: present(other.correct), second: present(second.get(other.answer)) },
    } satisfies Rejudgment);
    if (++completed % 50 === 0) console.log(`rejudged ${completed}/${selected.length}`);
  });
  const rows = await Promise.all(
    selected.map(async (record) =>
      present(await load<Rejudgment>(`${output}/${record.question_id}.json`)),
    ),
  );
  const agreement = rows.flatMap((row) => [row.memory, row.other]);
  const wins = rows
    .filter((row) => !row.memory.second && row.other.second)
    .map((row) => row.questionId);
  const losses = rows
    .filter((row) => row.memory.second && !row.other.second)
    .map((row) => row.questionId);
  const summary = {
    protocolHash,
    arm,
    questions: rows.length,
    judgeAgreement:
      agreement.filter((judgment) => judgment.first === judgment.second).length / agreement.length,
    secondJudgment: {
      memoryCorrect: rows.filter((row) => row.memory.second).length,
      armCorrect: rows.filter((row) => row.other.second).length,
      wins,
      losses,
      mcnemarExactP: mcnemarExactP(wins.length, losses.length),
      pairedLift95CI: pairedBootstrap95(
        rows.map((row) => Number(row.other.second) - Number(row.memory.second)),
      ),
    },
  };
  await save(`${directory}/rejudge-gemini-codex-${arm}.json`, summary);
  console.log(JSON.stringify(summary, null, 2));
}

/** Transient provider failures are retried; an answer is never synthesized. */
async function withRetries<T>(label: string, use: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await use();
    } catch (error) {
      if (attempt >= 5) throw error;
      console.warn(
        `${label}: attempt ${attempt} failed (${String(error).slice(0, 200)}); retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
    }
  }
}

async function answer(arm: ArmName, selected: LongMemEvalRecord[], profileName: ProfileName) {
  const profile = ANSWER_PROFILES[profileName];
  const reader = present(
    createBenchmarkReaderFromEnvironment(
      profileName === "baseline"
        ? {
            ...process.env,
            LORE_BENCHMARK_READER_PROVIDER: "vercel",
            LORE_BENCHMARK_READER_MODEL: "google/gemini-3.5-flash",
            LORE_BENCHMARK_READER_MAX_CONTEXT_CHARS: String(maximumCharacters),
            LORE_BENCHMARK_READER_MAX_OUTPUT_TOKENS: "8192",
          }
        : {
            LORE_BENCHMARK_READER_PROVIDER: "google",
            LORE_BENCHMARK_READER_MODEL: ANSWER_PROFILES["gemini-codex"].reader.model,
            LORE_BENCHMARK_READER_API_KEY: geminiKey,
            LORE_BENCHMARK_READER_MAX_CONTEXT_CHARS: String(maximumCharacters),
            LORE_BENCHMARK_READER_MAX_OUTPUT_TOKENS: "8192",
          },
    ),
  );
  const readerIdentity =
    profileName === "baseline"
      ? {
          model: reader.model,
          instruction: reader.instruction,
          instructionSha256: sha(reader.instruction),
          decoding: reader.decoding,
          profile: reader.profile,
          transport: reader.transport,
          maximumContextCharacters: reader.maximumContextCharacters,
        }
      : {
          model: reader.model,
          transport: reader.transport,
          instructionSha256: sha(reader.instruction),
          decoding: reader.decoding,
          profile: reader.profile,
          maximumContextCharacters: reader.maximumContextCharacters,
        };
  if (JSON.stringify(readerIdentity) !== JSON.stringify(profile.reader))
    throw new Error(`Reader configuration differs from profile ${profileName}`);
  const templates = await judgeTemplates();
  const client =
    profileName === "baseline"
      ? new OpenAI({
          apiKey: process.env.AI_GATEWAY_API_KEY,
          baseURL: "https://ai-gateway.vercel.sh/v1",
          maxRetries: 3,
          timeout: 120_000,
        })
      : undefined;
  const judge = async (prompt: string) => {
    if (client) {
      const response = await client.chat.completions.create({
        model: ANSWER_PROFILES.baseline.judge.model,
        temperature: 0,
        max_tokens: ANSWER_PROFILES.baseline.judge.maximumOutputTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return {
        text: response.choices[0]?.message.content ?? "",
        inputTokens: response.usage?.prompt_tokens ?? null,
        outputTokens: response.usage?.completion_tokens ?? null,
      };
    }
    const { model, reasoningEffort } = ANSWER_PROFILES["gemini-codex"].judge;
    return runCodexText({ model, prompt, reasoningEffort });
  };
  await mkdir(answersDirectory(profileName), { recursive: true });
  let completed = 0;
  // One process per profile: arms of a question share one answer file.
  await parallel(selected, 12, async (record) => {
    const path = `${answersDirectory(profileName)}/${record.question_id}.json`;
    const retrieval = present(
      await load<RetrievalRecord>(`${directory}/retrieval/${record.question_id}.json`),
    );
    const prior = await baseline(record);
    const result = (await load<AnswerRecord>(path)) ?? { questionId: record.question_id, arms: {} };
    const question = `Question time: ${record.question_date}\n${record.question}`;
    const rendered = (packet: EvidencePacketItem[]) =>
      renderBenchmarkReaderInput(question, packet, maximumCharacters);
    // Only the baseline profile may reuse the baseline's sampled answers.
    const baselineArms: Array<[AnswerArm["reused"], BaselineArm]> =
      profileName === "baseline"
        ? [
            ["baseline-memory", prior.arms.memory],
            ["baseline-dual", prior.arms.dual],
          ]
        : [];
    const packet = retrieval.arms[arm]?.packet;
    if (!packet) throw new Error(`${record.question_id}: no ${arm} packet; run --retrieve first`);
    if (!result.arms[arm]) {
      const input = rendered(packet);
      const inputSha256 = sha(input);
      // Identical reader input reuses one sampled answer, as in the baseline, so
      // sampling noise is never counted as a retrieval effect.
      const fromBaseline = baselineArms.find(([, other]) => rendered(other.packet) === input);
      const fromArm = Object.values(result.arms).find((other) => other.inputSha256 === inputSha256);
      if (fromBaseline) {
        const [reused, other] = fromBaseline;
        result.arms[arm] = {
          inputSha256,
          answer: other.answer,
          inputTokens: other.inputTokens,
          outputTokens: other.outputTokens,
          reused,
          correct: other.correct,
          judgment: other.judgment,
        };
      } else if (fromArm) {
        result.arms[arm] = { ...fromArm, reused: "identical-input" };
      } else {
        const response = await withRetries(`${record.question_id} reader`, async () => {
          const result = await reader.answer({ question, evidence: packet });
          if (!result.text.trim() || result.finishReason === "length")
            throw new Error(`${record.question_id}: reader incomplete`);
          return result;
        });
        result.arms[arm] = {
          inputSha256,
          answer: response.text,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        };
      }
      await save(path, result);
    }
    const current = present(result.arms[arm]);
    if (current.correct === undefined) {
      const judged = [
        ...baselineArms.map(([, other]) => other),
        ...Object.values(result.arms),
      ].find((other) => other.correct !== undefined && other.answer === current.answer);
      if (judged?.correct !== undefined && judged.judgment !== undefined) {
        current.correct = judged.correct;
        current.judgment = judged.judgment;
      } else {
        const prompt = rubricPrompt(templates, record, current.answer);
        const response = await withRetries(`${record.question_id} judge`, async () => {
          const result = await judge(prompt);
          return { ...result, text: verdict(result.text) };
        });
        current.judgment = response.text;
        current.correct = response.text === "yes";
        current.judgeInputTokens = response.inputTokens;
        current.judgeOutputTokens = response.outputTokens;
      }
      await save(path, result);
    }
    completed++;
    console.log(
      `${arm} ${completed}/${selected.length} ${record.question_id}: ${current.correct}` +
        (current.reused ? ` (${current.reused})` : ""),
    );
  });
}

async function summarize(selected: LongMemEvalRecord[], profileName?: ProfileName) {
  const rows = await Promise.all(
    selected.map(async (record) => ({
      record,
      retrieval: present(
        await load<RetrievalRecord>(`${directory}/retrieval/${record.question_id}.json`),
      ),
      answers: profileName
        ? await load<AnswerRecord>(`${answersDirectory(profileName)}/${record.question_id}.json`)
        : undefined,
    })),
  );
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const defined = <T>(values: Array<T | null | undefined>) =>
    values.filter((value): value is T => value !== null && value !== undefined);
  const answered = (Object.keys(ARMS) as ArmName[]).filter((arm) =>
    rows.every((row) => row.answers?.arms[arm]?.correct !== undefined),
  );
  const retrievalSummary = Object.fromEntries(
    (Object.keys(ARMS) as ArmName[]).map((arm) => {
      const diagnostics = defined(rows.map((row) => row.retrieval.arms[arm]?.diagnostics));
      return [
        arm,
        {
          questions: diagnostics.length,
          questionsWithRaw: diagnostics.filter((d) => d.rawSources.length).length,
          meanInputCharacters: mean(diagnostics.map((d) => d.inputCharacters)),
          meanRawCharacters: mean(diagnostics.map((d) => d.rawCharacters)),
          meanRawSources: mean(diagnostics.map((d) => d.rawSources.length)),
          questionsWithGoldRaw: diagnostics.filter((d) => d.goldRawSources.length).length,
          questionsWithNewGoldRaw: diagnostics.filter((d) => d.newGoldRawSources.length).length,
          meanEvidenceTurnCoverage: mean(defined(diagnostics.map((d) => d.evidenceTurnCoverage))),
          answerTextPresent: (() => {
            const values = defined(diagnostics.map((d) => d.answerTextPresent));
            return { eligible: values.length, present: values.filter(Boolean).length };
          })(),
        },
      ];
    }),
  );
  const answerSummary = Object.fromEntries(
    answered.map((arm) => {
      const paired = rows.map((row) => ({
        id: row.record.question_id,
        category: row.retrieval.category,
        memory: present(row.answers?.arms.memory),
        arm: present(row.answers?.arms[arm]),
        diagnostics: present(row.retrieval.arms[arm]).diagnostics,
      }));
      const describe = (subset: typeof paired) => {
        const wins = subset.filter((p) => !p.memory.correct && p.arm.correct);
        const losses = subset.filter((p) => p.memory.correct && !p.arm.correct);
        return {
          count: subset.length,
          correct: subset.filter((p) => p.arm.correct).length,
          accuracy: mean(subset.map((p) => Number(p.arm.correct))),
          memoryAccuracy: mean(subset.map((p) => Number(p.memory.correct))),
          wins: wins.map((p) => p.id),
          losses: losses.map((p) => p.id),
        };
      };
      const total = describe(paired);
      const deltas = paired.map((p) => Number(p.arm.correct) - Number(p.memory.correct));
      const tokens = defined(paired.map((p) => p.arm.inputTokens));
      const memoryTokens = defined(paired.map((p) => p.memory.inputTokens));
      // Gated: answer from Memory first and read this arm's packet only when that
      // answer declines. Reader input counts both calls for escalated questions.
      const gated = (() => {
        const escalated = paired.filter((p) => answerDeclines(p.memory.answer));
        const outcome = (p: (typeof paired)[number]) =>
          escalated.includes(p) ? p.arm.correct : p.memory.correct;
        const wins = escalated.filter((p) => !p.memory.correct && p.arm.correct);
        const losses = escalated.filter((p) => p.memory.correct && !p.arm.correct);
        const gatedTokens =
          tokens.length === paired.length && memoryTokens.length === paired.length
            ? mean(
                paired.map(
                  (p) =>
                    (p.memory.inputTokens ?? 0) +
                    (escalated.includes(p) ? (p.arm.inputTokens ?? 0) : 0),
                ),
              )
            : null;
        return {
          escalated: escalated.length,
          memoryFailuresNotEscalated: paired.filter(
            (p) => !p.memory.correct && !escalated.includes(p),
          ).length,
          correct: paired.filter(outcome).length,
          accuracy: mean(paired.map((p) => Number(outcome(p)))),
          wins: wins.map((p) => p.id),
          losses: losses.map((p) => p.id),
          mcnemarExactP: mcnemarExactP(wins.length, losses.length),
          meanInputTokens: gatedTokens,
          inputTokenRatioToMemory:
            gatedTokens === null ? null : gatedTokens / (mean(memoryTokens) ?? 1),
        };
      })();
      return [
        arm,
        {
          ...total,
          mcnemarExactP: mcnemarExactP(total.wins.length, total.losses.length),
          pairedLift95CI: pairedBootstrap95(deltas),
          meanInputTokens: mean(tokens),
          inputTokenRatioToMemory:
            tokens.length && memoryTokens.length
              ? (mean(tokens) ?? 0) / (mean(memoryTokens) ?? 1)
              : null,
          reused: paired.filter((p) => p.arm.reused).length,
          gated: arm === "memory" ? null : gated,
          winsAddingNewGoldSource: total.wins.filter(
            (id) => paired.find((p) => p.id === id)?.diagnostics.newGoldRawSources.length,
          ),
          categories: Object.fromEntries(
            [...new Set(paired.map((p) => p.category))].map((name) => [
              name,
              describe(paired.filter((p) => p.category === name)),
            ]),
          ),
        },
      ];
    }),
  );
  const summary = {
    protocolHash,
    answerProfile: profileName ?? null,
    questions: rows.length,
    sample: rows.length === smokeIds.size ? "smoke" : "all",
    rawQuestionReproduced: rows.filter((row) => row.retrieval.rawQuestionReproduced).length,
    isolationFailures: 0,
    retrieval: retrievalSummary,
    answers: answerSummary,
  };
  await save(
    `${directory}/summary-${profileName ?? "retrieval"}${summary.sample === "smoke" ? "-smoke" : ""}.json`,
    summary,
  );
  console.log(JSON.stringify(summary, null, 2));
}

try {
  await requireMigratedBenchmarkSchema(admin);
  const smoke = process.argv.includes("--smoke");
  const selected = smoke ? records.filter((r) => smokeIds.has(r.question_id)) : records;
  if (process.argv.includes("--prepare")) {
    await admin.query(
      "INSERT INTO users(id,display_name) VALUES($1,'Alice source expansion'),($2,'Bob source expansion') ON CONFLICT(id) DO NOTHING",
      [alice, bob],
    );
    await parallel(records, 6, seed);
    await admin.query("ANALYZE");
    console.log("Preparation complete");
  } else if (process.argv.includes("--embed")) {
    if (!embeddingProvider) throw new Error("GEMINI_API_KEY is required");
    const { dimensions, model, revision } = protocol.episodeDenseEmbeddings;
    await admin.query(
      `INSERT INTO embedding_generations(id,embedding_provider,embedding_model,embedding_dimensions,embedding_revision,status,activated_at)
      VALUES($1,'google',$2,$3,$4,'active',now()) ON CONFLICT(id) DO NOTHING`,
      [generationId, model, dimensions, revision],
    );
    const usagePath = `${directory}/embedding-usage.json`;
    try {
      await parallel(selected, 8, embed);
    } finally {
      const total = (await load<typeof embeddingUsage>(usagePath)) ?? {
        requests: 0,
        texts: 0,
        characters: 0,
        failures: 0,
      };
      for (const key of Object.keys(embeddingUsage) as Array<keyof typeof embeddingUsage>)
        total[key] += embeddingUsage[key];
      await save(usagePath, total);
      console.log(JSON.stringify({ run: embeddingUsage, total }));
    }
  } else if (process.argv.includes("--retrieve")) {
    let done = 0;
    await parallel(records, 8, async (record) => {
      await retrieve(record);
      if (++done % 50 === 0) console.log(`retrieved ${done}/500`);
    });
    await summarize(records);
  } else if (process.argv.includes("--answer")) {
    const arm = option("--answer");
    const profileName = option("--profile");
    if (!isArm(arm)) throw new Error(`--answer needs one of ${Object.keys(ARMS).join(", ")}`);
    if (!isProfile(profileName))
      throw new Error(`--profile needs one of ${Object.keys(ANSWER_PROFILES).join(", ")}`);
    if (profileName === "baseline" && !process.env.AI_GATEWAY_API_KEY)
      throw new Error("AI_GATEWAY_API_KEY is required");
    if (profileName === "gemini-codex" && !geminiKey) throw new Error("GEMINI_API_KEY is required");
    // The Memory arm comes first: every other arm is paired against it.
    if (arm !== "memory") await answer("memory", selected, profileName);
    await answer(arm, selected, profileName);
    await summarize(selected, profileName);
  } else if (process.argv.includes("--rejudge")) {
    const arm = option("--rejudge");
    if (!isArm(arm) || arm === "memory")
      throw new Error("--rejudge needs one non-memory arm answered under gemini-codex");
    await rejudge(arm, selected);
  } else if (process.argv.includes("--summarize")) {
    const profileName = option("--profile");
    if (profileName !== undefined && !isProfile(profileName))
      throw new Error(`--profile needs one of ${Object.keys(ANSWER_PROFILES).join(", ")}`);
    await summarize(selected, profileName);
  } else {
    throw new Error("Choose --prepare, --retrieve, --answer <arm>, or --summarize");
  }
} finally {
  await Promise.allSettled([admin.end(), database.close()]);
}
