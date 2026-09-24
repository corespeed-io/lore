import type { PostgresDatabase, PostgresTransaction } from "@corespeed/lore-core";
import { isPostgresAccessDenied } from "@corespeed/lore-core";
import {
  validateCommitOid,
  validatePlainText,
  validateUuid,
} from "@/modules/code/indexing/validation";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";

export type CodeEvidenceRelationship = "contradicts" | "implements" | "rationale" | "supports";
export type CodeEvidenceValidationState =
  | "ambiguous"
  | "changed"
  | "current"
  | "deleted"
  | "moved"
  | "unverifiable";

export interface MemoryCodeEvidence {
  id: string;
  memoryId: string;
  repositoryId: string;
  citedRevisionId: string;
  citedGenerationId: string;
  citedArtifactId: string;
  citedCommitOid: string;
  citedPath: string;
  citedSymbolKey: string | null;
  citedDeclarationKey: string | null;
  citedDeclarationChunkOrdinal: number | null;
  citedDeclarationContextSha256: string | null;
  citedContentSha256: string;
  relationship: CodeEvidenceRelationship;
  validationState: CodeEvidenceValidationState;
  validatedRevisionId: string | null;
  validatedGenerationId: string | null;
  validatedArtifactId: string | null;
  validatedCommitOid: string | null;
  validatedPath: string | null;
  createdByUserId: string;
  createdByAgentId: string | null;
  createdAt: string;
  validatedAt: string;
}

export interface CiteMemoryCodeEvidenceInput {
  memoryId: string;
  artifactId: string;
  relationship: CodeEvidenceRelationship;
}

export interface ListMemoryCodeEvidenceInput {
  memoryId: string;
}

export interface RevalidateMemoryCodeEvidenceInput {
  evidenceId: string;
  repositoryKey: string;
  commitOid: string;
}

export type AssessMemoryCodeEvidenceInput = RevalidateMemoryCodeEvidenceInput;

export interface CodeEvidenceAssessment {
  evidenceId: string;
  validationState: CodeEvidenceValidationState;
  validatedRevisionId: string | null;
  validatedGenerationId: string | null;
  validatedArtifactId: string | null;
  validatedCommitOid: string | null;
  validatedPath: string | null;
}

export interface AssessMemoryCitationsInput {
  /** Visible Memories, in the order their citations are collected. */
  memoryIds: readonly string[];
  repositoryKey: string;
  commitOid: string;
  /** Maximum number of citations collected across all Memories. */
  limit: number;
}

export interface AssessedMemoryCitation {
  citation: MemoryCodeEvidence;
  assessment: CodeEvidenceAssessment;
}

export const MAXIMUM_ASSESSED_CITATION_MEMORIES = 100;
export const MAXIMUM_ASSESSED_CITATIONS = 100;

export interface CodeEvidenceModule {
  assess(
    actor: ActorContext,
    input: AssessMemoryCodeEvidenceInput,
  ): Promise<CodeEvidenceAssessment>;
  /**
   * Lists the citations of the given Memories and assesses each one exactly as `assess`
   * would, in one read-only transaction. It never persists validation state.
   */
  assessMemoryCitations(
    actor: ActorContext,
    input: AssessMemoryCitationsInput,
  ): Promise<AssessedMemoryCitation[]>;
  cite(actor: ActorContext, input: CiteMemoryCodeEvidenceInput): Promise<MemoryCodeEvidence>;
  list(actor: ActorContext, input: ListMemoryCodeEvidenceInput): Promise<MemoryCodeEvidence[]>;
  revalidate(
    actor: ActorContext,
    input: RevalidateMemoryCodeEvidenceInput,
  ): Promise<MemoryCodeEvidence>;
}

export class CodeEvidenceAccessDeniedError extends Error {
  override name = "CodeEvidenceAccessDeniedError";
  readonly status = 403;
}

export class CodeEvidenceValidationError extends Error {
  override name = "CodeEvidenceValidationError";
  readonly status = 400;
}

interface EvidenceRow {
  id: string;
  memory_id: string;
  repository_id: string;
  cited_revision_id: string;
  cited_generation_id: string;
  cited_artifact_id: string;
  cited_commit_oid: string;
  cited_path: string;
  cited_symbol_key: string | null;
  cited_declaration_key: string | null;
  cited_declaration_chunk_ordinal: number | null;
  cited_declaration_context_sha256: string | null;
  cited_content_sha256: string;
  relationship: CodeEvidenceRelationship;
  validation_state: CodeEvidenceValidationState;
  validated_revision_id: string | null;
  validated_generation_id: string | null;
  validated_artifact_id: string | null;
  validated_commit_oid: string | null;
  validated_path: string | null;
  created_by_user_id: string;
  created_by_agent_id: string | null;
  created_at: Date | string;
  validated_at: Date | string;
}

interface RevalidationCandidate {
  id: string;
  path: string;
  content_sha256: string;
  symbol_key: string | null;
  declaration_key: string | null;
  declaration_chunk_ordinal: number | null;
  declaration_context_sha256: string | null;
}

const EVIDENCE_SELECT = `SELECT evidence.id, evidence.memory_id,
  evidence.repository_id, evidence.cited_revision_id, evidence.cited_generation_id,
  evidence.cited_artifact_id, evidence.cited_commit_oid,
  evidence.cited_path, evidence.cited_symbol_key, evidence.cited_declaration_key,
  evidence.cited_declaration_chunk_ordinal, evidence.cited_declaration_context_sha256,
  evidence.cited_content_sha256,
  evidence.relationship, evidence.validation_state,
  evidence.validated_revision_id, evidence.validated_generation_id,
  evidence.validated_artifact_id, evidence.validated_commit_oid,
  evidence.validated_path, evidence.created_by_user_id, evidence.created_by_agent_id,
  evidence.created_at, evidence.validated_at
FROM memory_code_evidence evidence`;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function toEvidence(row: EvidenceRow): MemoryCodeEvidence {
  return {
    id: row.id,
    memoryId: row.memory_id,
    repositoryId: row.repository_id,
    citedRevisionId: row.cited_revision_id,
    citedGenerationId: row.cited_generation_id,
    citedArtifactId: row.cited_artifact_id,
    citedCommitOid: row.cited_commit_oid,
    citedPath: row.cited_path,
    citedSymbolKey: row.cited_symbol_key,
    citedDeclarationKey: row.cited_declaration_key,
    citedDeclarationChunkOrdinal: row.cited_declaration_chunk_ordinal,
    citedDeclarationContextSha256: row.cited_declaration_context_sha256,
    citedContentSha256: row.cited_content_sha256,
    relationship: row.relationship,
    validationState: row.validation_state,
    validatedRevisionId: row.validated_revision_id,
    validatedGenerationId: row.validated_generation_id,
    validatedArtifactId: row.validated_artifact_id,
    validatedCommitOid: row.validated_commit_oid,
    validatedPath: row.validated_path,
    createdByUserId: row.created_by_user_id,
    createdByAgentId: row.created_by_agent_id,
    createdAt: timestamp(row.created_at),
    validatedAt: timestamp(row.validated_at),
  };
}

async function evidenceById(
  transaction: PostgresTransaction,
  workspaceId: string,
  evidenceId: string,
): Promise<EvidenceRow | null> {
  const result = await transaction.query<EvidenceRow>(
    `${EVIDENCE_SELECT}
     WHERE evidence.workspace_id = $1 AND evidence.id = $2`,
    [workspaceId, evidenceId],
  );
  return result.rows[0] ?? null;
}

interface AssessmentTarget {
  revision_id: string;
  generation_id: string;
  indexer_revision: string;
}

/** The active generation of one exact revision of the cited repository, if indexed. */
async function assessmentTarget(
  transaction: PostgresTransaction,
  workspaceId: string,
  repositoryId: string,
  repositoryKey: string,
  commitOid: string,
): Promise<AssessmentTarget | null> {
  const target = await transaction.query<AssessmentTarget>(
    `SELECT revision.id AS revision_id, generation.id AS generation_id,
       generation.indexer_revision
     FROM code_repositories repository
     JOIN code_revisions revision
       ON revision.workspace_id = repository.workspace_id
      AND revision.repository_id = repository.id
     JOIN code_index_generations generation
       ON generation.workspace_id = revision.workspace_id
      AND generation.repository_id = revision.repository_id
      AND generation.revision_id = revision.id
      AND generation.status = 'active'
     WHERE repository.workspace_id = $1
       AND repository.id = $2
       AND repository.repository_key = $3
       AND revision.commit_oid = $4`,
    [workspaceId, repositoryId, repositoryKey, commitOid],
  );
  return target.rows[0] ?? null;
}

/** A symbol or declaration key without its `path#` prefix: the identity a rename preserves. */
function pathFreeIdentity(key: string | null, path: string): string | null {
  const prefix = `${path}#`;
  return key?.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** A path-free symbol key is `<kind>:<symbol>`, and tree-sitter kinds never contain a colon. */
function identitySymbol(symbolIdentity: string | null): string | null {
  if (!symbolIdentity) return null;
  const separator = symbolIdentity.indexOf(":");
  return separator < 0 ? null : symbolIdentity.slice(separator + 1) || null;
}

type IdentityColumn = "declaration_key_suffix" | "symbol_key_suffix";

/**
 * Artifacts of one generation whose primary symbol carries a cited path-free identity. The
 * Symbol Set payload is reached through its `(workspace_id, symbol)` index instead of a suffix
 * scan over the generation. $1-$4 select the generation; $5 and $6 name the symbol and its
 * path-free identity.
 */
function identityArtifactsSql(identityColumn: IdentityColumn): string {
  return `SELECT artifact.id, artifact.declaration_chunk_ordinal
    FROM code_symbol_payloads identity_symbol
    JOIN code_artifacts artifact
      ON artifact.workspace_id = identity_symbol.workspace_id
     AND artifact.symbol_set_id = identity_symbol.symbol_set_id
    WHERE identity_symbol.workspace_id = $1
      AND identity_symbol.symbol = $5
      AND identity_symbol.ordinal = 0
      AND identity_symbol.${identityColumn} = $6
      AND artifact.repository_id = $2
      AND artifact.revision_id = $3
      AND artifact.generation_id = $4`;
}

async function assessAgainstTarget(
  transaction: PostgresTransaction,
  workspaceId: string,
  cited: EvidenceRow,
  target: AssessmentTarget | null,
  commitOid: string,
): Promise<CodeEvidenceAssessment> {
  if (!target) {
    return {
      evidenceId: cited.id,
      validationState: "unverifiable",
      validatedRevisionId: null,
      validatedGenerationId: null,
      validatedArtifactId: null,
      validatedCommitOid: null,
      validatedPath: null,
    };
  }
  const symbolIdentity = pathFreeIdentity(cited.cited_symbol_key, cited.cited_path);
  const declarationIdentity = pathFreeIdentity(cited.cited_declaration_key, cited.cited_path);
  const symbol = identitySymbol(symbolIdentity);
  const declarationIdentityUsable =
    declarationIdentity !== null &&
    cited.cited_declaration_chunk_ordinal !== null &&
    cited.cited_declaration_context_sha256 !== null;
  // A cited declaration follows its own chunk ordinal; a bare symbol follows every chunk.
  const identity: { column: IdentityColumn; value: string; ordinal: number | null } | null =
    declarationIdentity !== null
      ? cited.cited_declaration_chunk_ordinal === null
        ? null
        : {
            column: "declaration_key_suffix",
            value: declarationIdentity,
            ordinal: cited.cited_declaration_chunk_ordinal,
          }
      : symbolIdentity !== null
        ? { column: "symbol_key_suffix", value: symbolIdentity, ordinal: null }
        : null;
  const generation = [workspaceId, cited.repository_id, target.revision_id, target.generation_id];
  // Each branch is served by an index: path, content digest through its payload, and
  // identity through the Symbol Set payload. Their priority order decides the state.
  const candidates = await transaction.query<RevalidationCandidate>(
    `WITH identity_candidate AS MATERIALIZED (
       SELECT identity.id
       FROM (${identityArtifactsSql(identity?.column ?? "declaration_key_suffix")}) identity
       WHERE $9::integer IS NULL OR identity.declaration_chunk_ordinal = $9
     ), candidate AS (
       SELECT artifact.id
       FROM code_artifacts artifact
       WHERE artifact.workspace_id = $1
         AND artifact.repository_id = $2
         AND artifact.revision_id = $3
         AND artifact.generation_id = $4
         AND artifact.path = $8
       UNION
       SELECT artifact.id
       FROM code_artifact_payloads payload
       JOIN code_artifacts artifact
         ON artifact.workspace_id = payload.workspace_id
        AND artifact.payload_id = payload.id
       WHERE payload.workspace_id = $1
         AND payload.indexer_revision = $10
         AND payload.content_sha256 = $7
         AND artifact.repository_id = $2
         AND artifact.revision_id = $3
         AND artifact.generation_id = $4
       UNION
       SELECT id FROM identity_candidate
     )
     SELECT artifact.id, artifact.path, artifact.content_sha256,
       artifact.symbol_key, artifact.declaration_key,
       artifact.declaration_chunk_ordinal,
       CASE WHEN artifact.declaration_key IS NULL THEN NULL ELSE (
         SELECT encode(sha256(convert_to(string_agg(
           CASE WHEN sibling.id = artifact.id THEN '*' ELSE sibling.content_sha256 END,
           '' ORDER BY sibling.declaration_chunk_ordinal
         ), 'UTF8')), 'hex')
         FROM code_artifacts sibling
         WHERE sibling.workspace_id = artifact.workspace_id
           AND sibling.repository_id = artifact.repository_id
           AND sibling.revision_id = artifact.revision_id
           AND sibling.generation_id = artifact.generation_id
           AND sibling.declaration_key = artifact.declaration_key
       ) END AS declaration_context_sha256
     FROM candidate
     JOIN code_artifacts artifact
       ON artifact.workspace_id = $1
      AND artifact.id = candidate.id
     ORDER BY CASE
       WHEN artifact.path = $8 AND artifact.content_sha256 = $7 THEN 0
       WHEN artifact.content_sha256 = $7 THEN 1
       WHEN artifact.id IN (SELECT id FROM identity_candidate) THEN 2
       ELSE 3
     END,
       artifact.path, artifact.ordinal, artifact.id
     LIMIT 3`,
    [
      ...generation,
      identity ? symbol : null,
      identity?.value ?? null,
      cited.cited_content_sha256,
      cited.cited_path,
      identity?.ordinal ?? null,
      target.indexer_revision,
    ],
  );
  const exactPathContent = candidates.rows.filter(
    (candidate) =>
      candidate.path === cited.cited_path &&
      candidate.content_sha256 === cited.cited_content_sha256,
  );
  const contentMatches = candidates.rows.filter(
    (candidate) => candidate.content_sha256 === cited.cited_content_sha256,
  );
  const identityMatches =
    declarationIdentity !== null && declarationIdentityUsable
      ? candidates.rows.filter(
          (candidate) =>
            pathFreeIdentity(candidate.declaration_key, candidate.path) === declarationIdentity &&
            candidate.declaration_chunk_ordinal === cited.cited_declaration_chunk_ordinal &&
            candidate.declaration_context_sha256 === cited.cited_declaration_context_sha256,
        )
      : symbolIdentity !== null
        ? candidates.rows.filter(
            (candidate) =>
              pathFreeIdentity(candidate.symbol_key, candidate.path) === symbolIdentity,
          )
        : [];
  let state: CodeEvidenceValidationState;
  let validatedArtifact: RevalidationCandidate | null = null;
  if (exactPathContent.length === 1) {
    state = "current";
    validatedArtifact = exactPathContent[0] ?? null;
  } else if (contentMatches.length === 1) {
    state = "moved";
    validatedArtifact = contentMatches[0] ?? null;
  } else if (contentMatches.length > 1 || identityMatches.length > 1) {
    state = "ambiguous";
  } else if (identityMatches.length === 1) {
    state = "changed";
    validatedArtifact = identityMatches[0] ?? null;
  } else if (
    await declarationStillPartitioned(transaction, generation, symbol, declarationIdentity)
  ) {
    state = "ambiguous";
  } else {
    const samePathMatches = candidates.rows.filter(
      (candidate) => candidate.path === cited.cited_path,
    );
    if (samePathMatches.length === 1) {
      state = "changed";
      validatedArtifact = samePathMatches[0] ?? null;
    } else if (samePathMatches.length > 1) {
      state = "ambiguous";
    } else {
      state = "deleted";
    }
  }
  return {
    evidenceId: cited.id,
    validationState: state,
    validatedRevisionId: target.revision_id,
    validatedGenerationId: target.generation_id,
    validatedArtifactId: validatedArtifact?.id ?? null,
    validatedCommitOid: commitOid,
    validatedPath: validatedArtifact?.path ?? null,
  };
}

/**
 * Whether the cited declaration still exists in the target although none of its chunks could
 * be followed. Assessment then abstains instead of guessing from the cited path.
 */
async function declarationStillPartitioned(
  transaction: PostgresTransaction,
  generation: readonly string[],
  symbol: string | null,
  declarationIdentity: string | null,
): Promise<boolean> {
  if (symbol === null || declarationIdentity === null) return false;
  const result = await transaction.query<{ present: boolean }>(
    `SELECT EXISTS (${identityArtifactsSql("declaration_key_suffix")}) AS present`,
    [...generation, symbol, declarationIdentity],
  );
  return result.rows[0]?.present === true;
}

async function assessEvidenceInTransaction(
  transaction: PostgresTransaction,
  workspaceId: string,
  cited: EvidenceRow,
  repositoryKey: string,
  commitOid: string,
): Promise<CodeEvidenceAssessment> {
  const target = await assessmentTarget(
    transaction,
    workspaceId,
    cited.repository_id,
    repositoryKey,
    commitOid,
  );
  return assessAgainstTarget(transaction, workspaceId, cited, target, commitOid);
}

export function createCodeEvidenceModule(database: PostgresDatabase): CodeEvidenceModule {
  return {
    async assess(actor, input) {
      const evidenceId = validateUuid(input.evidenceId, "evidenceId", CodeEvidenceValidationError);
      const repositoryKey = validatePlainText(
        input.repositoryKey,
        "repositoryKey",
        512,
        CodeEvidenceValidationError,
      );
      const commitOid = validateCommitOid(input.commitOid, CodeEvidenceValidationError);
      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          // Assessment is side-effect-free; the database enforces it.
          await transaction.query("SET TRANSACTION READ ONLY");
          const cited = await evidenceById(transaction, actor.workspaceId, evidenceId);
          if (!cited) {
            throw new CodeEvidenceAccessDeniedError("Code Evidence is not visible to this Actor");
          }
          return assessEvidenceInTransaction(
            transaction,
            actor.workspaceId,
            cited,
            repositoryKey,
            commitOid,
          );
        });
      } catch (error) {
        if (
          error instanceof CodeEvidenceAccessDeniedError ||
          error instanceof CodeEvidenceValidationError
        ) {
          throw error;
        }
        if (isPostgresAccessDenied(error)) {
          throw new CodeEvidenceAccessDeniedError("Code Evidence is not visible to this Actor", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async assessMemoryCitations(actor, input) {
      const memoryIds = [
        ...new Set(
          input.memoryIds.map((memoryId) =>
            validateUuid(memoryId, "memoryId", CodeEvidenceValidationError),
          ),
        ),
      ];
      if (memoryIds.length > MAXIMUM_ASSESSED_CITATION_MEMORIES) {
        throw new CodeEvidenceValidationError(
          `memoryIds may contain at most ${MAXIMUM_ASSESSED_CITATION_MEMORIES} UUIDs`,
        );
      }
      const repositoryKey = validatePlainText(
        input.repositoryKey,
        "repositoryKey",
        512,
        CodeEvidenceValidationError,
      );
      const commitOid = validateCommitOid(input.commitOid, CodeEvidenceValidationError);
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAXIMUM_ASSESSED_CITATIONS
      ) {
        throw new CodeEvidenceValidationError(
          `limit must be an integer from 1 through ${MAXIMUM_ASSESSED_CITATIONS}`,
        );
      }
      if (memoryIds.length === 0) return [];
      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          await transaction.query("SET TRANSACTION READ ONLY");
          // Citations of Memories outside the Actor's visibility are filtered by RLS.
          const cited = await transaction.query<EvidenceRow>(
            `${EVIDENCE_SELECT}
             WHERE evidence.workspace_id = $1 AND evidence.memory_id = ANY($2::uuid[])
             ORDER BY array_position($2::uuid[], evidence.memory_id),
               evidence.created_at, evidence.id
             LIMIT $3`,
            [actor.workspaceId, memoryIds, input.limit],
          );
          const targets = new Map<string, AssessmentTarget | null>();
          const assessed: AssessedMemoryCitation[] = [];
          for (const row of cited.rows) {
            let target = targets.get(row.repository_id);
            if (target === undefined) {
              target = await assessmentTarget(
                transaction,
                actor.workspaceId,
                row.repository_id,
                repositoryKey,
                commitOid,
              );
              targets.set(row.repository_id, target);
            }
            assessed.push({
              citation: toEvidence(row),
              assessment: await assessAgainstTarget(
                transaction,
                actor.workspaceId,
                row,
                target,
                commitOid,
              ),
            });
          }
          return assessed;
        });
      } catch (error) {
        if (error instanceof CodeEvidenceValidationError) throw error;
        if (isPostgresAccessDenied(error)) {
          throw new CodeEvidenceAccessDeniedError("Code Evidence is not visible to this Actor", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async cite(actor, input) {
      const memoryId = validateUuid(input.memoryId, "memoryId", CodeEvidenceValidationError);
      const artifactId = validateUuid(input.artifactId, "artifactId", CodeEvidenceValidationError);
      if (!["supports", "contradicts", "implements", "rationale"].includes(input.relationship)) {
        throw new CodeEvidenceValidationError("relationship is invalid");
      }
      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const evidenceId = crypto.randomUUID();
          await transaction.query(
            `INSERT INTO memory_code_evidence (
               id, workspace_id, memory_id, repository_id,
               cited_revision_id, cited_generation_id, cited_artifact_id,
               cited_commit_oid, relationship, cited_path, cited_symbol_key, cited_declaration_key,
               cited_declaration_chunk_ordinal, cited_declaration_context_sha256,
               cited_content_sha256, validation_state,
               validated_revision_id, validated_generation_id,
               validated_artifact_id, validated_commit_oid, validated_path,
               created_by_user_id, created_by_agent_id
             )
             SELECT $1, artifact.workspace_id, $2, artifact.repository_id,
               artifact.revision_id, artifact.generation_id, artifact.id,
               revision.commit_oid, $3, artifact.path, artifact.symbol_key, artifact.declaration_key,
               artifact.declaration_chunk_ordinal,
               CASE WHEN artifact.declaration_key IS NULL THEN NULL ELSE (
                 SELECT encode(sha256(convert_to(string_agg(
                   CASE WHEN sibling.id = artifact.id THEN '*' ELSE sibling.content_sha256 END,
                   '' ORDER BY sibling.declaration_chunk_ordinal
                 ), 'UTF8')), 'hex')
                 FROM code_artifacts sibling
                 WHERE sibling.workspace_id = artifact.workspace_id
                   AND sibling.repository_id = artifact.repository_id
                   AND sibling.revision_id = artifact.revision_id
                   AND sibling.generation_id = artifact.generation_id
                   AND sibling.declaration_key = artifact.declaration_key
               ) END,
               artifact.content_sha256, 'current',
               artifact.revision_id, artifact.generation_id, artifact.id,
               revision.commit_oid, artifact.path,
               $4, $5
             FROM code_artifacts artifact
             JOIN code_index_generations generation
               ON generation.workspace_id = artifact.workspace_id
              AND generation.repository_id = artifact.repository_id
              AND generation.revision_id = artifact.revision_id
              AND generation.id = artifact.generation_id
              AND generation.status = 'active'
             JOIN code_revisions revision
               ON revision.workspace_id = artifact.workspace_id
              AND revision.repository_id = artifact.repository_id
              AND revision.id = artifact.revision_id
             WHERE artifact.workspace_id = $6 AND artifact.id = $7
             ON CONFLICT (memory_id, cited_artifact_id, relationship) DO NOTHING`,
            [
              evidenceId,
              memoryId,
              input.relationship,
              actor.userId,
              actor.agentId ?? null,
              actor.workspaceId,
              artifactId,
            ],
          );
          const result = await transaction.query<EvidenceRow>(
            `${EVIDENCE_SELECT}
             WHERE evidence.workspace_id = $1
               AND evidence.memory_id = $2
               AND evidence.cited_artifact_id = $3
               AND evidence.relationship = $4`,
            [actor.workspaceId, memoryId, artifactId, input.relationship],
          );
          const row = result.rows[0];
          if (!row) {
            throw new CodeEvidenceAccessDeniedError(
              "Memory or Code Artifact is not writable and visible to this Actor",
            );
          }
          return toEvidence(row);
        });
      } catch (error) {
        if (
          error instanceof CodeEvidenceAccessDeniedError ||
          error instanceof CodeEvidenceValidationError
        ) {
          throw error;
        }
        if (isPostgresAccessDenied(error)) {
          throw new CodeEvidenceAccessDeniedError(
            "Memory or Code Artifact is not writable and visible to this Actor",
            { cause: error },
          );
        }
        throw error;
      }
    },

    async list(actor, input) {
      const memoryId = validateUuid(input.memoryId, "memoryId", CodeEvidenceValidationError);
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const visible = await transaction.query<{ id: string }>(
          "SELECT id FROM memories WHERE workspace_id = $1 AND id = $2",
          [actor.workspaceId, memoryId],
        );
        if (!visible.rows[0]) {
          throw new CodeEvidenceAccessDeniedError("Memory is not visible to this Actor");
        }
        const result = await transaction.query<EvidenceRow>(
          `${EVIDENCE_SELECT}
           WHERE evidence.workspace_id = $1 AND evidence.memory_id = $2
           ORDER BY evidence.created_at, evidence.id`,
          [actor.workspaceId, memoryId],
        );
        return result.rows.map(toEvidence);
      });
    },

    async revalidate(actor, input) {
      const evidenceId = validateUuid(input.evidenceId, "evidenceId", CodeEvidenceValidationError);
      const repositoryKey = validatePlainText(
        input.repositoryKey,
        "repositoryKey",
        512,
        CodeEvidenceValidationError,
      );
      const commitOid = validateCommitOid(input.commitOid, CodeEvidenceValidationError);
      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const cited = await evidenceById(transaction, actor.workspaceId, evidenceId);
          if (!cited) {
            throw new CodeEvidenceAccessDeniedError("Code Evidence is not visible to this Actor");
          }
          const assessment = await assessEvidenceInTransaction(
            transaction,
            actor.workspaceId,
            cited,
            repositoryKey,
            commitOid,
          );
          const persisted = await transaction.query<{ id: string }>(
            `UPDATE memory_code_evidence
             SET validation_state = $3,
                 validated_revision_id = $4,
                 validated_generation_id = $5,
                 validated_artifact_id = $6,
                 validated_commit_oid = $7,
                 validated_path = $8,
                 validated_at = now()
             WHERE workspace_id = $1 AND id = $2
             RETURNING id`,
            [
              actor.workspaceId,
              evidenceId,
              assessment.validationState,
              assessment.validatedRevisionId,
              assessment.validatedGenerationId,
              assessment.validatedArtifactId,
              assessment.validatedCommitOid,
              assessment.validatedPath,
            ],
          );
          if (!persisted.rows[0]) {
            throw new CodeEvidenceAccessDeniedError("Code Evidence is not writable by this Actor");
          }
          const updated = await evidenceById(transaction, actor.workspaceId, evidenceId);
          if (!updated) {
            throw new CodeEvidenceAccessDeniedError("Code Evidence is not writable by this Actor");
          }
          return toEvidence(updated);
        });
      } catch (error) {
        if (
          error instanceof CodeEvidenceAccessDeniedError ||
          error instanceof CodeEvidenceValidationError
        ) {
          throw error;
        }
        if (isPostgresAccessDenied(error)) {
          throw new CodeEvidenceAccessDeniedError("Code Evidence is not writable by this Actor", {
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}
