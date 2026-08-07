import { type ActorContext, installActorContext } from "./actor-context";
import { isPostgresAccessDenied } from "./database-errors";
import type { PostgresDatabase, PostgresTransaction } from "./db";
import { EMBEDDING_DIMENSIONS, type EmbeddingDimensions } from "./embedding-config";

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
  semanticDistanceThreshold?: number;
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
  embedding: string | null;
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

function vectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding provider returned an invalid vector");
  }
  return `[${vector.join(",")}]`;
}

async function prepareChunks(
  content: string,
  embeddingProvider?: EmbeddingProvider,
): Promise<PreparedChunk[]> {
  const contents = chunkContent(content);
  if (!embeddingProvider) return contents.map((chunk) => ({ content: chunk, embedding: null }));
  try {
    const embeddings = await embeddingProvider.embed(contents, "document");
    if (embeddings.length !== contents.length) {
      throw new Error("Embedding provider returned the wrong number of vectors");
    }
    return contents.map((chunk, index) => ({
      content: chunk,
      embedding: vectorLiteral(embeddings[index]),
    }));
  } catch {
    // Memory writes remain available when an embedding provider is unavailable.
    // Null embedding state is explicit and can be picked up by deterministic
    // maintenance without changing the source Memory.
    return contents.map((chunk) => ({ content: chunk, embedding: null }));
  }
}

async function insertChunks(
  transaction: PostgresTransaction,
  workspaceId: string,
  memoryId: string,
  chunks: PreparedChunk[],
  embeddingProvider?: EmbeddingProvider,
): Promise<void> {
  for (const [ordinal, chunk] of chunks.entries()) {
    await transaction.query(
      `INSERT INTO memory_chunks (
         id, workspace_id, memory_id, ordinal, content, embedding,
         embedding_provider, embedding_model, embedding_revision, embedded_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::vector(1024), $7, $8, $9,
         CASE WHEN $6::text IS NULL THEN NULL ELSE now() END
       )`,
      [
        crypto.randomUUID(),
        workspaceId,
        memoryId,
        ordinal,
        chunk.content,
        chunk.embedding,
        chunk.embedding ? embeddingProvider?.provider : null,
        chunk.embedding ? embeddingProvider?.model : null,
        chunk.embedding ? embeddingProvider?.revision : null,
      ],
    );
  }
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
  const semanticDistanceThreshold = options.semanticDistanceThreshold ?? 0.35;

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
        const chunks = await prepareChunks(input.content, embeddingProvider);
        return await database.transaction(async (transaction) => {
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
          await insertChunks(transaction, actor.workspaceId, id, chunks, embeddingProvider);
          return toMemory(result.rows[0]);
        });
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new MemoryAccessDeniedError("Actor cannot create Memory in this Workspace");
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
      const chunks =
        contentToEmbed === null ? null : await prepareChunks(contentToEmbed, embeddingProvider);
      return database.transaction(async (transaction) => {
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
          await insertChunks(transaction, actor.workspaceId, id, chunks, embeddingProvider);
        }
        return updated ? toMemory(updated) : null;
      });
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
          queryEmbedding = vectors[0] ? vectorLiteral(vectors[0]) : null;
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
