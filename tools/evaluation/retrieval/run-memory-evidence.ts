/**
 * Paired LongMemEval-S evaluation: frozen extracted facts vs facts + raw evidence.
 * Uses a NEW disposable, currently migrated database; the legacy corpus is read-only.
 * Prepare: LEGACY_BENCHMARK_DATABASE_URL=... BENCHMARK_DATABASE_URL=... bun <this> --prepare
 * Run: same environment + AI_GATEWAY_API_KEY, bun <this> [--max-cases N]
 * Download the pinned S split with fetch-longmemeval.ts first. Judge source is
 * MIT: xiaowu0162/LongMemEval@d6dc8b50a2d9ac0c99485ea28fa5755c62414c34,
 * src/evaluation/evaluate_qa.py (download to evaluation/datasets/longmemeval/).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chunkMemoryContent, MEMORY_CHUNKING_REVISION } from "@corespeed/lore-core";
import { EPISODE_EVIDENCE_RETRIEVAL_POLICY } from "@corespeed/lore-core/episodes";
import OpenAI from "openai";
import pg from "pg";
import { createEpisodeEvidenceModule } from "../../../src/modules/episodes/evidence";
import { createObservationModule } from "../../../src/modules/episodes/service";
import {
  createMemoryModule,
  createMemoryMutationPrimitives,
} from "../../../src/modules/memories/service";
import { installActorContext } from "../../../src/server/auth/actor-context";
import { createPostgresDatabase } from "../../../src/server/database/postgres";
import { createVercelAIGatewayEmbeddingProvider } from "../../../src/server/providers/embedding/openai-compatible";
import {
  createBenchmarkReaderFromEnvironment,
  renderBenchmarkReaderInput,
} from "../shared/benchmark-reader";
import { requireMigratedBenchmarkSchema } from "../shared/benchmark-schema";
import { verifyFile } from "../shared/file-integrity";
import { readJsonArray } from "../shared/json-array";
import {
  type LongMemEvalRecord,
  longMemEvalManifest,
  parseLongMemEvalRecord,
  toLongMemEvalPartition,
} from "./longmemeval";

function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Required benchmark value is missing");
  return value;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const alice = "00000000-0000-4000-8000-000000000701";
const bob = "00000000-0000-4000-8000-000000000702";
const directory = resolve(
  process.env.LORE_DUAL_EVAL_OUTPUT ?? "evaluation/results/dual-memory-evidence-20261012-v2",
);
const legacyUrl = process.env.LEGACY_BENCHMARK_DATABASE_URL;
const benchmarkUrl = process.env.BENCHMARK_DATABASE_URL;
if (!legacyUrl || !benchmarkUrl)
  throw new Error("Both benchmark database environment variables are required");
if (
  legacyUrl === benchmarkUrl ||
  !/(^|_)bench(mark)?($|_)/i.test(new URL(benchmarkUrl).pathname.slice(1))
) {
  throw new Error("Use a separate disposable benchmark database");
}
const maximum = process.argv.includes("--max-cases")
  ? Number(process.argv[process.argv.indexOf("--max-cases") + 1])
  : 500;
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 500)
  throw new Error("Invalid --max-cases");
const prepare = process.argv.includes("--prepare");
const startAt = process.argv.includes("--start-at")
  ? Number(process.argv[process.argv.indexOf("--start-at") + 1])
  : 0;
if (!Number.isInteger(startAt) || startAt < 0 || startAt >= 500)
  throw new Error("Invalid --start-at");
const datasetPath = resolve("evaluation/datasets/longmemeval/longmemeval_s_cleaned.json");
await verifyFile(datasetPath, longMemEvalManifest.files.s);
await mkdir(directory, { recursive: true });
const records: LongMemEvalRecord[] = [];
for await (const value of readJsonArray(datasetPath)) records.push(parseLongMemEvalRecord(value));
if (records.length !== 500) throw new Error("Expected the complete 500-question S split");

// Cache identity is retained only because an exact-text document probe matched
// the old Google vector (cosine 1), including Gemini's retrieval task prefix.
const gateway = createVercelAIGatewayEmbeddingProvider(
  {
    provider: "vercel",
    model: "google/gemini-embedding-2",
    dimensions: 1536,
    revision: "lore-embedding-v1",
  },
  { apiKey: process.env.AI_GATEWAY_API_KEY ?? "" },
);
let embeddingFailures = 0;
const embedding = {
  ...gateway,
  provider: "google",
  model: "gemini-embedding-2",
  embed: (texts: string[], task: "query" | "document") =>
    gateway
      .embed(
        texts.map((text) =>
          task === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`,
        ),
        task,
      )
      .catch((error: unknown) => {
        embeddingFailures++;
        throw error;
      }),
};
const admin = new pg.Pool({ connectionString: benchmarkUrl, max: 10 });
const legacy = new pg.Pool({
  connectionString: legacyUrl,
  max: 8,
  options: "-c default_transaction_read_only=on",
});
const database = createPostgresDatabase({ connectionString: benchmarkUrl, max: 10 });
await requireMigratedBenchmarkSchema(admin);
// Provider aliases are insufficient to establish a reusable vector space. Check
// a frozen exact-text vector against the current transport before every run.
const probe = present(
  (
    await legacy.query<{ content: string; vector: string }>(
      `SELECT c.content,e.embedding::text AS vector FROM memory_chunks c
       JOIN memories m ON m.id=c.memory_id
       JOIN memory_chunk_embeddings e ON e.chunk_id=c.id
       JOIN embedding_generations g ON g.id=e.generation_id
       WHERE m.metadata->>'factsCorpus'='longmemeval-facts-v1'
         AND COALESCE(m.metadata->>'isolationTripwire','false') <> 'true'
         AND g.embedding_model='gemini-embedding-2' AND g.embedding_dimensions=1536
         AND g.status='active' ORDER BY c.id LIMIT 1`,
    )
  ).rows[0],
);
const storedProbe = JSON.parse(probe.vector) as number[];
const currentProbe = present((await embedding.embed([probe.content], "document"))[0]);
const dot = storedProbe.reduce(
  (sum, value, index) => sum + value * present(currentProbe[index]),
  0,
);
const norm = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
const probeCosine = dot / (norm(storedProbe) * norm(currentProbe));
if (!Number.isFinite(probeCosine) || probeCosine < 0.999999)
  throw new Error("Cached vectors do not match the current embedding transport");
await writeFile(
  `${directory}/embedding-probe.json`,
  JSON.stringify(
    { contentSha256: sha(probe.content), dimensions: currentProbe.length, cosine: probeCosine },
    null,
    2,
  ),
);
const generationId = "00000000-0000-4000-8000-000000000703";
type Fact = { id: string; content: string; metadata: Record<string, unknown> };
type CachedChunk = {
  memory_id: string;
  ordinal: number;
  content: string;
  chunking_revision: string;
  vector: string;
};
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
async function parallel<T>(items: T[], concurrency: number, use: (item: T) => Promise<void>) {
  let next = 0;
  // Await every worker even when one fails, before closing its database.
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) await use(present(items[next++]));
    }),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
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
async function seed(record: LongMemEvalRecord) {
  const qid = record.question_id;
  const ws = (
    await legacy.query<{ workspace_id: string }>(
      "SELECT DISTINCT workspace_id FROM memories WHERE metadata->>'benchmarkPartition'=$1",
      [`${qid}#facts`],
    )
  ).rows;
  if (ws.length !== 1) throw new Error(`${qid}: frozen corpus Workspace mismatch`);
  const workspaceId = present(ws[0]).workspace_id;
  const existing = (await admin.query("SELECT name FROM workspaces WHERE id=$1", [workspaceId]))
    .rows[0];
  if (existing?.name === `Dual evidence ready ${qid}`) return;
  if (existing) {
    for (let attempt = 0; attempt < 300; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (
        (await admin.query("SELECT name FROM workspaces WHERE id=$1", [workspaceId])).rows[0]
          ?.name === `Dual evidence ready ${qid}`
      )
        return;
    }
    throw new Error(`${qid}: partial seed found; inspect it before retrying`);
  }
  const facts = (
    await legacy.query<Fact>(
      "SELECT id,content,metadata FROM memories WHERE workspace_id=$1 AND metadata->>'benchmarkPartition'=$2 AND COALESCE(metadata->>'isolationTripwire','false') <> 'true' ORDER BY id",
      [workspaceId, `${qid}#facts`],
    )
  ).rows;
  const raw = sources(record);
  const factKeys = toLongMemEvalPartition(record)
    .memories.filter((m) => m.owner === "alice")
    .map((m) => m.key);
  if (
    facts.length !== factKeys.length ||
    new Set(facts.map((f) => f.metadata.benchmarkKey)).size !== factKeys.length ||
    factKeys.some((key) => !facts.some((f) => f.metadata.benchmarkKey === key))
  )
    throw new Error(`${qid}: fact/source mismatch`);
  const chunks = (
    await legacy.query<CachedChunk>(
      `SELECT c.memory_id,c.ordinal,c.content,c.chunking_revision,e.embedding::text AS vector
     FROM memory_chunks c JOIN memory_chunk_embeddings e ON e.chunk_id=c.id
     JOIN embedding_generations g ON g.id=e.generation_id
     WHERE c.workspace_id=$1 AND c.memory_id=ANY($2::uuid[]) AND g.status='active'
       AND g.embedding_provider='google' AND g.embedding_model='gemini-embedding-2'
       AND g.embedding_dimensions=1536 AND g.embedding_revision='lore-embedding-v1'
     ORDER BY c.memory_id,c.ordinal`,
      [workspaceId, facts.map((f) => f.id)],
    )
  ).rows;
  for (const fact of facts) {
    const exact = chunkMemoryContent(fact.content);
    const cached = chunks.filter((c) => c.memory_id === fact.id);
    if (
      exact.length !== cached.length ||
      exact.some(
        (text, i) =>
          cached[i]?.content !== text ||
          cached[i]?.ordinal !== i ||
          cached[i]?.chunking_revision !== MEMORY_CHUNKING_REVISION,
      )
    ) {
      throw new Error(`${qid}: cached vectors do not match the current exact chunk sequence`);
    }
  }
  await admin.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
    workspaceId,
    `Dual evidence building ${qid}`,
  ]);
  await admin.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",
    [workspaceId, alice, bob],
  );
  const actor = { workspaceId, userId: alice };
  const freshIds = new Map(facts.map((f) => [f.id, randomUUID()]));
  await database.transaction(async (tx) => {
    installActorContext(tx, actor);
    await createMemoryMutationPrimitives().insertMemoriesInTransaction(
      tx,
      actor,
      facts.map((fact) => ({
        id: present(freshIds.get(fact.id)),
        content: fact.content,
        metadata: fact.metadata,
        scope: "private",
      })),
    );
  });
  // Benchmark-only exact-vector import after engine admission/chunk verification;
  // this is not a production write surface and never touches the legacy corpus.
  await admin.query(
    `INSERT INTO memory_chunk_embeddings(generation_id,workspace_id,memory_id,chunk_id,embedding)
    SELECT $1::uuid,c.workspace_id,c.memory_id,c.id,r.vector::vector(1536)
    FROM jsonb_to_recordset($2::jsonb) r(memory_id uuid,ordinal integer,vector text)
    JOIN memory_chunks c ON c.memory_id=r.memory_id AND c.ordinal=r.ordinal
    WHERE c.workspace_id=$3`,
    [
      generationId,
      JSON.stringify(
        chunks.map((c) => ({
          memory_id: freshIds.get(c.memory_id),
          ordinal: c.ordinal,
          vector: c.vector,
        })),
      ),
      workspaceId,
    ],
  );
  const observations = createObservationModule(database);
  // Recording does not index raw evidence; each Episode is indexed explicitly.
  const evidence = createEpisodeEvidenceModule(database);
  let batch: typeof raw = [];
  let characters = 0;
  const flush = async () => {
    if (!batch.length) return;
    const episode = await observations.record(actor, {
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
          corpus: "longmemeval-raw-v1",
        },
      })),
    });
    await evidence.index(actor, { episodeId: episode.id });
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
  const tripwire = `Confidential Bob private answer. ${record.question}\n${record.answer}`;
  await createMemoryModule(database, { embeddingDimensions: 1536 }).remember(
    { workspaceId, userId: bob },
    {
      content: tripwire,
      scope: "private",
      metadata: { benchmarkPartition: `${qid}#facts`, benchmarkKey: "__bob_private_tripwire__" },
    },
  );
  const bobActor = { workspaceId, userId: bob };
  const canary = await observations.record(bobActor, {
    kind: "conversation",
    scope: "private",
    observations: [
      {
        kind: "message",
        content: tripwire,
        metadata: {
          questionId: qid,
          sessionId: "__bob_private_tripwire__",
          benchmarkKey: "__bob_private_tripwire__",
          corpus: "longmemeval-raw-v1",
        },
      },
    ],
  });
  await evidence.index(bobActor, { episodeId: canary.id });
  const coverage = (
    await admin.query(
      `SELECT
    (SELECT count(*)::int FROM memory_chunks c JOIN memories m ON m.id=c.memory_id WHERE c.workspace_id=$1 AND m.owner_user_id=$2) AS chunks,
    (SELECT count(*)::int FROM memory_chunk_embeddings WHERE workspace_id=$1) AS vectors,
    (SELECT count(*)::int FROM observations o JOIN episodes e ON e.id=o.episode_id WHERE o.workspace_id=$1 AND e.owner_user_id=$2) AS observations`,
      [workspaceId, alice],
    )
  ).rows[0];
  if (
    coverage.chunks !== chunks.length ||
    coverage.vectors !== chunks.length ||
    coverage.observations !== raw.length
  )
    throw new Error("Seed coverage incomplete");
  await admin.query("UPDATE workspaces SET name=$2 WHERE id=$1", [
    workspaceId,
    `Dual evidence ready ${qid}`,
  ]);
  console.log(
    `seed ${qid}: ${facts.length} facts, ${chunks.length} cached vectors, ${raw.length} raw sessions`,
  );
}

type Packet = { id: string; text: string; sessionId: string; channel: "memory" | "raw" };
type Arm = {
  packet: Packet[];
  inputCharacters: number;
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  correct?: boolean;
  judgment?: string;
};
type Result = {
  questionId: string;
  category: string;
  expected: string[];
  arms: Record<string, Arm>;
  retrieval: Record<string, string[]>;
};
const reader = present(
  createBenchmarkReaderFromEnvironment({
    ...process.env,
    LORE_BENCHMARK_READER_PROVIDER: "vercel",
    LORE_BENCHMARK_READER_MODEL: "google/gemini-3.5-flash",
    LORE_BENCHMARK_READER_MAX_CONTEXT_CHARS: "24000",
    LORE_BENCHMARK_READER_MAX_OUTPUT_TOKENS: "8192",
  }),
);
const judgeModel = "openai/gpt-4o";
const client = new OpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: "https://ai-gateway.vercel.sh/v1",
  maxRetries: 3,
  timeout: 120_000,
});
const protocol = {
  revision: "longmemeval-frozen-facts-plus-lexical-evidence-v1",
  dataset: longMemEvalManifest,
  factCorpus: "longmemeval-facts-v1",
  extractor: "gemini-3.5-flash-lite",
  embedding: {
    provider: embedding.provider,
    model: embedding.model,
    revision: embedding.revision,
    dimensions: embedding.dimensions,
    taskPrefix: "gemini-embedding-2-retrieval",
    cachedDocumentProbeCosine: Math.round(probeCosine * 1e12) / 1e12,
  },
  episodePolicy: EPISODE_EVIDENCE_RETRIEVAL_POLICY,
  episodeDenseEmbeddings: false,
  reader: {
    model: reader.model,
    instruction: reader.instruction,
    instructionSha256: sha(reader.instruction),
    decoding: reader.decoding,
    profile: reader.profile,
    transport: reader.transport,
    maximumContextCharacters: reader.maximumContextCharacters,
  },
  judge: {
    model: judgeModel,
    maximumOutputTokens: 16,
    upstreamCommit: "d6dc8b50a2d9ac0c99485ea28fa5755c62414c34",
    sourceSha256: "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251",
  },
  packet: {
    perChannelLimit: 10,
    merge: "alternate-memory-raw-preserving-channel-rank",
    memoryContent: "retrieved-excerpt",
    rawContent: "retrieved-excerpt",
    totalLimit: "24000 UTF-16 code units including question/headers",
    questionDate: true,
    reuseIdenticalInputs: true,
  },
};
const protocolHash = sha(JSON.stringify(protocol));
const previous = await load<{ protocolHash: string }>(`${directory}/protocol.json`);
if (previous && previous.protocolHash !== protocolHash)
  throw new Error("Output directory belongs to a different protocol");
await save(`${directory}/protocol.json`, { protocolHash, protocol });

try {
  if (prepare) {
    await admin.query(
      "INSERT INTO users(id,display_name) VALUES($1,'Alice dual eval'),($2,'Bob dual eval') ON CONFLICT(id) DO NOTHING",
      [alice, bob],
    );
    await admin.query(
      `INSERT INTO embedding_generations(id,embedding_provider,embedding_model,embedding_dimensions,embedding_revision,status,activated_at)
      VALUES($1,'google','gemini-embedding-2',1536,'lore-embedding-v1','active',now()) ON CONFLICT(id) DO NOTHING`,
      [generationId],
    );
    await parallel(records.slice(startAt, maximum), 6, seed);
    await admin.query("ANALYZE");
    console.log("Preparation complete");
  } else {
    const source = await readFile(
      "evaluation/datasets/longmemeval/evaluate_qa.d6dc8b50.py",
      "utf8",
    );
    if (sha(source) !== protocol.judge.sourceSha256)
      throw new Error("Judge source checksum mismatch");
    const templates = [...source.matchAll(/template = "([^"\n]*)"/g)].map((m) =>
      present(m[1]).replaceAll("\\n", "\n"),
    );
    if (templates.length !== 5) throw new Error("Pinned judge templates changed");
    const memory = createMemoryModule(database, {
      embeddingDimensions: 1536,
      embeddingProvider: embedding,
    });
    const evidence = createEpisodeEvidenceModule(database, { embeddingDimensions: 1536 });
    let completed = 0;
    await parallel(records.slice(0, maximum), 8, async (record) => {
      const path = `${directory}/${record.question_id}.json`;
      let result = await load<Result>(path);
      if (!result?.arms.memory || !result?.arms.dual) {
        let row = (
          await admin.query("SELECT id,name FROM workspaces WHERE name=$1", [
            `Dual evidence ready ${record.question_id}`,
          ])
        ).rows[0];
        if (!row) console.log(`waiting for seed ${record.question_id}`);
        for (let attempt = 0; !row && attempt < 300; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          row = (
            await admin.query("SELECT id,name FROM workspaces WHERE name=$1", [
              `Dual evidence ready ${record.question_id}`,
            ])
          ).rows[0];
        }
        if (!row) throw new Error(`${record.question_id}: run --prepare first`);
        const actor = { workspaceId: row.id as string, userId: alice };
        const [memories, raw] = await Promise.all([
          memory.search(actor, {
            query: record.question,
            limit: 10,
            metadataFilter: { benchmarkPartition: `${record.question_id}#facts` },
          }),
          evidence.search(actor, {
            query: record.question,
            limit: 10,
            metadataFilter: { questionId: record.question_id, corpus: "longmemeval-raw-v1" },
            groupMetadataKey: "benchmarkKey",
          }),
        ]);
        if (embeddingFailures)
          throw new Error("Query embedding failed; refusing a silent lexical-only baseline");
        if (
          memories.some(
            (m) =>
              m.memory.ownerUserId !== alice ||
              m.memory.metadata.benchmarkKey === "__bob_private_tripwire__",
          ) ||
          raw.some((r) => r.sourceKey === "__bob_private_tripwire__")
        )
          throw new Error("RLS ISOLATION FAILURE");
        const m: Packet[] = memories.map((r) => ({
          id: `memory:${r.memory.metadata.benchmarkKey}`,
          channel: "memory",
          sessionId: String(r.memory.metadata.sessionId),
          text: `Session date: ${r.memory.metadata.sessionDate}\n${r.evidence}`,
        }));
        const e: Packet[] = raw.map((r) => ({
          id: `raw:${r.sourceKey}`,
          channel: "raw",
          sessionId: String(r.metadata.sessionId),
          text: `Session date: ${r.metadata.sessionDate}\n${r.evidence}`,
        }));
        const dual = Array.from({ length: Math.max(m.length, e.length) }, (_, i) => [m[i], e[i]])
          .flat()
          .filter((v): v is Packet => v !== undefined);
        result ??= {
          questionId: record.question_id,
          category: record.question_id.endsWith("_abs") ? "abstention" : record.question_type,
          expected: record.answer_session_ids,
          arms: {},
          retrieval: { memory: m.map((v) => v.sessionId), raw: e.map((v) => v.sessionId) },
        };
        for (const [name, packet] of Object.entries({ memory: m, dual })) {
          if (result.arms[name]) continue;
          const question = `Question time: ${record.question_date}\n${record.question}`;
          const prompt = renderBenchmarkReaderInput(
            question,
            packet,
            reader.maximumContextCharacters,
          );
          const cached = Object.values(result.arms).find(
            (arm) =>
              renderBenchmarkReaderInput(question, arm.packet, reader.maximumContextCharacters) ===
              prompt,
          );
          const response = cached
            ? {
                text: cached.answer,
                inputTokens: cached.inputTokens,
                outputTokens: cached.outputTokens,
                finishReason: undefined,
              }
            : await reader.answer({ question, evidence: packet });
          if (!response.text.trim() || response.finishReason === "length")
            throw new Error(`${record.question_id}: reader incomplete`);
          result.arms[name] = {
            packet,
            inputCharacters: renderBenchmarkReaderInput(
              question,
              packet,
              reader.maximumContextCharacters,
            ).length,
            answer: response.text,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
          };
          await save(path, result);
        }
      }
      // Resume a partially written question without silently dropping an arm.
      if (!result.arms.memory || !result.arms.dual)
        throw new Error(`${record.question_id}: partial reader result; inspect before resuming`);
      for (const arm of Object.values(result.arms)) {
        if (arm.correct !== undefined) continue;
        const cached = Object.values(result.arms).find(
          (other) => other.correct !== undefined && other.answer === arm.answer,
        );
        if (cached) {
          arm.correct = cached.correct;
          arm.judgment = cached.judgment;
          await save(path, result);
          continue;
        }
        const index = record.question_id.endsWith("_abs")
          ? 4
          : record.question_type === "temporal-reasoning"
            ? 1
            : record.question_type === "knowledge-update"
              ? 2
              : record.question_type === "single-session-preference"
                ? 3
                : 0;
        const values = [record.question, String(record.answer), arm.answer];
        let at = 0;
        const prompt = present(templates[index]).replace(/\{\}/g, () => present(values[at++]));
        const judged = await client.chat.completions.create({
          model: judgeModel,
          temperature: 0,
          max_tokens: 16,
          messages: [{ role: "user", content: prompt }],
        });
        const text = judged.choices[0]?.message.content?.trim().toLowerCase().replace(/[.!]$/, "");
        if (text !== "yes" && text !== "no")
          throw new Error(
            `Judge did not return an unambiguous yes/no: ${JSON.stringify(judged.choices[0])}`,
          );
        arm.judgment = text;
        arm.correct = text === "yes";
        await save(path, result);
      }
      completed++;
      console.log(
        `scored ${completed}/${maximum} ${record.question_id}: memory=${result.arms.memory.correct} dual=${result.arms.dual.correct}`,
      );
    });
    const results = await Promise.all(
      records.slice(0, maximum).map((r) => load<Result>(`${directory}/${r.question_id}.json`)),
    );
    if (results.some((r) => !r || Object.values(r.arms).some((a) => a.correct === undefined)))
      throw new Error("Incomplete scores");
    const complete = results.map((r) => present(r));
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const describe = (subset: Result[]) => ({
      count: subset.length,
      memoryAccuracy: mean(subset.map((r) => Number(r.arms.memory.correct))),
      dualAccuracy: mean(subset.map((r) => Number(r.arms.dual.correct))),
      wins: subset
        .filter((r) => !r.arms.memory.correct && r.arms.dual.correct)
        .map((r) => r.questionId),
      losses: subset
        .filter((r) => r.arms.memory.correct && !r.arms.dual.correct)
        .map((r) => r.questionId),
      memoryMeanInputTokens: mean(subset.map((r) => r.arms.memory.inputTokens ?? NaN)),
      dualMeanInputTokens: mean(subset.map((r) => r.arms.dual.inputTokens ?? NaN)),
    });
    const positive = complete.filter((r) => r.category !== "abstention");
    const recall = (r: Result, ids: string[]) =>
      new Set(r.expected.filter((id) => ids.includes(id))).size / new Set(r.expected).size;
    // Deterministic paired bootstrap for the percentage-point difference.
    let state = 20261012;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const deltas = complete.map((r) => Number(r.arms.dual.correct) - Number(r.arms.memory.correct));
    const bootstrap = Array.from({ length: 10000 }, () =>
      mean(deltas.map(() => present(deltas[Math.floor(random() * deltas.length)]))),
    ).sort((a, b) => a - b);
    const summary = {
      protocolHash,
      total: describe(complete),
      categories: Object.fromEntries(
        [...new Set(complete.map((r) => r.category))].map((c) => [
          c,
          describe(complete.filter((r) => r.category === c)),
        ]),
      ),
      pairedLift95CI: [bootstrap[250], bootstrap[9749]],
      retrieval: {
        positiveQuestions: positive.length,
        memorySessionRecallAt10: mean(positive.map((r) => recall(r, r.retrieval.memory))),
        rawSessionRecallAt10: mean(positive.map((r) => recall(r, r.retrieval.raw))),
        unionSessionRecallAt10Each: mean(
          positive.map((r) => recall(r, [...r.retrieval.memory, ...r.retrieval.raw])),
        ),
      },
      isolationFailures: 0,
    };
    await save(`${directory}/summary.json`, summary);
    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await Promise.allSettled([admin.end(), legacy.end(), database.close()]);
}
