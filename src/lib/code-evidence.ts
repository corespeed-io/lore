import { type ActorContext, installActorContext } from "./actor-context";
import { isPostgresAccessDenied } from "./database-errors";
import type { PostgresDatabase, PostgresTransaction } from "./db";

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

export interface CodeEvidenceModule {
  assess(
    actor: ActorContext,
    input: AssessMemoryCodeEvidenceInput,
  ): Promise<CodeEvidenceAssessment>;
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

function validateUuid(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw new CodeEvidenceValidationError(`${name} must be a UUID`);
  }
  return normalized;
}

function validateCommitOid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(normalized)) {
    throw new CodeEvidenceValidationError("commitOid must be a full 40- or 64-character Git OID");
  }
  return normalized;
}

function validateRepositoryKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || hasControlCharacters(normalized)) {
    throw new CodeEvidenceValidationError("repositoryKey is invalid");
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

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

function symbolSuffix(symbolKey: string | null): string | null {
  if (!symbolKey) return null;
  const separator = symbolKey.indexOf("#");
  return separator < 0 ? symbolKey : symbolKey.slice(separator);
}

async function assessEvidenceInTransaction(
  transaction: PostgresTransaction,
  workspaceId: string,
  evidenceId: string,
  cited: EvidenceRow,
  repositoryKey: string,
  commitOid: string,
): Promise<CodeEvidenceAssessment> {
  const target = await transaction.query<{
    revision_id: string;
    generation_id: string;
  }>(
    `SELECT revision.id AS revision_id, generation.id AS generation_id
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
    [workspaceId, cited.repository_id, repositoryKey, commitOid],
  );
  const targetRevision = target.rows[0];
  let state: CodeEvidenceValidationState = "unverifiable";
  let validatedRevisionId: string | null = null;
  let validatedGenerationId: string | null = null;
  let validatedArtifact: RevalidationCandidate | null = null;
  if (targetRevision) {
    validatedRevisionId = targetRevision.revision_id;
    validatedGenerationId = targetRevision.generation_id;
    const symbolIdentitySuffix = symbolSuffix(cited.cited_symbol_key);
    const declarationIdentitySuffix = symbolSuffix(cited.cited_declaration_key);
    const declarationIdentityUsable =
      declarationIdentitySuffix !== null &&
      cited.cited_declaration_chunk_ordinal !== null &&
      cited.cited_declaration_context_sha256 !== null;
    let declarationPartitionAmbiguous = false;
    if (declarationIdentitySuffix !== null) {
      const targetDeclaration = await transaction.query<{ target_count: number }>(
        `SELECT count(*)::integer AS target_count
         FROM code_artifacts artifact
         WHERE artifact.workspace_id = $1
           AND artifact.repository_id = $2
           AND artifact.revision_id = $3
           AND artifact.generation_id = $4
           AND right(artifact.declaration_key, length($5)) = $5`,
        [
          workspaceId,
          cited.repository_id,
          validatedRevisionId,
          validatedGenerationId,
          declarationIdentitySuffix,
        ],
      );
      declarationPartitionAmbiguous = Number(targetDeclaration.rows[0]?.target_count ?? 0) > 0;
    }
    const candidates = await transaction.query<RevalidationCandidate>(
      `SELECT artifact.id, artifact.path, artifact.content_sha256,
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
       FROM code_artifacts artifact
       WHERE artifact.workspace_id = $1
         AND artifact.repository_id = $2
         AND artifact.revision_id = $3
         AND artifact.generation_id = $4
         AND (
           artifact.content_sha256 = $5
           OR artifact.path = $6
           OR ($7::text IS NOT NULL AND $8::integer IS NOT NULL AND right(
             artifact.declaration_key, length($7)
           ) = $7 AND artifact.declaration_chunk_ordinal = $8)
           OR ($7::text IS NULL AND $9::text IS NOT NULL AND right(
             artifact.symbol_key, length($9)
           ) = $9)
         )
       ORDER BY CASE
         WHEN artifact.path = $6 AND artifact.content_sha256 = $5 THEN 0
         WHEN artifact.content_sha256 = $5 THEN 1
         WHEN $7::text IS NOT NULL AND $8::integer IS NOT NULL AND right(
           artifact.declaration_key, length($7)
         ) = $7 AND artifact.declaration_chunk_ordinal = $8 THEN 2
         WHEN $7::text IS NULL AND $9::text IS NOT NULL AND right(
           artifact.symbol_key, length($9)
         ) = $9 THEN 2
         ELSE 3
       END,
         artifact.path, artifact.ordinal, artifact.id
       LIMIT 3`,
      [
        workspaceId,
        cited.repository_id,
        validatedRevisionId,
        validatedGenerationId,
        cited.cited_content_sha256,
        cited.cited_path,
        declarationIdentitySuffix,
        cited.cited_declaration_chunk_ordinal,
        symbolIdentitySuffix,
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
      declarationIdentitySuffix && declarationIdentityUsable
        ? candidates.rows.filter(
            (candidate) =>
              candidate.declaration_key?.endsWith(declarationIdentitySuffix) &&
              candidate.declaration_chunk_ordinal === cited.cited_declaration_chunk_ordinal &&
              candidate.declaration_context_sha256 === cited.cited_declaration_context_sha256,
          )
        : symbolIdentitySuffix
          ? candidates.rows.filter((candidate) =>
              candidate.symbol_key?.endsWith(symbolIdentitySuffix),
            )
          : [];
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
    } else if (declarationPartitionAmbiguous) {
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
  }
  return {
    evidenceId,
    validationState: state,
    validatedRevisionId,
    validatedGenerationId,
    validatedArtifactId: validatedArtifact?.id ?? null,
    validatedCommitOid: targetRevision ? commitOid : null,
    validatedPath: validatedArtifact?.path ?? null,
  };
}

export function createCodeEvidenceModule(database: PostgresDatabase): CodeEvidenceModule {
  return {
    async assess(actor, input) {
      const evidenceId = validateUuid(input.evidenceId, "evidenceId");
      const repositoryKey = validateRepositoryKey(input.repositoryKey);
      const commitOid = validateCommitOid(input.commitOid);
      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const cited = await evidenceById(transaction, actor.workspaceId, evidenceId);
          if (!cited) {
            throw new CodeEvidenceAccessDeniedError("Code Evidence is not visible to this Actor");
          }
          return assessEvidenceInTransaction(
            transaction,
            actor.workspaceId,
            evidenceId,
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

    async cite(actor, input) {
      const memoryId = validateUuid(input.memoryId, "memoryId");
      const artifactId = validateUuid(input.artifactId, "artifactId");
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
      const memoryId = validateUuid(input.memoryId, "memoryId");
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
      const evidenceId = validateUuid(input.evidenceId, "evidenceId");
      const repositoryKey = validateRepositoryKey(input.repositoryKey);
      const commitOid = validateCommitOid(input.commitOid);
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
            evidenceId,
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
