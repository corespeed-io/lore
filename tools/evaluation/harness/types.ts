/**
 * The Lore eval harness's vocabulary. A Dataset yields isolated Units (one
 * Workspace each: a LongMemEval question, a LoCoMo conversation). A System is the
 * product path under test: it ingests a Unit's records and answers each Case with
 * an evidence Packet. A reader turns the Packet into an answer, and the dataset's
 * scorer grades it. Everything after the Packet is cached by content, so two runs
 * pay only for the Cases whose evidence differs.
 */

/** One record of raw history, as a user or agent produced it. */
export interface CorpusRecord {
  /** Stable within its Unit; the key gold evidence refers to. */
  key: string;
  text: string;
  /** Gold evidence for a record split into parts refers to this key instead. */
  anchorKey?: string;
  observedAt?: string;
  metadata?: Record<string, string | number | boolean>;
}

export type ScorerId = "longmemeval-judge-v1" | "locomo-f1";

export interface EvalCase {
  /** Globally unique and stable across runs. */
  id: string;
  unitKey: string;
  /** A dataset category (question type), used for strata and per-category results. */
  category: string;
  question: string;
  /** The question as the reader sees it, when it differs (dates, instructions). */
  readerQuestion: string;
  /** The query sent to retrieval. */
  searchQuery: string;
  answer: string;
  /** Record keys that hold the answer; empty for an abstention case. */
  evidenceKeys: string[];
  abstention: boolean;
  /** Scorer-specific fields, such as LongMemEval's question type. */
  scoring?: Record<string, string | number>;
}

export interface EvalUnit {
  key: string;
  records: CorpusRecord[];
  cases: EvalCase[];
  /** Private text another user owns; any search that returns it is an isolation failure. */
  tripwires: string[];
}

export interface DatasetCaseIndex {
  id: string;
  unitKey: string;
  category: string;
}

export interface Dataset {
  id: string;
  /** Pinned upstream revision and file digest; part of every corpus and run key. */
  revision: string;
  scorer: ScorerId;
  /** Questions per category for a tier, where the dataset needs a different size. */
  tierSizes?: Partial<Record<"smoke" | "standard" | "full", number>>;
  reader: {
    /** System instruction, or undefined for the benchmark reader's default. */
    instruction?: string;
    maximumContextCharacters: number;
  };
  /** Every case id with its unit and category, cheap enough to sample from. */
  index(): Promise<DatasetCaseIndex[]>;
  /** The selected cases' units, each with all its records and only the selected cases. */
  units(caseIds: ReadonlySet<string>): AsyncIterable<EvalUnit>;
}

export interface PacketItem {
  id: string;
  text: string;
  /** Record keys this item came from, for retrieval metrics. */
  sourceKeys: string[];
}

export interface Packet {
  items: PacketItem[];
  latencyMs: number;
}

export interface RetrievalMetrics {
  /** Gold records the case has; zero for abstention, which retrieval metrics skip. */
  gold: number;
  /** Any gold record retrieved. */
  anyHit: boolean;
  /** Every gold record retrieved. */
  allHit: boolean;
  /** Reciprocal rank of the first gold record, 0 when none. */
  reciprocalRank: number;
}

export interface SystemContext {
  databaseUrl: string;
  /**
   * The Unit's Workspace. Its id hashes the code that ingests, the Unit's records,
   * and the dataset, so seeding is idempotent and a corpus is shared only by
   * checkouts that would store exactly the same thing.
   */
  workspaceIdFor(unit: EvalUnit): string;
  log(message: string): void;
}

/** What ingesting a batch of Units did, for the run's provenance. */
export interface IngestOutcome {
  /** Units written and embedded by this call. */
  seeded: number;
  /** Units found complete and checked, so not written again. */
  reused: number;
  /** Chunks checked to hold a vector in the expected embedding generation. */
  verifiedChunks: number;
}

export interface EvalSystem {
  id: string;
  /** What is ingested, in words; the code digest covers how. Part of the corpus key. */
  ingestIdentity(): Record<string, unknown>;
  /** Everything that decides a Packet besides the code; part of the run key. */
  retrievalIdentity(): Record<string, unknown>;
  ingest(context: SystemContext, units: EvalUnit[]): Promise<IngestOutcome>;
  retrieve(context: SystemContext, unit: EvalUnit, evalCase: EvalCase): Promise<Packet>;
  /** Provider calls so far, such as embeddings answered from the store or made new. */
  usage(): Record<string, number>;
  close(): Promise<void>;
}
