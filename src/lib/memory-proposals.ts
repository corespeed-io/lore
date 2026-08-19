import type { PostgresDatabase, PostgresTransaction } from "@corespeed/lore-core";
import {
  type ActorContext,
  beginMutation,
  completeMutation,
  createMemoryMutationPrimitives,
  type IdempotencyRequest,
  installActorContext,
  isPostgresAccessDenied,
  type Memory,
  type MemoryMutationPrimitivesOptions,
  type MemoryRow,
  type MemoryScope,
  MemoryVersionConflictError,
  memoryFromRow,
  prepareMemoryContent,
  serializedTimestamp,
  type UpdateMemory,
} from "@corespeed/lore-core";
import type { CodeEvidenceRelationship } from "./code-evidence";

/**
 * Memory Proposals: owner-private review state for suggested create/update
 * operations. A write-authorized Actor may submit complete proposed content
 * plus bounded Memory/Observation/Code evidence, but only the owner human may
 * accept or reject. This is a lore oss product module layered on the Memory
 * kernel's mutation primitives; it is deliberately not part of the reusable
 * memory engine.
 */

export class MemoryProposalAccessDeniedError extends Error {
  override name = "MemoryProposalAccessDeniedError";
  readonly status = 403;
}

export class MemoryProposalReviewConflictError extends Error {
  override name = "MemoryProposalReviewConflictError";
  readonly status = 409;
}

export class MemoryProposalCapacityError extends Error {
  override name = "MemoryProposalCapacityError";
  readonly status = 409;
}

export type MemoryProposalKind = "create" | "update";
export type MemoryProposalStatus = "pending" | "accepted" | "rejected";

export interface MemoryProposalCodeEvidence {
  ordinal: number;
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
}

export interface ProposeMemoryCodeEvidence {
  artifactId: string;
  relationship: CodeEvidenceRelationship;
}

export interface MemoryProposal {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  proposedByActorKind: "agent" | "human";
  proposedByAgentId: string | null;
  kind: MemoryProposalKind;
  targetMemoryId: string | null;
  baseMemoryVersion: number | null;
  proposedContent: string;
  proposedScope: MemoryScope;
  proposedMetadata: Record<string, unknown>;
  evidenceMemoryIds: string[];
  evidenceObservationIds: string[];
  codeEvidence: MemoryProposalCodeEvidence[];
  status: MemoryProposalStatus;
  reviewedByUserId: string | null;
  acceptedMemoryId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

interface ProposedMemoryBase {
  evidenceMemoryIds?: readonly string[];
  evidenceObservationIds?: readonly string[];
  codeEvidence?: readonly ProposeMemoryCodeEvidence[];
}

export interface ProposeMemoryCreate extends ProposedMemoryBase {
  kind: "create";
  content: string;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface ProposeMemoryUpdate extends ProposedMemoryBase, UpdateMemory {
  kind: "update";
  targetMemoryId: string;
  expectedVersion: number;
}

export type ProposeMemory = ProposeMemoryCreate | ProposeMemoryUpdate;

export interface ListMemoryProposals {
  limit?: number;
  status?: MemoryProposalStatus;
}

export interface MemoryProposalReviewResult {
  memory: Memory | null;
  proposal: MemoryProposal;
}

export interface MemoryProposalMutationOptions {
  idempotency?: IdempotencyRequest;
}

export type MemoryProposalsModuleOptions = MemoryMutationPrimitivesOptions;

interface MemoryProposalRow {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  proposed_by_actor_kind: "agent" | "human";
  proposed_by_agent_id: string | null;
  kind: MemoryProposalKind;
  target_memory_id: string | null;
  base_memory_version: number | null;
  proposed_content: string;
  proposed_scope: MemoryScope;
  proposed_metadata: Record<string, unknown>;
  changes_content: boolean;
  changes_scope: boolean;
  changes_metadata: boolean;
  status: MemoryProposalStatus;
  reviewed_by_user_id: string | null;
  accepted_memory_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface MemoryProposalEvidenceRow {
  memory_id: string;
  proposal_id: string;
}

interface MemoryProposalObservationEvidenceRow {
  observation_id: string;
  proposal_id: string;
}

interface MemoryProposalCodeEvidenceRow {
  proposal_id: string;
  ordinal: number;
  repository_id: string;
  cited_revision_id: string;
  cited_generation_id: string;
  cited_artifact_id: string;
  cited_commit_oid: string;
  relationship: CodeEvidenceRelationship;
  cited_path: string;
  cited_symbol_key: string | null;
  cited_declaration_key: string | null;
  cited_declaration_chunk_ordinal: number | null;
  cited_declaration_context_sha256: string | null;
  cited_content_sha256: string;
}

function toMemoryProposal(
  row: MemoryProposalRow,
  evidenceMemoryIds: readonly string[] = [],
  evidenceObservationIds: readonly string[] = [],
  codeEvidence: readonly MemoryProposalCodeEvidence[] = [],
): MemoryProposal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    proposedByActorKind: row.proposed_by_actor_kind,
    proposedByAgentId: row.proposed_by_agent_id,
    kind: row.kind,
    targetMemoryId: row.target_memory_id,
    baseMemoryVersion: row.base_memory_version,
    proposedContent: row.proposed_content,
    proposedScope: row.proposed_scope,
    proposedMetadata: row.proposed_metadata,
    evidenceMemoryIds: [...evidenceMemoryIds],
    evidenceObservationIds: [...evidenceObservationIds],
    codeEvidence: [...codeEvidence],
    status: row.status,
    reviewedByUserId: row.reviewed_by_user_id,
    acceptedMemoryId: row.accepted_memory_id,
    createdAt: serializedTimestamp(row.created_at),
    reviewedAt: row.reviewed_at === null ? null : serializedTimestamp(row.reviewed_at),
  };
}

function toMemoryProposalCodeEvidence(
  row: MemoryProposalCodeEvidenceRow,
): MemoryProposalCodeEvidence {
  return {
    ordinal: row.ordinal,
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
  };
}

export function createMemoryProposalsModule(
  database: PostgresDatabase,
  options: MemoryProposalsModuleOptions = {},
) {
  const { insertMemoryInTransaction, notifyMaintenance, updateMemoryInTransaction } =
    createMemoryMutationPrimitives(options);

  async function proposalEvidenceIds(
    transaction: PostgresTransaction,
    proposalId: string,
  ): Promise<{
    memoryIds: string[];
    observationIds: string[];
    codeEvidence: MemoryProposalCodeEvidence[];
  }> {
    const memoryEvidence = await transaction.query<MemoryProposalEvidenceRow>(
      `SELECT proposal_id, memory_id
       FROM memory_proposal_evidence
       WHERE proposal_id = $1
       ORDER BY ordinal`,
      [proposalId],
    );
    const observationEvidence = await transaction.query<MemoryProposalObservationEvidenceRow>(
      `SELECT proposal_id, observation_reference_id AS observation_id
       FROM memory_proposal_observation_evidence
       WHERE proposal_id = $1
       ORDER BY ordinal`,
      [proposalId],
    );
    const codeEvidence = await transaction.query<MemoryProposalCodeEvidenceRow>(
      `SELECT proposal_id, ordinal, repository_id, cited_revision_id,
         cited_generation_id, cited_artifact_id, cited_commit_oid, relationship,
         cited_path, cited_symbol_key, cited_declaration_key,
         cited_declaration_chunk_ordinal, cited_declaration_context_sha256,
         cited_content_sha256
       FROM memory_proposal_code_evidence
       WHERE proposal_id = $1
       ORDER BY ordinal`,
      [proposalId],
    );
    return {
      memoryIds: memoryEvidence.rows.map((row) => row.memory_id),
      observationIds: observationEvidence.rows.map((row) => row.observation_id),
      codeEvidence: codeEvidence.rows.map(toMemoryProposalCodeEvidence),
    };
  }

  async function proposalFromRow(
    transaction: PostgresTransaction,
    row: MemoryProposalRow,
  ): Promise<MemoryProposal> {
    const evidence = await proposalEvidenceIds(transaction, row.id);
    return toMemoryProposal(
      row,
      evidence.memoryIds,
      evidence.observationIds,
      evidence.codeEvidence,
    );
  }

  async function proposalsFromRows(
    transaction: PostgresTransaction,
    rows: readonly MemoryProposalRow[],
  ): Promise<MemoryProposal[]> {
    if (!rows.length) return [];
    const memoryEvidence = await transaction.query<MemoryProposalEvidenceRow>(
      `SELECT proposal_id, memory_id
       FROM memory_proposal_evidence
       WHERE proposal_id = ANY($1::uuid[])
       ORDER BY proposal_id, ordinal`,
      [rows.map((row) => row.id)],
    );
    const observationEvidence = await transaction.query<MemoryProposalObservationEvidenceRow>(
      `SELECT proposal_id, observation_reference_id AS observation_id
       FROM memory_proposal_observation_evidence
       WHERE proposal_id = ANY($1::uuid[])
       ORDER BY proposal_id, ordinal`,
      [rows.map((row) => row.id)],
    );
    const codeEvidence = await transaction.query<MemoryProposalCodeEvidenceRow>(
      `SELECT proposal_id, ordinal, repository_id, cited_revision_id,
         cited_generation_id, cited_artifact_id, cited_commit_oid, relationship,
         cited_path, cited_symbol_key, cited_declaration_key,
         cited_declaration_chunk_ordinal, cited_declaration_context_sha256,
         cited_content_sha256
       FROM memory_proposal_code_evidence
       WHERE proposal_id = ANY($1::uuid[])
       ORDER BY proposal_id, ordinal`,
      [rows.map((row) => row.id)],
    );
    const memoriesByProposal = new Map<string, string[]>();
    for (const row of memoryEvidence.rows) {
      const ids = memoriesByProposal.get(row.proposal_id) ?? [];
      ids.push(row.memory_id);
      memoriesByProposal.set(row.proposal_id, ids);
    }
    const observationsByProposal = new Map<string, string[]>();
    for (const row of observationEvidence.rows) {
      const ids = observationsByProposal.get(row.proposal_id) ?? [];
      ids.push(row.observation_id);
      observationsByProposal.set(row.proposal_id, ids);
    }
    const codeByProposal = new Map<string, MemoryProposalCodeEvidence[]>();
    for (const row of codeEvidence.rows) {
      const evidence = codeByProposal.get(row.proposal_id) ?? [];
      evidence.push(toMemoryProposalCodeEvidence(row));
      codeByProposal.set(row.proposal_id, evidence);
    }
    return rows.map((row) =>
      toMemoryProposal(
        row,
        memoriesByProposal.get(row.id) ?? [],
        observationsByProposal.get(row.id) ?? [],
        codeByProposal.get(row.id) ?? [],
      ),
    );
  }

  return {
    async propose(
      actor: ActorContext,
      input: ProposeMemory,
      options: MemoryProposalMutationOptions = {},
    ): Promise<MemoryProposal> {
      const evidenceMemoryIds = [...new Set(input.evidenceMemoryIds ?? [])];
      const evidenceObservationIds = [...new Set(input.evidenceObservationIds ?? [])];
      const codeEvidence = [
        ...new Map(
          (input.codeEvidence ?? []).map((evidence) => [
            `${evidence.artifactId}\0${evidence.relationship}`,
            evidence,
          ]),
        ).values(),
      ];
      if (
        codeEvidence.some(
          (evidence) =>
            !["supports", "contradicts", "implements", "rationale"].includes(evidence.relationship),
        )
      ) {
        throw new TypeError("Proposal Code Evidence relationship is invalid");
      }
      if (evidenceMemoryIds.length + evidenceObservationIds.length + codeEvidence.length > 50) {
        throw new TypeError("A Memory Proposal may cite at most 50 evidence records");
      }
      if (
        input.kind === "update" &&
        input.content === undefined &&
        input.scope === undefined &&
        input.metadata === undefined
      ) {
        throw new TypeError("An update proposal must change content, scope, or metadata");
      }

      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const claim = await beginMutation<{ proposal: MemoryProposal }>(
            transaction,
            actor,
            options.idempotency,
          );
          if (claim.replay) return claim.replay.body.proposal;
          const access = await transaction.query<{ allowed: boolean }>(
            "SELECT lore.can_write_memory($1, $2) AS allowed",
            [actor.workspaceId, actor.userId],
          );
          if (access.rows[0]?.allowed !== true) {
            throw new MemoryProposalAccessDeniedError(
              "Actor cannot propose Memory changes in this Workspace",
            );
          }

          let kind: MemoryProposalKind;
          let targetMemoryId: string | null;
          let baseMemoryVersion: number | null;
          let proposedContent: string;
          let proposedScope: MemoryScope;
          let proposedMetadata: Record<string, unknown>;
          let changesContent: boolean;
          let changesScope: boolean;
          let changesMetadata: boolean;

          if (input.kind === "create") {
            kind = "create";
            targetMemoryId = null;
            baseMemoryVersion = null;
            proposedContent = input.content;
            proposedScope = input.scope ?? "shared";
            proposedMetadata = input.metadata ?? {};
            changesContent = true;
            changesScope = true;
            changesMetadata = true;
          } else {
            const target = await transaction.query<MemoryRow>(
              `SELECT *
               FROM memories
               WHERE id = $1
                 AND workspace_id = $2
                 AND lore.can_write_memory(workspace_id, owner_user_id)`,
              [input.targetMemoryId, actor.workspaceId],
            );
            const current = target.rows[0];
            if (!current) {
              throw new MemoryProposalAccessDeniedError(
                "Actor cannot propose a change to this Memory",
              );
            }
            if (current.version !== input.expectedVersion) {
              throw new MemoryVersionConflictError(input.expectedVersion, current.version);
            }
            kind = "update";
            targetMemoryId = current.id;
            baseMemoryVersion = current.version;
            proposedContent = input.content ?? current.content;
            proposedScope = input.scope ?? current.scope;
            proposedMetadata = input.metadata ?? current.metadata;
            changesContent = input.content !== undefined;
            changesScope = input.scope !== undefined;
            changesMetadata = input.metadata !== undefined;
          }

          if (changesContent) prepareMemoryContent(proposedContent);

          if (evidenceMemoryIds.length) {
            const visibleEvidence = await transaction.query<{ id: string }>(
              `SELECT id
               FROM memories
               WHERE workspace_id = $1
                 AND id = ANY($2::uuid[])`,
              [actor.workspaceId, evidenceMemoryIds],
            );
            const visibleIds = new Set(visibleEvidence.rows.map((row) => row.id));
            if (evidenceMemoryIds.some((id) => !visibleIds.has(id))) {
              throw new MemoryProposalAccessDeniedError(
                "Proposal evidence must be visible in the current Workspace",
              );
            }
          }

          if (evidenceObservationIds.length) {
            const visibleEvidence = await transaction.query<{ id: string }>(
              `SELECT id
               FROM observations
               WHERE workspace_id = $1
                 AND id = ANY($2::uuid[])`,
              [actor.workspaceId, evidenceObservationIds],
            );
            const visibleIds = new Set(visibleEvidence.rows.map((row) => row.id));
            if (evidenceObservationIds.some((id) => !visibleIds.has(id))) {
              throw new MemoryProposalAccessDeniedError(
                "Proposal evidence must be visible in the current Workspace",
              );
            }
          }

          const inserted = await transaction.query<MemoryProposalRow>(
            `SELECT *
             FROM lore.submit_memory_proposal(
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
               $11, $12, $13
             )`,
            [
              actor.workspaceId,
              actor.userId,
              actor.agentId ? "agent" : "human",
              actor.agentId ?? null,
              kind,
              targetMemoryId,
              baseMemoryVersion,
              proposedContent,
              proposedScope,
              JSON.stringify(proposedMetadata),
              changesContent,
              changesScope,
              changesMetadata,
            ],
          );
          const id = inserted.rows[0].id;
          for (const [ordinal, memoryId] of evidenceMemoryIds.entries()) {
            await transaction.query(
              `INSERT INTO memory_proposal_evidence (
                 workspace_id, proposal_id, memory_id, ordinal
               ) VALUES ($1, $2, $3, $4)`,
              [actor.workspaceId, id, memoryId, ordinal],
            );
          }
          for (const [ordinal, observationId] of evidenceObservationIds.entries()) {
            await transaction.query(
              `INSERT INTO memory_proposal_observation_evidence (
                 workspace_id, proposal_id, observation_id, observation_reference_id, ordinal
               ) VALUES ($1, $2, $3, $3, $4)`,
              [actor.workspaceId, id, observationId, ordinal],
            );
          }
          const storedCodeEvidence: MemoryProposalCodeEvidence[] = [];
          for (const [ordinal, requestedEvidence] of codeEvidence.entries()) {
            const visibleArtifact = await transaction.query<MemoryProposalCodeEvidenceRow>(
              `SELECT $1::uuid AS proposal_id, $2::integer AS ordinal,
                 artifact.repository_id, artifact.revision_id AS cited_revision_id,
                 artifact.generation_id AS cited_generation_id,
                 artifact.id AS cited_artifact_id, revision.commit_oid AS cited_commit_oid,
                 $3::code_evidence_relationship AS relationship,
                 artifact.path AS cited_path, artifact.symbol_key AS cited_symbol_key,
                 artifact.declaration_key AS cited_declaration_key,
                 artifact.declaration_chunk_ordinal AS cited_declaration_chunk_ordinal,
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
                 ) END AS cited_declaration_context_sha256,
                 artifact.content_sha256 AS cited_content_sha256
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
               WHERE artifact.workspace_id = $4 AND artifact.id = $5`,
              [
                id,
                ordinal,
                requestedEvidence.relationship,
                actor.workspaceId,
                requestedEvidence.artifactId,
              ],
            );
            const stored = visibleArtifact.rows[0];
            if (!stored) {
              throw new MemoryProposalAccessDeniedError(
                "Proposal Code Evidence must be an active visible Code Artifact",
              );
            }
            await transaction.query(
              `INSERT INTO memory_proposal_code_evidence (
                 workspace_id, proposal_id, ordinal, repository_id,
                 cited_revision_id, cited_generation_id, cited_artifact_id,
                 cited_commit_oid, relationship, cited_path, cited_symbol_key,
                 cited_declaration_key, cited_declaration_chunk_ordinal,
                 cited_declaration_context_sha256, cited_content_sha256
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14, $15
               )`,
              [
                actor.workspaceId,
                stored.proposal_id,
                stored.ordinal,
                stored.repository_id,
                stored.cited_revision_id,
                stored.cited_generation_id,
                stored.cited_artifact_id,
                stored.cited_commit_oid,
                stored.relationship,
                stored.cited_path,
                stored.cited_symbol_key,
                stored.cited_declaration_key,
                stored.cited_declaration_chunk_ordinal,
                stored.cited_declaration_context_sha256,
                stored.cited_content_sha256,
              ],
            );
            storedCodeEvidence.push(toMemoryProposalCodeEvidence(stored));
          }
          const proposal = toMemoryProposal(
            inserted.rows[0],
            evidenceMemoryIds,
            evidenceObservationIds,
            storedCodeEvidence,
          );
          await completeMutation(
            transaction,
            claim.requestId,
            201,
            { proposal },
            Boolean(options.idempotency),
          );
          return proposal;
        });
      } catch (error) {
        if (error && typeof error === "object" && (error as { code?: unknown }).code === "54000") {
          throw new MemoryProposalCapacityError(
            "Review a pending Memory Proposal before submitting another",
            { cause: error },
          );
        }
        if (isPostgresAccessDenied(error)) {
          throw new MemoryProposalAccessDeniedError(
            "Actor cannot propose Memory changes in this Workspace",
            { cause: error },
          );
        }
        throw error;
      }
    },

    async listProposals(
      actor: ActorContext,
      input: ListMemoryProposals = {},
    ): Promise<MemoryProposal[]> {
      if (actor.agentId) {
        throw new MemoryProposalAccessDeniedError("Only a human User can review Memory Proposals");
      }
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<MemoryProposalRow>(
          `SELECT *
           FROM memory_proposals
           WHERE workspace_id = $1
             AND owner_user_id = $2
             AND expires_at > now()
             AND ($3::memory_proposal_status IS NULL OR status = $3::memory_proposal_status)
           ORDER BY created_at DESC, id
           LIMIT $4`,
          [actor.workspaceId, actor.userId, input.status ?? null, limit],
        );
        return proposalsFromRows(transaction, result.rows);
      });
    },

    async reviewProposal(
      actor: ActorContext,
      id: string,
      decision: "accept" | "reject",
    ): Promise<MemoryProposalReviewResult | null> {
      if (actor.agentId) {
        throw new MemoryProposalAccessDeniedError("Only a human User can review Memory Proposals");
      }
      try {
        const reviewed = await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const selected = await transaction.query<MemoryProposalRow>(
            `SELECT *
             FROM memory_proposals
             WHERE id = $1
               AND workspace_id = $2
               AND owner_user_id = $3
               AND expires_at > now()
             FOR UPDATE`,
            [id, actor.workspaceId, actor.userId],
          );
          const current = selected.rows[0];
          if (!current) return null;

          if (current.status !== "pending") {
            const repeated =
              (decision === "accept" && current.status === "accepted") ||
              (decision === "reject" && current.status === "rejected");
            if (!repeated) {
              throw new MemoryProposalReviewConflictError(
                `Memory Proposal is already ${current.status}`,
              );
            }
            const accepted = current.accepted_memory_id
              ? await transaction.query<MemoryRow>(
                  "SELECT * FROM memories WHERE id = $1 AND workspace_id = $2",
                  [current.accepted_memory_id, actor.workspaceId],
                )
              : null;
            return {
              proposal: await proposalFromRow(transaction, current),
              memory: accepted?.rows[0] ? memoryFromRow(accepted.rows[0]) : null,
              jobId: null,
              chunksChanged: false,
            };
          }

          if (decision === "reject") {
            const rejected = await transaction.query<MemoryProposalRow>(
              `UPDATE memory_proposals
               SET status = 'rejected',
                   reviewed_by_user_id = $3,
                   reviewed_at = now(),
                   expires_at = now() + interval '30 days'
               WHERE id = $1 AND workspace_id = $2
               RETURNING *`,
              [id, actor.workspaceId, actor.userId],
            );
            return {
              proposal: await proposalFromRow(transaction, rejected.rows[0]),
              memory: null,
              jobId: null,
              chunksChanged: false,
            };
          }

          const evidence = await proposalEvidenceIds(transaction, current.id);
          if (evidence.observationIds.length) {
            const visibleObservations = await transaction.query<{ id: string }>(
              `SELECT lore.lock_reviewable_proposal_observations($1, $2) AS id`,
              [actor.workspaceId, current.id],
            );
            if (visibleObservations.rows.length !== evidence.observationIds.length) {
              throw new MemoryProposalReviewConflictError(
                "Observation evidence is no longer available for review",
              );
            }
          }

          let applied: {
            chunksChanged: boolean;
            jobId: string | null;
            memory: Memory;
          } | null;
          if (current.kind === "create") {
            applied = {
              ...(await insertMemoryInTransaction(
                transaction,
                actor,
                {
                  content: current.proposed_content,
                  scope: current.proposed_scope,
                  metadata: current.proposed_metadata,
                },
                null,
              )),
              chunksChanged: true,
            };
          } else {
            if (current.target_memory_id === null || current.base_memory_version === null) {
              throw new Error("Stored update proposal is missing its target version");
            }
            applied = await updateMemoryInTransaction(
              transaction,
              actor,
              current.target_memory_id,
              {
                ...(current.changes_content ? { content: current.proposed_content } : {}),
                ...(current.changes_scope ? { scope: current.proposed_scope } : {}),
                ...(current.changes_metadata ? { metadata: current.proposed_metadata } : {}),
              },
              current.base_memory_version,
            );
          }
          if (!applied) {
            throw new MemoryProposalAccessDeniedError("The target Memory is no longer writable");
          }
          const accepted = await transaction.query<MemoryProposalRow>(
            `UPDATE memory_proposals
             SET status = 'accepted',
                 reviewed_by_user_id = $3,
                 accepted_memory_id = $4,
                 reviewed_at = now(),
                 expires_at = now() + interval '30 days'
             WHERE id = $1 AND workspace_id = $2
             RETURNING *`,
            [id, actor.workspaceId, actor.userId, applied.memory.id],
          );
          await transaction.query(
            `INSERT INTO memory_code_evidence (
               id, workspace_id, memory_id, repository_id,
               cited_revision_id, cited_generation_id, cited_artifact_id,
               cited_commit_oid, relationship, cited_path, cited_symbol_key,
               cited_declaration_key, cited_declaration_chunk_ordinal,
               cited_declaration_context_sha256, cited_content_sha256, validation_state,
               validated_revision_id, validated_generation_id, validated_artifact_id,
               validated_commit_oid, validated_path, created_by_user_id, created_by_agent_id
             )
             SELECT gen_random_uuid(), evidence.workspace_id, $3, evidence.repository_id,
               evidence.cited_revision_id, evidence.cited_generation_id,
               evidence.cited_artifact_id, evidence.cited_commit_oid,
               evidence.relationship, evidence.cited_path, evidence.cited_symbol_key,
               evidence.cited_declaration_key, evidence.cited_declaration_chunk_ordinal,
               evidence.cited_declaration_context_sha256,
               evidence.cited_content_sha256, 'current',
               evidence.cited_revision_id, evidence.cited_generation_id,
               evidence.cited_artifact_id, evidence.cited_commit_oid,
               evidence.cited_path, $4, NULL
             FROM memory_proposal_code_evidence evidence
             WHERE evidence.workspace_id = $1 AND evidence.proposal_id = $2
             ON CONFLICT (memory_id, cited_artifact_id, relationship) DO NOTHING`,
            [actor.workspaceId, id, applied.memory.id, actor.userId],
          );
          return {
            proposal: await proposalFromRow(transaction, accepted.rows[0]),
            memory: applied.memory,
            jobId: applied.jobId,
            chunksChanged: applied.chunksChanged,
          };
        });
        if (reviewed?.chunksChanged) notifyMaintenance(reviewed.jobId);
        return reviewed ? { proposal: reviewed.proposal, memory: reviewed.memory } : null;
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new MemoryProposalAccessDeniedError("Actor cannot review this Memory Proposal", {
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}
