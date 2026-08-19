import type { PostgresDatabase } from "@corespeed/lore-core";
import { type ActorContext, installActorContext } from "@corespeed/lore-core";
import type {
  CodeArtifact,
  CodeArtifactSymbol,
  CodeIndexJob,
  CodeIndexJobSelector,
  CodeIndexJobStatus,
  CodeParserKind,
  CodeParseStatus,
  CodeRevisionSelector,
  CodeSearchChannel,
  GitRevisionManifest,
  GitRevisionManifestEntry,
  GitTreeEntryExclusionReason,
  SearchCodeIndexInput,
} from "./code-index";
import { CodeIndexAccessDeniedError, CodeIndexValidationError } from "./code-index-errors";

export interface CodeIndexReadModule {
  getIndexJob(actor: ActorContext, input: CodeIndexJobSelector): Promise<CodeIndexJob>;
  listIndexJobs(actor: ActorContext, input?: ListCodeIndexJobsInput): Promise<CodeIndexJob[]>;
  getGitRevisionManifest(
    actor: ActorContext,
    input: CodeRevisionSelector,
  ): Promise<GitRevisionManifest>;
  search(actor: ActorContext, input: SearchCodeIndexInput): Promise<CodeArtifact[]>;
  getArtifacts(actor: ActorContext, input: GetCodeArtifactsInput): Promise<CodeArtifact[]>;
  getArtifactLogicalDigests(
    actor: ActorContext,
    input: GetCodeArtifactsInput,
  ): Promise<CodeArtifactLogicalDigest[]>;
}

export interface GetCodeArtifactsInput extends CodeRevisionSelector {
  artifactIds: readonly string[];
}

export interface ListCodeIndexJobsInput {
  limit?: number;
}

export const MAXIMUM_CODE_INDEX_JOB_LIST = 100;
const DEFAULT_CODE_INDEX_JOB_LIST = 20;

export interface CodeArtifactLogicalDigest {
  artifactId: string;
  fingerprintSha256: string;
}

interface CodeIndexJobRow {
  id: string;
  repository_id: string;
  repository_key: string;
  commit_oid: string;
  source_ref: string | null;
  indexer_revision: string;
  status: CodeIndexJobStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: Date | string;
  completed_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GitManifestRow {
  path: string;
  git_mode: string;
  object_type: string;
  object_oid: string;
  byte_size: number | string | null;
  content_sha256: string | null;
  index_status: "excluded" | "indexed";
  exclusion_reason: GitTreeEntryExclusionReason | null;
}

interface ArtifactRow {
  id: string;
  repository_id: string;
  revision_id: string;
  generation_id: string;
  commit_oid: string;
  path: string;
  language: string;
  parser: CodeParserKind;
  parse_status: CodeParseStatus;
  kind: string;
  symbol: string | null;
  symbol_key: string | null;
  declaration_key: string | null;
  declaration_chunk_ordinal: number | null;
  symbols: CodeArtifactSymbol[] | null;
  ordinal: number;
  start_line: number;
  end_line: number;
  content: string;
  content_sha256: string;
  matched_channels: CodeSearchChannel[];
  score: number | string;
}

interface ArtifactLogicalDigestRow {
  artifact_id: string;
  fingerprint_sha256: string;
}

function artifactIds(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((id) => validateUuid(id, "artifactId")))];
  if (normalized.length === 0 || normalized.length > 25) {
    throw new CodeIndexValidationError("artifactIds must contain 1 through 25 UUIDs");
  }
  return normalized;
}

function validateUuid(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw new CodeIndexValidationError(`${name} must be a UUID`);
  }
  return normalized;
}

function validateCommitOid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(normalized)) {
    throw new CodeIndexValidationError("commitOid must be a full 40- or 64-character Git OID");
  }
  return normalized;
}

function validatePlainText(value: string, name: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacters(normalized)) {
    throw new CodeIndexValidationError(`${name} is invalid`);
  }
  return normalized;
}

function validatePath(path: string): string {
  const trimmed = path.trim();
  const normalized = trimmed.replace(/\/+$/, "");
  if (
    !normalized ||
    trimmed !== path ||
    normalized.length > 1_024 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    hasControlCharacters(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new CodeIndexValidationError(`Invalid repository-relative path: ${path}`);
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function exactLikePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function hasTrigramWord(query: string): boolean {
  return /[\p{L}\p{N}_]{3}/u.test(query);
}

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function toCodeIndexJob(row: CodeIndexJobRow): CodeIndexJob {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repositoryKey: row.repository_key,
    commitOid: row.commit_oid,
    sourceRef: row.source_ref,
    indexerRevision: row.indexer_revision,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maximumAttempts: Number(row.max_attempts),
    availableAt: timestamp(row.available_at),
    completedAt: row.completed_at ? timestamp(row.completed_at) : null,
    lastError: row.last_error,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function toGitManifest(rows: readonly GitManifestRow[]): GitRevisionManifest {
  const entries = rows.map(
    (row): GitRevisionManifestEntry => ({
      path: row.path,
      mode: row.git_mode,
      objectType: row.object_type,
      objectOid: row.object_oid,
      byteSize: row.byte_size === null ? null : Number(row.byte_size),
      contentSha256: row.content_sha256,
      status: row.index_status,
      exclusionReason: row.exclusion_reason,
    }),
  );
  const indexedFileCount = entries.filter((entry) => entry.status === "indexed").length;
  return {
    entries,
    totalEntryCount: entries.length,
    indexedFileCount,
    excludedFileCount: entries.length - indexedFileCount,
  };
}

function toCodeArtifact(row: ArtifactRow): CodeArtifact {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    revisionId: row.revision_id,
    generationId: row.generation_id,
    commitOid: row.commit_oid,
    path: row.path,
    language: row.language,
    parser: row.parser,
    parseStatus: row.parse_status,
    kind: row.kind,
    symbol: row.symbol,
    symbolKey: row.symbol_key,
    declarationKey: row.declaration_key,
    declarationChunkOrdinal: row.declaration_chunk_ordinal,
    symbols: row.symbols ?? [],
    ordinal: row.ordinal,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    contentSha256: row.content_sha256,
    matchedChannels: row.matched_channels,
    score: Number(row.score),
  };
}

export function createCodeIndexReadModule(database: PostgresDatabase): CodeIndexReadModule {
  return {
    async getArtifacts(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const commitOid = validateCommitOid(input.commitOid);
      const selectedArtifactIds = artifactIds(input.artifactIds);
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<ArtifactRow>(
          `WITH selected_generation AS MATERIALIZED (
             SELECT repository.id AS repository_id, revision.id AS revision_id,
               generation.id AS generation_id, revision.commit_oid
             FROM code_repositories repository
             JOIN code_revisions revision
               ON revision.workspace_id = repository.workspace_id
              AND revision.repository_id = repository.id
             JOIN code_index_generations generation
               ON generation.workspace_id = revision.workspace_id
              AND generation.repository_id = revision.repository_id
              AND generation.revision_id = revision.id
             WHERE repository.workspace_id = $1
               AND repository.repository_key = $2
               AND revision.commit_oid = $3
               AND generation.status = 'active'
           )
           SELECT artifact.id, artifact.repository_id, artifact.revision_id,
             artifact.generation_id, selected.commit_oid, artifact.path,
             artifact.language, artifact.parser, artifact.parse_status, artifact.kind,
             artifact.symbol, artifact.symbol_key, artifact.declaration_key,
             artifact.declaration_chunk_ordinal,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'symbol', listed_symbol.symbol,
               'symbolKey', artifact.path || '#' || listed_symbol.symbol_key_suffix,
               'declarationKey',
                 artifact.path || '#' || listed_symbol.declaration_key_suffix
             ) ORDER BY listed_symbol.ordinal)
             FROM code_symbol_payloads listed_symbol
             WHERE listed_symbol.workspace_id = artifact.workspace_id
               AND listed_symbol.symbol_set_id = artifact.symbol_set_id), '[]'::jsonb) AS symbols,
             artifact.ordinal, artifact.start_line, artifact.end_line,
             payload.content, artifact.content_sha256,
             ARRAY[]::text[] AS matched_channels, 0::real AS score
           FROM selected_generation selected
           JOIN code_artifacts artifact
             ON artifact.workspace_id = $1
            AND artifact.repository_id = selected.repository_id
            AND artifact.revision_id = selected.revision_id
            AND artifact.generation_id = selected.generation_id
           JOIN code_artifact_payloads payload
             ON payload.workspace_id = artifact.workspace_id
            AND payload.id = artifact.payload_id
            AND payload.content_sha256 = artifact.content_sha256
           WHERE artifact.id = ANY($4::uuid[])
           ORDER BY array_position($4::uuid[], artifact.id)`,
          [actor.workspaceId, repositoryKey, commitOid, selectedArtifactIds],
        );
        return result.rows.map(toCodeArtifact);
      });
    },

    async getArtifactLogicalDigests(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const commitOid = validateCommitOid(input.commitOid);
      const selectedArtifactIds = artifactIds(input.artifactIds);
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<ArtifactLogicalDigestRow>(
          `WITH selected_generation AS MATERIALIZED (
             SELECT repository.id AS repository_id, revision.id AS revision_id,
               generation.id AS generation_id
             FROM code_repositories repository
             JOIN code_revisions revision
               ON revision.workspace_id = repository.workspace_id
              AND revision.repository_id = repository.id
             JOIN code_index_generations generation
               ON generation.workspace_id = revision.workspace_id
              AND generation.repository_id = revision.repository_id
              AND generation.revision_id = revision.id
             WHERE repository.workspace_id = $1
               AND repository.repository_key = $2
               AND revision.commit_oid = $3
               AND generation.status = 'active'
           ), requested AS MATERIALIZED (
             SELECT artifact.*
             FROM selected_generation selected
             JOIN code_artifacts artifact
               ON artifact.workspace_id = $1
              AND artifact.repository_id = selected.repository_id
              AND artifact.revision_id = selected.revision_id
              AND artifact.generation_id = selected.generation_id
             WHERE artifact.id = ANY($4::uuid[])
           )
           SELECT requested.id AS artifact_id,
             CASE WHEN requested.declaration_key IS NULL
               THEN requested.content_sha256
               ELSE encode(sha256(convert_to(string_agg(
                 sibling.content_sha256, '' ORDER BY sibling.declaration_chunk_ordinal,
                   sibling.ordinal, sibling.id
               ), 'UTF8')), 'hex')
             END AS fingerprint_sha256
           FROM requested
           LEFT JOIN code_artifacts sibling
             ON sibling.workspace_id = requested.workspace_id
            AND sibling.repository_id = requested.repository_id
            AND sibling.revision_id = requested.revision_id
            AND sibling.generation_id = requested.generation_id
            AND sibling.declaration_key = requested.declaration_key
           GROUP BY requested.id, requested.content_sha256, requested.declaration_key
           ORDER BY array_position($4::uuid[], requested.id)`,
          [actor.workspaceId, repositoryKey, commitOid, selectedArtifactIds],
        );
        return result.rows.map((row) => ({
          artifactId: row.artifact_id,
          fingerprintSha256: row.fingerprint_sha256,
        }));
      });
    },

    async getIndexJob(actor, input) {
      const jobId = validateUuid(input.jobId, "jobId");
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<CodeIndexJobRow>(
          `SELECT job.id, job.repository_id, repository.repository_key,
             job.commit_oid, job.source_ref, job.indexer_revision, job.status,
             job.attempt_count, job.max_attempts, job.available_at,
             job.completed_at, job.last_error, job.created_at, job.updated_at
           FROM code_index_jobs job
           JOIN code_repositories repository
             ON repository.workspace_id = job.workspace_id
            AND repository.id = job.repository_id
           WHERE job.workspace_id = $1 AND job.id = $2`,
          [actor.workspaceId, jobId],
        );
        const job = result.rows[0];
        if (!job) {
          throw new CodeIndexAccessDeniedError("Index job is not visible to this Actor");
        }
        return toCodeIndexJob(job);
      });
    },

    async listIndexJobs(actor, input = {}) {
      const limit = input.limit ?? DEFAULT_CODE_INDEX_JOB_LIST;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_CODE_INDEX_JOB_LIST) {
        throw new CodeIndexValidationError(
          `limit must be an integer from 1 through ${MAXIMUM_CODE_INDEX_JOB_LIST}`,
        );
      }
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<CodeIndexJobRow>(
          `SELECT job.id, job.repository_id, repository.repository_key,
             job.commit_oid, job.source_ref, job.indexer_revision, job.status,
             job.attempt_count, job.max_attempts, job.available_at,
             job.completed_at, job.last_error, job.created_at, job.updated_at
           FROM code_index_jobs job
           JOIN code_repositories repository
             ON repository.workspace_id = job.workspace_id
            AND repository.id = job.repository_id
           WHERE job.workspace_id = $1
           ORDER BY job.created_at DESC, job.id DESC
           LIMIT $2`,
          [actor.workspaceId, limit],
        );
        return result.rows.map(toCodeIndexJob);
      });
    },

    async getGitRevisionManifest(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const commitOid = validateCommitOid(input.commitOid);
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const revision = await transaction.query<{ id: string }>(
          `SELECT revision.id
           FROM code_revisions revision
           JOIN code_repositories repository
             ON repository.workspace_id = revision.workspace_id
            AND repository.id = revision.repository_id
           WHERE revision.workspace_id = $1
             AND repository.repository_key = $2
             AND revision.commit_oid = $3
             AND revision.tree_digest IS NOT NULL`,
          [actor.workspaceId, repositoryKey, commitOid],
        );
        const revisionId = revision.rows[0]?.id;
        if (!revisionId) {
          throw new CodeIndexAccessDeniedError(
            "Authenticated Git revision is not visible to this Actor",
          );
        }
        const manifest = await transaction.query<GitManifestRow>(
          `SELECT path, git_mode, object_type, object_oid, byte_size,
             content_sha256, index_status, exclusion_reason
           FROM code_revision_files
           WHERE workspace_id = $1 AND revision_id = $2
           ORDER BY path`,
          [actor.workspaceId, revisionId],
        );
        return toGitManifest(manifest.rows);
      });
    },

    async search(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const commitOid = validateCommitOid(input.commitOid);
      const query = validatePlainText(input.query, "query", 2_000);
      const literalPattern = exactLikePattern(query);
      const contentLiteralPredicate = hasTrigramWord(query)
        ? `lower(payload.content) LIKE lower($8) ESCAPE chr(92)`
        : `position(lower($3) in lower(payload.content)) > 0 AND $8::text IS NOT NULL`;
      const symbolLiteralPredicate = hasTrigramWord(query)
        ? `lower(indexed_symbol.symbol) LIKE lower($8) ESCAPE chr(92)`
        : `position(lower($3) in lower(indexed_symbol.symbol)) > 0`;
      const pathLiteralPredicate = hasTrigramWord(query)
        ? `lower(artifact.path) LIKE lower($8) ESCAPE chr(92)`
        : `position(lower($3) in lower(artifact.path)) > 0`;
      const limit = input.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new CodeIndexValidationError("limit must be an integer from 1 through 100");
      }
      const pathPrefix = input.pathPrefix ? validatePath(input.pathPrefix) : null;
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<ArtifactRow>(
          `WITH selected_generation AS MATERIALIZED (
             SELECT repository.id AS repository_id, revision.id AS revision_id,
               generation.id AS generation_id, revision.commit_oid
             FROM code_repositories repository
             JOIN code_revisions revision
               ON revision.workspace_id = repository.workspace_id
              AND revision.repository_id = repository.id
             JOIN code_index_generations generation
               ON generation.workspace_id = revision.workspace_id
              AND generation.repository_id = revision.repository_id
              AND generation.revision_id = revision.id
             WHERE repository.workspace_id = $1
               AND repository.repository_key = $2
               AND revision.commit_oid = $4
               AND generation.status = $5
           ), symbol_matches AS MATERIALIZED (
             SELECT artifact.id, artifact.path, artifact.ordinal,
               indexed_symbol.symbol AS matched_symbol,
               artifact.path || '#' || indexed_symbol.symbol_key_suffix AS matched_symbol_key,
               artifact.path || '#' || indexed_symbol.declaration_key_suffix
                 AS matched_declaration_key,
               row_number() OVER (PARTITION BY artifact.id ORDER BY
                 (lower(indexed_symbol.symbol) = lower($3)) DESC,
                 indexed_symbol.ordinal) AS artifact_match_rank
             FROM selected_generation selected
             JOIN code_artifacts artifact
               ON artifact.workspace_id = $1
              AND artifact.repository_id = selected.repository_id
              AND artifact.revision_id = selected.revision_id
              AND artifact.generation_id = selected.generation_id
             JOIN code_symbol_payloads indexed_symbol
               ON indexed_symbol.workspace_id = artifact.workspace_id
              AND indexed_symbol.symbol_set_id = artifact.symbol_set_id
             WHERE ${symbolLiteralPredicate}
               AND ($6::text IS NULL OR artifact.path = $6
                 OR left(artifact.path, length($6) + 1) = $6 || '/')
           ), symbol_candidates AS (
             SELECT id, 'symbol'::text AS channel, 4.0::real AS channel_weight,
               row_number() OVER (ORDER BY
                 (lower(matched_symbol) = lower($3)) DESC,
                 lower(matched_symbol), path, ordinal, id) AS channel_rank,
               matched_symbol, matched_symbol_key, matched_declaration_key
             FROM symbol_matches WHERE artifact_match_rank = 1
             ORDER BY (lower(matched_symbol) = lower($3)) DESC,
               lower(matched_symbol), path, ordinal, id LIMIT $9
           ), literal_candidates AS (
             SELECT artifact.id, 'literal'::text AS channel, 2.0::real AS channel_weight,
               row_number() OVER (ORDER BY artifact.path, artifact.ordinal, artifact.id)
                 AS channel_rank,
               NULL::text AS matched_symbol, NULL::text AS matched_symbol_key,
               NULL::text AS matched_declaration_key
             FROM selected_generation selected
             JOIN code_artifacts artifact
               ON artifact.workspace_id = $1
              AND artifact.repository_id = selected.repository_id
              AND artifact.revision_id = selected.revision_id
              AND artifact.generation_id = selected.generation_id
             JOIN code_artifact_payloads payload
               ON payload.workspace_id = artifact.workspace_id
              AND payload.id = artifact.payload_id
              AND payload.content_sha256 = artifact.content_sha256
             WHERE ${contentLiteralPredicate}
               AND ($6::text IS NULL OR artifact.path = $6
                 OR left(artifact.path, length($6) + 1) = $6 || '/')
             ORDER BY artifact.path, artifact.ordinal, artifact.id LIMIT $9
           ), lexical_candidates AS (
             SELECT artifact.id, 'lexical'::text AS channel, 1.0::real AS channel_weight,
               row_number() OVER (ORDER BY ts_rank_cd(
                 payload.search_vector, websearch_to_tsquery('simple', $3), 32
               ) DESC, artifact.path, artifact.ordinal, artifact.id) AS channel_rank,
               NULL::text AS matched_symbol, NULL::text AS matched_symbol_key,
               NULL::text AS matched_declaration_key
             FROM selected_generation selected
             JOIN code_artifacts artifact
               ON artifact.workspace_id = $1
              AND artifact.repository_id = selected.repository_id
              AND artifact.revision_id = selected.revision_id
              AND artifact.generation_id = selected.generation_id
             JOIN code_artifact_payloads payload
               ON payload.workspace_id = artifact.workspace_id
              AND payload.id = artifact.payload_id
              AND payload.content_sha256 = artifact.content_sha256
             WHERE payload.search_vector @@ websearch_to_tsquery('simple', $3)
               AND ($6::text IS NULL OR artifact.path = $6
                 OR left(artifact.path, length($6) + 1) = $6 || '/')
             ORDER BY ts_rank_cd(payload.search_vector, websearch_to_tsquery('simple', $3), 32)
               DESC, artifact.path, artifact.ordinal, artifact.id LIMIT $9
           ), path_candidates AS (
             SELECT id, 'path'::text AS channel, 1.5::real AS channel_weight,
               row_number() OVER (ORDER BY (lower(path) = lower($3)) DESC,
                 position(lower($3) in lower(path)), path, ordinal, id) AS channel_rank,
               NULL::text AS matched_symbol, NULL::text AS matched_symbol_key,
               NULL::text AS matched_declaration_key
             FROM selected_generation selected
             JOIN code_artifacts artifact
               ON artifact.workspace_id = $1
              AND artifact.repository_id = selected.repository_id
              AND artifact.revision_id = selected.revision_id
              AND artifact.generation_id = selected.generation_id
             WHERE ${pathLiteralPredicate}
               AND ($6::text IS NULL OR artifact.path = $6
                 OR left(artifact.path, length($6) + 1) = $6 || '/')
             ORDER BY (lower(path) = lower($3)) DESC,
               position(lower($3) in lower(path)), path, ordinal, id LIMIT $9
           ), candidates AS (
             SELECT * FROM symbol_candidates UNION ALL SELECT * FROM literal_candidates
             UNION ALL SELECT * FROM lexical_candidates UNION ALL SELECT * FROM path_candidates
           ), fused AS (
             SELECT id, sum(channel_weight / (60.0 + channel_rank))::real AS score,
               array_agg(channel ORDER BY channel)::text[] AS matched_channels,
               max(matched_symbol) AS matched_symbol,
               max(matched_symbol_key) AS matched_symbol_key,
               max(matched_declaration_key) AS matched_declaration_key
             FROM candidates GROUP BY id
           )
           SELECT artifact.id, artifact.repository_id, artifact.revision_id,
             artifact.generation_id, selected.commit_oid, artifact.path,
             artifact.language, artifact.parser, artifact.parse_status, artifact.kind,
             COALESCE(fused.matched_symbol, artifact.symbol) AS symbol,
             COALESCE(fused.matched_symbol_key, artifact.symbol_key) AS symbol_key,
             COALESCE(fused.matched_declaration_key, artifact.declaration_key)
               AS declaration_key,
             artifact.declaration_chunk_ordinal,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'symbol', listed_symbol.symbol,
               'symbolKey', artifact.path || '#' || listed_symbol.symbol_key_suffix,
               'declarationKey',
                 artifact.path || '#' || listed_symbol.declaration_key_suffix
             ) ORDER BY listed_symbol.ordinal)
             FROM code_symbol_payloads listed_symbol
             WHERE listed_symbol.workspace_id = artifact.workspace_id
               AND listed_symbol.symbol_set_id = artifact.symbol_set_id), '[]'::jsonb) AS symbols,
             artifact.ordinal, artifact.start_line, artifact.end_line,
             payload.content, artifact.content_sha256,
             fused.matched_channels, fused.score
           FROM fused
           JOIN code_artifacts artifact ON artifact.workspace_id = $1
             AND artifact.id = fused.id
           JOIN code_artifact_payloads payload
             ON payload.workspace_id = artifact.workspace_id
            AND payload.id = artifact.payload_id
            AND payload.content_sha256 = artifact.content_sha256
           JOIN selected_generation selected
             ON selected.repository_id = artifact.repository_id
            AND selected.revision_id = artifact.revision_id
            AND selected.generation_id = artifact.generation_id
           ORDER BY fused.score DESC, artifact.path, artifact.ordinal, artifact.id
           LIMIT $7`,
          [
            actor.workspaceId,
            repositoryKey,
            query,
            commitOid,
            "active",
            pathPrefix,
            limit,
            literalPattern,
            Math.min(limit * 4, 400),
          ],
        );
        return result.rows.map(toCodeArtifact);
      });
    },
  };
}
