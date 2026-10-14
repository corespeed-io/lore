import pg from "pg";
import { sha256 } from "./hash";
import type { Packet, RetrievalMetrics } from "./types";

export interface StoredAnswer {
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface StoredVerdict {
  score: number;
  label: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RunRecord {
  id: string;
  refSha: string;
  dataset: string;
  tier: string;
  system: string;
  identity: unknown;
  createdAt: string;
}

/** A collection: where it ran, whose engine it loaded, and what it seeded or reused. */
export interface CollectDetail {
  refSha: string;
  checkout: string;
  /** The file `@corespeed/lore-core` resolved to in that checkout. */
  engine: string;
  runCode: { digest: string; files: number };
  corpusCode: { digest: string; files: number };
  database: string;
  units: { seeded: number; reused: number; verifiedChunks: number };
  cases: { selected: number; alreadyStored: number; searched: number };
  usage: Record<string, number>;
  seconds: number;
  failure?: string;
}

/** An answering pass: per run, what came from the store and what was made now. */
export interface AnswerDetail {
  reader: string;
  scorer: string;
  judge: string | null;
  /** `gradingIdentity` of the reader, scorer, and judge; absent in older events. */
  grading?: string;
  cases: {
    answersFromStore: number;
    answersNew: number;
    verdictsFromStore: number;
    verdictsNew: number;
  };
  /** Shared by every run answered in the same call. */
  readerCalls: number;
  gradeCalls: number;
  readerTokens: { input: number; output: number };
  estimatedReaderUsd: number;
}

/** One step that touched a run: what it reused, what it paid for, and where it ran. */
export type RunEvent =
  | { kind: "collect"; at: string; detail: CollectDetail }
  | { kind: "answer"; at: string; detail: AnswerDetail };

export interface CaseResult {
  caseId: string;
  category: string;
  packetSha: string;
  retrieval: RetrievalMetrics;
  latencyMs: number;
  isolationFailure: boolean;
  answerKey: string | null;
  verdictKey: string | null;
  score: number | null;
  /** The reader, scorer, and judge that produced `score`; null until graded. */
  grading: string | null;
}

/** Anything that runs a parameterized statement: a `pg` Pool, or PGlite in tests. */
export type StoreQuery = (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** The database every sandbox pointed at one eval server shares. */
export const STORE_DATABASE = "lore_eval_store";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS embeddings (key text PRIMARY KEY, vector real[] NOT NULL)",
  `CREATE TABLE IF NOT EXISTS answers (key text PRIMARY KEY, answer text NOT NULL,
     input_tokens integer, output_tokens integer, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS verdicts (key text PRIMARY KEY, score double precision NOT NULL,
     label text NOT NULL, input_tokens integer, output_tokens integer,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, ref_sha text NOT NULL,
     dataset text NOT NULL, tier text NOT NULL, system text NOT NULL, identity jsonb NOT NULL,
     created_at text NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS packets (sha text PRIMARY KEY, packet text NOT NULL)",
  `CREATE TABLE IF NOT EXISTS results (run text NOT NULL, case_id text NOT NULL,
     category text NOT NULL, packet_sha text NOT NULL, retrieval jsonb NOT NULL,
     latency_ms double precision NOT NULL, isolation_failure boolean NOT NULL,
     answer_key text, verdict_key text, score double precision, grading text,
     PRIMARY KEY (run, case_id))`,
  `CREATE TABLE IF NOT EXISTS events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     run text NOT NULL, kind text NOT NULL, at text NOT NULL, detail jsonb NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS events_run ON events (run, id)",
  `CREATE TABLE IF NOT EXISTS corpora (database text NOT NULL, workspace_id text NOT NULL,
     unit text NOT NULL, corpus text NOT NULL, last_used_at timestamptz NOT NULL,
     PRIMARY KEY (database, workspace_id))`,
];

/** `$1, $2, ...` rows of `width` parameters each, for one multi-row statement. */
const placeholders = (rows: number, width: number) =>
  Array.from(
    { length: rows },
    (_, row) =>
      `(${Array.from({ length: width }, (_, column) => `$${row * width + column + 1}`).join(", ")})`,
  ).join(", ");

/**
 * A `real[]` literal holding each value's float32 exactly. Drivers write -0 as "0",
 * which would store +0, so the sign is written out.
 */
export function realArrayLiteral(values: readonly number[]): string {
  return `{${Array.from(Float32Array.from(values), (value) =>
    Object.is(value, -0) ? "-0" : String(value),
  ).join(",")}}`;
}

/** At most this many rows per multi-row statement, well under PostgreSQL's 65,535 parameters. */
const BATCH_ROWS = 500;

async function inBatches<T>(items: readonly T[], use: (batch: T[]) => Promise<void>) {
  for (let start = 0; start < items.length; start += BATCH_ROWS) {
    await use(items.slice(start, start + BATCH_ROWS));
  }
}

interface ResultRow {
  case_id: string;
  category: string;
  packet_sha: string;
  retrieval: RetrievalMetrics;
  latency_ms: number;
  isolation_failure: boolean;
  answer_key: string | null;
  verdict_key: string | null;
  score: number | null;
  grading: string | null;
}

/**
 * The harness's one durable store, a database on the eval server, so every
 * sandbox pointed at that server shares it: content-addressed embeddings, reader
 * answers, and scorer verdicts, plus each run's packets, results, and events, and
 * which Workspaces runs used. Keys hash everything that decides the value, so a hit
 * is always a valid reuse, and concurrent writers of one key write the same value.
 */
export class EvalStore {
  private constructor(
    private readonly query: StoreQuery,
    private readonly end: () => Promise<void>,
  ) {}

  /** Open the shared store on an eval server, creating its database on first use. */
  static async open(serverUrl: string, log?: (message: string) => void): Promise<EvalStore> {
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    try {
      await admin.query("SELECT pg_advisory_lock(hashtext($1))", [STORE_DATABASE]);
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
        STORE_DATABASE,
      ]);
      if (!exists.rows.length) {
        log?.(`creating ${STORE_DATABASE}`);
        await admin.query(`CREATE DATABASE "${STORE_DATABASE}"`);
      }
      await admin.query("SELECT pg_advisory_unlock(hashtext($1))", [STORE_DATABASE]);
    } finally {
      await admin.end();
    }
    const url = new URL(serverUrl);
    url.pathname = `/${STORE_DATABASE}`;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    // Two sandboxes may open a new store at once; one creates its tables.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [STORE_DATABASE]);
      for (const statement of SCHEMA) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return new EvalStore(
      (text, params) => pool.query(text, params as unknown[]),
      () => pool.end(),
    );
  }

  /** A store over any connection, such as PGlite in tests. */
  static async over(query: StoreQuery, end: () => Promise<void> = async () => {}) {
    for (const statement of SCHEMA) await query(statement);
    return new EvalStore(query, end);
  }

  async close(): Promise<void> {
    await this.end();
  }

  private async rows<T>(text: string, params?: unknown[]): Promise<T[]> {
    return (await this.query(text, params)).rows as T[];
  }

  /** The stored vectors among `keys`. */
  async embeddings(keys: readonly string[]): Promise<Map<string, Float32Array>> {
    const found = new Map<string, Float32Array>();
    if (!keys.length) return found;
    const rows = await this.rows<{ key: string; vector: number[] }>(
      "SELECT key, vector FROM embeddings WHERE key = ANY($1::text[])",
      [keys],
    );
    for (const row of rows) found.set(row.key, Float32Array.from(row.vector));
    return found;
  }

  async saveEmbeddings(entries: ReadonlyArray<[string, readonly number[]]>): Promise<void> {
    await inBatches(entries, async (batch) => {
      await this.query(
        `INSERT INTO embeddings (key, vector) VALUES ${batch
          .map((_, row) => `($${2 * row + 1}, $${2 * row + 2}::real[])`)
          .join(", ")}
         ON CONFLICT (key) DO NOTHING`,
        batch.flatMap(([key, vector]) => [key, realArrayLiteral(vector)]),
      );
    });
  }

  async answers(keys: readonly string[]): Promise<Map<string, StoredAnswer>> {
    const rows = keys.length
      ? await this.rows<{
          key: string;
          answer: string;
          input_tokens: number | null;
          output_tokens: number | null;
        }>(
          "SELECT key, answer, input_tokens, output_tokens FROM answers WHERE key = ANY($1::text[])",
          [[...new Set(keys)]],
        )
      : [];
    return new Map(
      rows.map((row) => [
        row.key,
        { answer: row.answer, inputTokens: row.input_tokens, outputTokens: row.output_tokens },
      ]),
    );
  }

  async saveAnswer(key: string, answer: StoredAnswer): Promise<void> {
    await this.query(
      `INSERT INTO answers (key, answer, input_tokens, output_tokens) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [key, answer.answer, answer.inputTokens, answer.outputTokens],
    );
  }

  async verdicts(keys: readonly string[]): Promise<Map<string, StoredVerdict>> {
    const rows = keys.length
      ? await this.rows<{
          key: string;
          score: number;
          label: string;
          input_tokens: number | null;
          output_tokens: number | null;
        }>(
          `SELECT key, score, label, input_tokens, output_tokens FROM verdicts
           WHERE key = ANY($1::text[])`,
          [[...new Set(keys)]],
        )
      : [];
    return new Map(
      rows.map((row) => [
        row.key,
        {
          score: row.score,
          label: row.label,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
        },
      ]),
    );
  }

  async saveVerdict(key: string, verdict: StoredVerdict): Promise<void> {
    await this.query(
      `INSERT INTO verdicts (key, score, label, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
      [key, verdict.score, verdict.label, verdict.inputTokens, verdict.outputTokens],
    );
  }

  async saveRun(run: RunRecord): Promise<void> {
    await this.query(
      `INSERT INTO runs (id, ref_sha, dataset, tier, system, identity, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [
        run.id,
        run.refSha,
        run.dataset,
        run.tier,
        run.system,
        JSON.stringify(run.identity),
        run.createdAt,
      ],
    );
  }

  async run(id: string): Promise<RunRecord | undefined> {
    const [row] = await this.rows<{
      id: string;
      ref_sha: string;
      dataset: string;
      tier: string;
      system: string;
      identity: unknown;
      created_at: string;
    }>("SELECT * FROM runs WHERE id = $1", [id]);
    return row
      ? {
          id: row.id,
          refSha: row.ref_sha,
          dataset: row.dataset,
          tier: row.tier,
          system: row.system,
          identity: row.identity,
          createdAt: row.created_at,
        }
      : undefined;
  }

  /** Store a Packet's items under the SHA-256 of their exact JSON, and return it. */
  async savePacket(packet: Packet): Promise<string> {
    const body = JSON.stringify(packet.items);
    const sha = sha256(body);
    await this.query(
      "INSERT INTO packets (sha, packet) VALUES ($1, $2) ON CONFLICT (sha) DO NOTHING",
      [sha, body],
    );
    return sha;
  }

  async packets(shas: readonly string[]): Promise<Map<string, Packet["items"]>> {
    const rows = shas.length
      ? await this.rows<{ sha: string; packet: string }>(
          "SELECT sha, packet FROM packets WHERE sha = ANY($1::text[])",
          [[...new Set(shas)]],
        )
      : [];
    const found = new Map(rows.map((row) => [row.sha, JSON.parse(row.packet)]));
    for (const sha of shas) {
      if (!found.has(sha)) throw new Error(`Packet ${sha} is missing from the store`);
    }
    return found;
  }

  async saveResults(run: string, results: readonly CaseResult[]): Promise<void> {
    await inBatches(results, async (batch) => {
      await this.query(
        `INSERT INTO results (run, case_id, category, packet_sha, retrieval, latency_ms,
           isolation_failure, answer_key, verdict_key, score, grading)
         VALUES ${placeholders(batch.length, 11)}
         ON CONFLICT (run, case_id) DO UPDATE SET category = excluded.category,
           packet_sha = excluded.packet_sha, retrieval = excluded.retrieval,
           latency_ms = excluded.latency_ms, isolation_failure = excluded.isolation_failure,
           answer_key = excluded.answer_key, verdict_key = excluded.verdict_key,
           score = excluded.score, grading = excluded.grading`,
        batch.flatMap((result) => [
          run,
          result.caseId,
          result.category,
          result.packetSha,
          JSON.stringify(result.retrieval),
          result.latencyMs,
          result.isolationFailure,
          result.answerKey,
          result.verdictKey,
          result.score,
          result.grading,
        ]),
      );
    });
  }

  async results(run: string): Promise<CaseResult[]> {
    const rows = await this.rows<ResultRow>(
      "SELECT * FROM results WHERE run = $1 ORDER BY case_id",
      [run],
    );
    return rows.map((row) => ({
      caseId: row.case_id,
      category: row.category,
      packetSha: row.packet_sha,
      retrieval: row.retrieval,
      latencyMs: row.latency_ms,
      isolationFailure: row.isolation_failure,
      answerKey: row.answer_key,
      verdictKey: row.verdict_key,
      score: row.score,
      grading: row.grading,
    }));
  }

  async saveEvent(run: string, event: RunEvent): Promise<void> {
    await this.query("INSERT INTO events (run, kind, at, detail) VALUES ($1, $2, $3, $4)", [
      run,
      event.kind,
      event.at,
      JSON.stringify(event.detail),
    ]);
  }

  async events(run: string): Promise<RunEvent[]> {
    const rows = await this.rows<{ kind: RunEvent["kind"]; at: string; detail: unknown }>(
      "SELECT kind, at, detail FROM events WHERE run = $1 ORDER BY id",
      [run],
    );
    // The store writes only these two shapes.
    return rows.map((row) => ({ kind: row.kind, at: row.at, detail: row.detail }) as RunEvent);
  }

  /** Record that a run is using these Workspaces now, so clean-up keeps them. */
  async touchCorpora(
    database: string,
    entries: ReadonlyArray<{ workspaceId: string; unit: string; corpus: string }>,
  ): Promise<void> {
    await inBatches(entries, async (batch) => {
      await this.query(
        `INSERT INTO corpora (database, workspace_id, unit, corpus, last_used_at)
         SELECT database, workspace_id, unit, corpus, now()
         FROM (VALUES ${placeholders(batch.length, 4)}) AS used (database, workspace_id, unit, corpus)
         ON CONFLICT (database, workspace_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
        batch.flatMap((entry) => [database, entry.workspaceId, entry.unit, entry.corpus]),
      );
    });
  }

  /** Workspaces of one database that some run used at or after `since`. */
  async corporaUsedSince(database: string, since: Date): Promise<Set<string>> {
    const rows = await this.rows<{ workspace_id: string }>(
      "SELECT workspace_id FROM corpora WHERE database = $1 AND last_used_at >= $2",
      [database, since.toISOString()],
    );
    return new Set(rows.map((row) => row.workspace_id));
  }

  async forgetCorpora(database: string, workspaceIds: readonly string[]): Promise<void> {
    if (!workspaceIds.length) return;
    await this.query("DELETE FROM corpora WHERE database = $1 AND workspace_id = ANY($2::text[])", [
      database,
      workspaceIds,
    ]);
  }
}
