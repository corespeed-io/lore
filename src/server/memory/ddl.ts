// Agent Memory schema (v4). Four layers, and the boundaries between them are
// the whole design:
//
//   1. conversation_events   immutable, ordered ground truth. Never mutated.
//   2. thread_summaries      versioned rolling state, reproducible from (1).
//   3. memory_items          canonical typed durable memory, with provenance,
//                            temporal validity and supersession.
//   4. pages/edges/FTS       a REBUILDABLE projection of (3) for browsing and
//                            search. Never the only copy of anything.
//
// Postgres is the source of truth for all four. Nothing here stores hidden
// chain-of-thought: only observable messages, actions, inputs, outputs and
// decisions.
//
// Kept in one list with the rest of the schema (src/server/db.ts) on purpose:
// this codebase has already been bitten twice by a table defined in two places.

export interface Stmt {
  sql: string;
  optional?: boolean;
}

export const MEMORY_DDL: Stmt[] = [
  // --- Layer 1: threads and immutable events -------------------------------
  {
    sql: `CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'idle', 'closed')),
      -- The sequence allocator. Bumped under a row lock so ordering is
      -- deterministic even when two writers append at once.
      last_event_sequence BIGINT NOT NULL DEFAULT 0,
      last_summary_sequence BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS conversation_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      sequence BIGINT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'user_message', 'assistant_message', 'tool_call', 'tool_result',
        'agent_action', 'approval', 'artifact', 'system_observation'
      )),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'assistant', 'tool', 'system')),
      actor_id TEXT,
      -- Observable content only. A tool_result whose raw payload held secrets
      -- arrives here already redacted by the caller.
      content TEXT NOT NULL DEFAULT '',
      structured_payload JSONB NOT NULL DEFAULT '{}',
      source TEXT,
      trace_id TEXT,
      idempotency_key TEXT,
      content_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (thread_id, sequence)
    )`,
  },
  // Replaying an ingest with the same key is a NOOP, not a second event.
  {
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS conversation_events_idem
          ON conversation_events (thread_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL`,
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS conversation_events_thread ON conversation_events (thread_id, sequence)",
  },

  // --- Layer 2: versioned rolling summaries --------------------------------
  {
    sql: `CREATE TABLE IF NOT EXISTS thread_summaries (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      version INT NOT NULL,
      covered_from_sequence BIGINT NOT NULL,
      covered_through_sequence BIGINT NOT NULL,
      structured_summary JSONB NOT NULL,
      rendered_summary TEXT NOT NULL,
      summarizer_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- NULL means this is the active summary. Every version is kept, for
      -- debugging and for regression tests.
      superseded_at TIMESTAMPTZ,
      UNIQUE (thread_id, version)
    )`,
  },
  // At most one active summary per thread.
  {
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS thread_summaries_active
          ON thread_summaries (thread_id) WHERE superseded_at IS NULL`,
  },

  // --- Layer 3: canonical durable memory -----------------------------------
  {
    sql: `CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('thread', 'agent', 'vault')),
      -- NULL only for vault scope, which has exactly one instance.
      scope_id TEXT,
      memory_type TEXT NOT NULL CHECK (memory_type IN (
        'semantic', 'preference', 'episodic', 'procedural', 'working_state'
      )),
      -- The stable logical name of a MUTABLE fact (user.response_style). NULL
      -- for episodes, which are events rather than values.
      memory_key TEXT,
      content TEXT NOT NULL,
      structured_value JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN (
        'candidate', 'committed', 'superseded', 'revoked', 'rejected', 'expired', 'conflict'
      )),
      confidence REAL NOT NULL DEFAULT 0.5,
      salience REAL NOT NULL DEFAULT 0.5,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Closed when superseded or revoked; an as_of query reads through these.
      valid_to TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      supersedes_id TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
      -- The projection is derived; losing it must never lose the memory.
      projection_page_id BIGINT REFERENCES pages(id) ON DELETE SET NULL,
      projection_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (projection_status IN ('pending', 'ok', 'failed', 'removed')),
      projection_error TEXT,
      -- Reprocessing the same conversation range must not duplicate a memory.
      fingerprint TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS memory_items_fingerprint
          ON memory_items (fingerprint)`,
  },
  // The active-value lookup: one live memory per (scope, type, key).
  {
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS memory_items_active_key
          ON memory_items (scope_type, coalesce(scope_id, ''), memory_type, memory_key)
          WHERE status = 'committed' AND memory_key IS NOT NULL`,
  },
  {
    sql: `CREATE INDEX IF NOT EXISTS memory_items_scope
          ON memory_items (scope_type, scope_id, status)`,
  },
  { sql: "CREATE INDEX IF NOT EXISTS memory_items_projection ON memory_items (projection_status)" },
  { sql: "CREATE INDEX IF NOT EXISTS memory_items_page ON memory_items (projection_page_id)" },

  // Provenance. Every committed memory must point at the events that produced
  // it — a memory without a source is not evidence, it is a guess.
  {
    sql: `CREATE TABLE IF NOT EXISTS memory_sources (
      memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE,
      evidence_type TEXT NOT NULL DEFAULT 'explicit_statement',
      evidence_locator TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (memory_id, event_id)
    )`,
  },
  { sql: "CREATE INDEX IF NOT EXISTS memory_sources_event ON memory_sources (event_id)" },

  // Append-only lifecycle. Nothing here is ever updated.
  {
    sql: `CREATE TABLE IF NOT EXISTS memory_revisions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK (operation IN (
        'ADD', 'NOOP', 'ENRICH', 'SUPERSEDE', 'CONFLICT', 'REVOKE', 'EXPIRE', 'COMMIT', 'REJECT'
      )),
      previous_status TEXT,
      new_status TEXT,
      previous_content TEXT,
      new_content TEXT,
      actor TEXT NOT NULL DEFAULT 'system',
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS memory_revisions_memory ON memory_revisions (memory_id, created_at)",
  },

  // Where extraction got to, so a retry is idempotent rather than duplicative.
  {
    sql: `CREATE TABLE IF NOT EXISTS extraction_checkpoints (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      last_extracted_sequence BIGINT NOT NULL DEFAULT 0,
      last_run_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },

  // Procedural memory's supporting evidence: which episodes back a procedure.
  {
    sql: `CREATE TABLE IF NOT EXISTS procedure_episodes (
      procedure_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (procedure_id, episode_id)
    )`,
  },
];

// The v3 -> v4 upgrade. Tables and columns first, then indexes: an index on a
// column that does not exist yet is how this repo's last two schema bugs
// happened. Everything is IF NOT EXISTS, so a partially applied run is safe to
// repeat.
export const MEMORY_MIGRATION: Stmt[] = MEMORY_DDL;
