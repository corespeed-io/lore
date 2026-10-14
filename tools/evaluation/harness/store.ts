import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

/**
 * The harness's one durable store: content-addressed embeddings, reader answers,
 * and scorer verdicts shared by every run, plus each run's packets and results.
 * Keys hash everything that decides the value, so a hit is always a valid reuse.
 */
export class EvalStore {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 30000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS answers (
        key TEXT PRIMARY KEY, answer TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verdicts (
        key TEXT PRIMARY KEY, score REAL NOT NULL, label TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, ref_sha TEXT NOT NULL, dataset TEXT NOT NULL, tier TEXT NOT NULL,
        system TEXT NOT NULL, identity TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS packets (
        sha TEXT PRIMARY KEY, packet TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results (
        run TEXT NOT NULL, case_id TEXT NOT NULL, category TEXT NOT NULL,
        packet_sha TEXT NOT NULL, retrieval TEXT NOT NULL, latency_ms REAL NOT NULL,
        isolation_failure INTEGER NOT NULL, answer_key TEXT, verdict_key TEXT, score REAL,
        grading TEXT, PRIMARY KEY (run, case_id));
      CREATE TABLE IF NOT EXISTS events (
        run TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events (run, at);
      CREATE TABLE IF NOT EXISTS corpora (
        database TEXT NOT NULL, workspace_id TEXT NOT NULL, unit TEXT NOT NULL,
        corpus TEXT NOT NULL, last_used_at TEXT NOT NULL,
        PRIMARY KEY (database, workspace_id));
    `);
    // Stores from before gradings were recorded: their scores are regraded on next use.
    const columns = this.db.query("PRAGMA table_info(results)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "grading")) {
      this.db.exec("ALTER TABLE results ADD COLUMN grading TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  embedding(key: string): Float32Array | undefined {
    const row = this.db.query("SELECT vector FROM embeddings WHERE key = ?").get(key) as {
      vector: Uint8Array;
    } | null;
    if (!row) return undefined;
    const bytes = row.vector;
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  saveEmbeddings(entries: ReadonlyArray<[string, readonly number[]]>): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO embeddings (key, vector) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const [key, vector] of entries) {
        insert.run(key, new Uint8Array(Float32Array.from(vector).buffer));
      }
    })();
  }

  answer(key: string): StoredAnswer | undefined {
    const row = this.db
      .query("SELECT answer, input_tokens, output_tokens FROM answers WHERE key = ?")
      .get(key) as {
      answer: string;
      input_tokens: number | null;
      output_tokens: number | null;
    } | null;
    return row
      ? { answer: row.answer, inputTokens: row.input_tokens, outputTokens: row.output_tokens }
      : undefined;
  }

  saveAnswer(key: string, answer: StoredAnswer): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO answers (key, answer, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, answer.answer, answer.inputTokens, answer.outputTokens, new Date().toISOString());
  }

  verdict(key: string): StoredVerdict | undefined {
    const row = this.db
      .query("SELECT score, label, input_tokens, output_tokens FROM verdicts WHERE key = ?")
      .get(key) as {
      score: number;
      label: string;
      input_tokens: number | null;
      output_tokens: number | null;
    } | null;
    return row
      ? {
          score: row.score,
          label: row.label,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
        }
      : undefined;
  }

  saveVerdict(key: string, verdict: StoredVerdict): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO verdicts (key, score, label, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        key,
        verdict.score,
        verdict.label,
        verdict.inputTokens,
        verdict.outputTokens,
        new Date().toISOString(),
      );
  }

  saveRun(run: RunRecord): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO runs (id, ref_sha, dataset, tier, system, identity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.refSha,
        run.dataset,
        run.tier,
        run.system,
        JSON.stringify(run.identity),
        run.createdAt,
      );
  }

  run(id: string): RunRecord | undefined {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as {
      id: string;
      ref_sha: string;
      dataset: string;
      tier: string;
      system: string;
      identity: string;
      created_at: string;
    } | null;
    return row
      ? {
          id: row.id,
          refSha: row.ref_sha,
          dataset: row.dataset,
          tier: row.tier,
          system: row.system,
          identity: JSON.parse(row.identity),
          createdAt: row.created_at,
        }
      : undefined;
  }

  savePacket(packet: Packet): string {
    const body = JSON.stringify(packet.items);
    const sha = sha256(body);
    this.db.query("INSERT OR IGNORE INTO packets (sha, packet) VALUES (?, ?)").run(sha, body);
    return sha;
  }

  packet(sha: string): Packet["items"] {
    const row = this.db.query("SELECT packet FROM packets WHERE sha = ?").get(sha) as {
      packet: string;
    } | null;
    if (!row) throw new Error(`Packet ${sha} is missing from the store`);
    return JSON.parse(row.packet);
  }

  saveResult(run: string, result: CaseResult): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO results (run, case_id, category, packet_sha, retrieval, latency_ms,
          isolation_failure, answer_key, verdict_key, score, grading)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run,
        result.caseId,
        result.category,
        result.packetSha,
        JSON.stringify(result.retrieval),
        result.latencyMs,
        result.isolationFailure ? 1 : 0,
        result.answerKey,
        result.verdictKey,
        result.score,
        result.grading,
      );
  }

  saveEvent(run: string, event: RunEvent): void {
    this.db
      .query("INSERT INTO events (run, kind, at, detail) VALUES (?, ?, ?, ?)")
      .run(run, event.kind, event.at, JSON.stringify(event.detail));
  }

  events(run: string): RunEvent[] {
    const rows = this.db
      .query("SELECT kind, at, detail FROM events WHERE run = ? ORDER BY at, rowid")
      .all(run) as Array<{ kind: RunEvent["kind"]; at: string; detail: string }>;
    // The store writes only these two shapes.
    return rows.map(
      (row) => ({ kind: row.kind, at: row.at, detail: JSON.parse(row.detail) }) as RunEvent,
    );
  }

  /** Record that a run is using these Workspaces now, so clean-up keeps them. */
  touchCorpora(
    database: string,
    entries: ReadonlyArray<{ workspaceId: string; unit: string; corpus: string }>,
  ): void {
    const upsert = this.db.prepare(
      `INSERT INTO corpora (database, workspace_id, unit, corpus, last_used_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (database, workspace_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
    );
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const entry of entries) {
        upsert.run(database, entry.workspaceId, entry.unit, entry.corpus, now);
      }
    })();
  }

  /** Workspaces of one database that some run used at or after `since`. */
  corporaUsedSince(database: string, since: string): Set<string> {
    const rows = this.db
      .query("SELECT workspace_id FROM corpora WHERE database = ? AND last_used_at >= ?")
      .all(database, since) as Array<{ workspace_id: string }>;
    return new Set(rows.map((row) => row.workspace_id));
  }

  forgetCorpora(database: string, workspaceIds: readonly string[]): void {
    const remove = this.db.prepare("DELETE FROM corpora WHERE database = ? AND workspace_id = ?");
    this.db.transaction(() => {
      for (const id of workspaceIds) remove.run(database, id);
    })();
  }

  results(run: string): CaseResult[] {
    const rows = this.db
      .query("SELECT * FROM results WHERE run = ? ORDER BY case_id")
      .all(run) as Array<{
      case_id: string;
      category: string;
      packet_sha: string;
      retrieval: string;
      latency_ms: number;
      isolation_failure: number;
      answer_key: string | null;
      verdict_key: string | null;
      score: number | null;
      grading: string | null;
    }>;
    return rows.map((row) => ({
      caseId: row.case_id,
      category: row.category,
      packetSha: row.packet_sha,
      retrieval: JSON.parse(row.retrieval),
      latencyMs: row.latency_ms,
      isolationFailure: row.isolation_failure === 1,
      answerKey: row.answer_key,
      verdictKey: row.verdict_key,
      score: row.score,
      grading: row.grading,
    }));
  }
}
