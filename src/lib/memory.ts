import { type ActorContext, installActorContext } from "./actor-context";
import { isPostgresAccessDenied } from "./database-errors";
import type { PostgresDatabase, PostgresTransaction } from "./db";
import { embeddingVectorLiteral } from "./embedding/vector";
import type { EmbeddingDimensions } from "./embedding-config";

export type { ActorContext } from "./actor-context";

export type MemoryScope = "shared" | "private";

export class MemoryAccessDeniedError extends Error {
  override name = "MemoryAccessDeniedError";
}

export interface Memory {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  createdByAgentId: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RememberMemory {
  content: string;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface UpdateMemory {
  content?: string;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface SearchMemory {
  query: string;
  limit?: number;
}

export interface ListMemory {
  limit?: number;
  offset?: number;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
  evidence: string;
}

export interface EmbeddingProvider {
  provider: string;
  model: string;
  dimensions: EmbeddingDimensions;
  revision: string;
  embed(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

export type EmbeddingTask = "document" | "query";

export interface MemoryModuleOptions {
  embeddingProvider?: EmbeddingProvider;
  maintenanceNotifier?: MemoryMaintenanceNotifier;
  semanticDistanceThreshold?: number;
}

export interface MemoryEmbeddingJobMessage {
  jobId: string;
}

export interface MemoryMaintenanceNotifier {
  notify(message: MemoryEmbeddingJobMessage): void;
}

interface MemoryRow {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  created_by_agent_id: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

interface SearchRow extends MemoryRow {
  score: number;
  evidence: string;
}

interface PreparedChunk {
  content: string;
}

function chunkContent(content: string, maximumLength = 1_200): string[] {
  const remainingWords = content.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const word of remainingWords) {
    if (current && current.length + word.length + 1 > maximumLength) {
      chunks.push(current);
      current = "";
    }
    if (word.length > maximumLength) {
      if (current) chunks.push(current);
      for (let index = 0; index < word.length; index += maximumLength) {
        chunks.push(word.slice(index, index + maximumLength));
      }
      continue;
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) chunks.push(current);
  return chunks;
}

function prepareChunks(content: string): PreparedChunk[] {
  return chunkContent(content).map((chunk) => ({ content: chunk }));
}

async function insertChunks(
  transaction: PostgresTransaction,
  workspaceId: string,
  memoryId: string,
  chunks: PreparedChunk[],
): Promise<void> {
  for (const [ordinal, chunk] of chunks.entries()) {
    await transaction.query(
      `INSERT INTO memory_chunks (
         id, workspace_id, memory_id, ordinal, content, embedding,
         embedding_provider, embedding_model, embedding_revision, embedded_at
       ) VALUES (
         $1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, NULL
       )`,
      [crypto.randomUUID(), workspaceId, memoryId, ordinal, chunk.content],
    );
  }
}

async function enqueueEmbeddingJob(
  transaction: PostgresTransaction,
  memory: MemoryRow,
  embeddingProvider: EmbeddingProvider,
  onlyWhenStale = false,
): Promise<string | null> {
  const jobId = crypto.randomUUID();
  await transaction.query(
    `INSERT INTO memory_embedding_jobs (
       id, workspace_id, memory_id, owner_user_id, memory_scope,
       memory_version, embedding_provider, embedding_model, embedding_revision
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
     WHERE NOT $10::boolean
        OR EXISTS (
          SELECT 1
          FROM memory_chunks chunk
          WHERE chunk.workspace_id = $2
            AND chunk.memory_id = $3
            AND (
              chunk.embedding IS NULL
              OR chunk.embedding_provider <> $7
              OR chunk.embedding_model <> $8
              OR chunk.embedding_revision <> $9
            )
        )
    `,
    [
      jobId,
      memory.workspace_id,
      memory.id,
      memory.owner_user_id,
      memory.scope,
      memory.version,
      embeddingProvider.provider,
      embeddingProvider.model,
      embeddingProvider.revision,
      onlyWhenStale,
    ],
  );
  // The request role deliberately cannot SELECT this private table, so callers
  // use the allocated id only when the write guarantees that a job was inserted.
  return jobId;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    createdByAgentId: row.created_by_agent_id,
    scope: row.scope,
    content: row.content,
    metadata: row.metadata,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMemoryModule(database: PostgresDatabase, options: MemoryModuleOptions = {}) {
  const embeddingProvider = options.embeddingProvider;
  const maintenanceNotifier = options.maintenanceNotifier;
  const semanticDistanceThreshold = options.semanticDistanceThreshold ?? 0.35;

  function notifyMaintenance(jobId: string | null): void {
    if (!jobId || !maintenanceNotifier) return;
    try {
      maintenanceNotifier.notify({ jobId });
    } catch {
      // The durable Postgres job remains discoverable by the maintenance sweep.
      // A queue notification is only a latency optimization.
    }
  }

  async function canWriteWorkspace(actor: ActorContext): Promise<boolean> {
    return database.transaction(async (transaction) => {
      await installActorContext(transaction, actor);
      const result = await transaction.query<{ allowed: boolean }>(
        "SELECT lore.can_write_memory($1, $2) AS allowed",
        [actor.workspaceId, actor.userId],
      );
      return result.rows[0]?.allowed === true;
    });
  }

  async function writableMemoryContent(actor: ActorContext, id: string): Promise<string | null> {
    return database.transaction(async (transaction) => {
      await installActorContext(transaction, actor);
      const result = await transaction.query<{ content: string }>(
        `SELECT content
         FROM memories
         WHERE id = $1
           AND workspace_id = $2
           AND lore.can_write_memory(workspace_id, owner_user_id)`,
        [id, actor.workspaceId],
      );
      return result.rows[0]?.content ?? null;
    });
  }

  return {
    async remember(actor: ActorContext, input: RememberMemory): Promise<Memory> {
      try {
        if (!(await canWriteWorkspace(actor))) {
          throw new MemoryAccessDeniedError("Actor cannot create Memory in this Workspace");
        }
        const chunks = prepareChunks(input.content);
        const created = await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const id = crypto.randomUUID();
          const result = await transaction.query<MemoryRow>(
            `INSERT INTO memories (
               id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
             RETURNING *`,
            [
              id,
              actor.workspaceId,
              actor.userId,
              actor.agentId ?? null,
              input.scope ?? "shared",
              input.content,
              JSON.stringify(input.metadata ?? {}),
            ],
          );
          const memory = result.rows[0];
          await insertChunks(transaction, actor.workspaceId, id, chunks);
          const jobId = embeddingProvider
            ? await enqueueEmbeddingJob(transaction, memory, embeddingProvider)
            : null;
          return { memory: toMemory(memory), jobId };
        });
        notifyMaintenance(created.jobId);
        return created.memory;
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new MemoryAccessDeniedError("Actor cannot create Memory in this Workspace", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async retrieve(actor: ActorContext, id: string): Promise<Memory | null> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<MemoryRow>(
          "SELECT * FROM memories WHERE id = $1 AND workspace_id = $2",
          [id, actor.workspaceId],
        );
        return result.rows[0] ? toMemory(result.rows[0]) : null;
      });
    },

    async update(actor: ActorContext, id: string, input: UpdateMemory): Promise<Memory | null> {
      if (
        input.content === undefined &&
        input.scope === undefined &&
        input.metadata === undefined
      ) {
        return this.retrieve(actor, id);
      }
      const currentContent = await writableMemoryContent(actor, id);
      if (currentContent === null) return null;
      const contentToEmbed = input.content ?? (input.scope === undefined ? null : currentContent);
      const chunks = contentToEmbed === null ? null : prepareChunks(contentToEmbed);
      const updatedResult = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<MemoryRow>(
          `UPDATE memories
           SET content = COALESCE($3::text, content),
               scope = COALESCE($4::memory_scope, scope),
               metadata = COALESCE($5::jsonb, metadata),
               version = version + 1,
               updated_at = now()
           WHERE id = $1 AND workspace_id = $2
           RETURNING *`,
          [
            id,
            actor.workspaceId,
            input.content ?? null,
            input.scope ?? null,
            input.metadata === undefined ? null : JSON.stringify(input.metadata),
          ],
        );
        const updated = result.rows[0];
        if (updated && chunks) {
          await transaction.query(
            "DELETE FROM memory_chunks WHERE workspace_id = $1 AND memory_id = $2",
            [actor.workspaceId, id],
          );
          await insertChunks(transaction, actor.workspaceId, id, chunks);
        }
        const jobId =
          updated && embeddingProvider
            ? await enqueueEmbeddingJob(transaction, updated, embeddingProvider, chunks === null)
            : null;
        return { memory: updated ? toMemory(updated) : null, jobId };
      });
      // Metadata-only updates can leave an existing stale job for the scheduled
      // sweep without billing a Queue message for an already-embedded Memory.
      notifyMaintenance(chunks ? updatedResult.jobId : null);
      return updatedResult.memory;
    },

    async forget(actor: ActorContext, id: string): Promise<boolean> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<{ id: string }>(
          "DELETE FROM memories WHERE id = $1 AND workspace_id = $2 RETURNING id",
          [id, actor.workspaceId],
        );
        return result.rows.length === 1;
      });
    },

    async list(actor: ActorContext, input: ListMemory = {}): Promise<Memory[]> {
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      const offset = Math.max(0, Math.min(input.offset ?? 0, 1_000_000));
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<MemoryRow>(
          `SELECT *
           FROM memories
           WHERE workspace_id = $1
           ORDER BY updated_at DESC, id
           LIMIT $2
           OFFSET $3`,
          [actor.workspaceId, limit, offset],
        );
        return result.rows.map(toMemory);
      });
    },

    async search(actor: ActorContext, input: SearchMemory): Promise<MemorySearchResult[]> {
      const query = input.query.trim();
      if (!query) return [];
      const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
      const candidateLimit = Math.min(limit * 4, 200);
      let queryEmbedding: string | null = null;
      if (embeddingProvider) {
        try {
          const vectors = await embeddingProvider.embed([query], "query");
          queryEmbedding = vectors[0] ? embeddingVectorLiteral(vectors[0]) : null;
        } catch {
          queryEmbedding = null;
        }
      }
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<SearchRow>(
          `WITH lexical_candidates AS (
             SELECT
               chunk.id AS chunk_id,
               memory.id AS memory_id,
               row_number() OVER (
                 ORDER BY ts_rank_cd(
                   chunk.search_vector,
                   websearch_to_tsquery('simple', $1),
                   32
                 ) DESC, chunk.id
               ) AS candidate_rank
             FROM memory_chunks chunk
             JOIN memories memory
               ON memory.id = chunk.memory_id
              AND memory.workspace_id = chunk.workspace_id
             WHERE chunk.workspace_id = $2
               AND chunk.search_vector @@ websearch_to_tsquery('simple', $1)
             ORDER BY ts_rank_cd(
               chunk.search_vector,
               websearch_to_tsquery('simple', $1),
               32
             ) DESC, chunk.id
             LIMIT $4
           ),
           active_semantic_chunks AS MATERIALIZED (
             SELECT
               chunk.id,
               chunk.memory_id,
               chunk.embedding
             FROM memory_chunks chunk
             JOIN memories memory
               ON memory.id = chunk.memory_id
              AND memory.workspace_id = chunk.workspace_id
             WHERE $3::text IS NOT NULL
               AND chunk.workspace_id = $2
               AND chunk.embedding IS NOT NULL
               AND chunk.embedding_provider = $7
               AND chunk.embedding_model = $8
               AND chunk.embedding_revision = $9
           ),
           semantic_candidates AS (
             SELECT
               chunk.id AS chunk_id,
               chunk.memory_id,
               row_number() OVER (
                 ORDER BY chunk.embedding <=> $3::vector(1024), chunk.id
               ) AS candidate_rank
             FROM active_semantic_chunks chunk
             WHERE (chunk.embedding <=> $3::vector(1024)) <= $5
             ORDER BY chunk.embedding <=> $3::vector(1024), chunk.id
             LIMIT $4
           ),
           reciprocal_rank AS (
             SELECT
               chunk_id,
               memory_id,
               sum(1.0 / (60.0 + candidate_rank)) AS score
             FROM (
               SELECT * FROM lexical_candidates
               UNION ALL
               SELECT * FROM semantic_candidates
             ) candidates
             GROUP BY chunk_id, memory_id
           ),
           ranked_memories AS (
             SELECT
               memory_id,
               max(score) AS score,
               (array_agg(chunk_id ORDER BY score DESC, chunk_id))[1] AS evidence_chunk_id
             FROM reciprocal_rank
             GROUP BY memory_id
             ORDER BY max(score) DESC, memory_id
             LIMIT $6
           )
           SELECT
             memory.id,
             memory.workspace_id,
             memory.owner_user_id,
             memory.created_by_agent_id,
             memory.scope,
             memory.content,
             memory.metadata,
             memory.version,
             memory.created_at,
             memory.updated_at,
             ranked_memories.score,
             chunk.content AS evidence
           FROM ranked_memories
           JOIN memories memory
             ON memory.id = ranked_memories.memory_id
            AND memory.workspace_id = $2
           JOIN memory_chunks chunk
             ON chunk.id = ranked_memories.evidence_chunk_id
            AND chunk.memory_id = memory.id
            AND chunk.workspace_id = $2
           ORDER BY ranked_memories.score DESC, memory.updated_at DESC, memory.id`,
          [
            query,
            actor.workspaceId,
            queryEmbedding,
            candidateLimit,
            semanticDistanceThreshold,
            limit,
            embeddingProvider?.provider ?? "",
            embeddingProvider?.model ?? "",
            embeddingProvider?.revision ?? "",
          ],
        );
        return result.rows.map((row) => ({
          memory: toMemory(row),
          score: Number(row.score),
          evidence: row.evidence,
        }));
      });
    },
  };
}
