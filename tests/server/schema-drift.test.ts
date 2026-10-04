import {
  type EmbeddingGenerationReport,
  MEMORY_CHUNK_MAXIMUM_CHARACTERS,
  MEMORY_CONTENT_LIMITS,
  MEMORY_LINK_LIMITS,
  type MemoryScope,
} from "@corespeed/lore-core";
import {
  type EpisodeKind,
  MAX_OBSERVATION_CONTENT_CHARACTERS,
  type ObservationKind,
} from "@corespeed/lore-core/episodes";
import { expect, test } from "vitest";
import type { AgentGrantPermission, AgentGrantStatus, AgentStatus } from "@/modules/agents/service";
import type {
  CodeEvidenceRelationship,
  CodeEvidenceValidationState,
} from "@/modules/code/evidence-contract";
import type { CodeDependencyResolution } from "@/modules/code/graph";
import type { GenerationRow } from "@/modules/code/indexing/storage";
import type {
  CodeDependencyKind,
  CodeIndexJobStatus,
  CodeParserKind,
  CodeParseStatus,
} from "@/modules/code/indexing/types";
import {
  COMMIT_OID_PATTERN,
  REPOSITORY_KEY_MAXIMUM_LENGTH,
  REPOSITORY_PATH_MAXIMUM_LENGTH,
} from "@/modules/code/indexing/validation";
import type { EvaluationRunStatus } from "@/modules/evaluations/service";
import {
  DEPLOYMENT_FEATURES,
  DEPLOYMENT_LIMITS,
  MEMORY_CHUNKING_CAPABILITY,
} from "@/modules/operations/limits";
import { operationsSchemas } from "@/modules/operations/openapi";
import { createOperationsModule } from "@/modules/operations/service";
import {
  MAXIMUM_PENDING_MEMORY_PROPOSALS,
  MEMORY_PROPOSAL_RETENTION_DAYS,
} from "@/modules/proposals/limits";
import type { MemoryProposalKind, MemoryProposalStatus } from "@/modules/proposals/service";
import type { MembershipRole, MembershipStatus } from "@/modules/workspaces/service";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

/**
 * The frozen migrations restate, as SQL enums, CHECK constraints, and the
 * capabilities function, rules the TypeScript enforces. Applied migrations cannot
 * change, so these tests are what keeps the two copies equal: a TypeScript change
 * that the schema does not match fails here and needs a forward migration.
 */

/** Accepts a list of exactly the members of `T`, each at least once, at compile time. */
function members<T extends string>() {
  return <const V extends readonly T[]>(
    values: V & ([T] extends [V[number]] ? unknown : "missing a member of the TypeScript union"),
  ): readonly string[] => values;
}

const TYPESCRIPT_ENUMS: Record<string, readonly string[]> = {
  agent_grant_permission: members<AgentGrantPermission>()(["read", "write"]),
  agent_grant_status: members<AgentGrantStatus>()(["active", "revoked"]),
  agent_status: members<AgentStatus>()(["active", "disabled"]),
  code_dependency_kind: members<CodeDependencyKind>()(["calls", "imports", "references"]),
  code_dependency_resolution: members<CodeDependencyResolution>()([
    "ambiguous",
    "resolved",
    "unresolved",
  ]),
  code_evidence_relationship: members<CodeEvidenceRelationship>()([
    "contradicts",
    "implements",
    "rationale",
    "supports",
  ]),
  code_evidence_validation_state: members<CodeEvidenceValidationState>()([
    "ambiguous",
    "changed",
    "current",
    "deleted",
    "moved",
    "unverifiable",
  ]),
  code_index_generation_status: members<GenerationRow["status"]>()([
    "active",
    "building",
    "failed",
    "ready",
    "retiring",
  ]),
  code_index_job_status: members<CodeIndexJobStatus>()([
    "cancelled",
    "dead",
    "pending",
    "processing",
    "succeeded",
  ]),
  code_parse_status: members<CodeParseStatus>()(["fallback", "parsed", "recovered"]),
  code_parser_kind: members<CodeParserKind>()(["text", "tree_sitter"]),
  embedding_generation_status: members<EmbeddingGenerationReport["status"]>()([
    "active",
    "building",
    "failed",
    "retiring",
  ]),
  episode_kind: members<EpisodeKind>()(["conversation", "document", "event", "workflow"]),
  evaluation_run_status: members<EvaluationRunStatus>()(["completed", "failed", "running"]),
  membership_role: members<MembershipRole>()(["admin", "member", "owner"]),
  membership_status: members<MembershipStatus>()(["active", "suspended"]),
  memory_proposal_kind: members<MemoryProposalKind>()(["create", "update"]),
  memory_proposal_status: members<MemoryProposalStatus>()(["accepted", "pending", "rejected"]),
  memory_scope: members<MemoryScope>()(["private", "shared"]),
  observation_kind: members<ObservationKind>()([
    "document_fragment",
    "event",
    "message",
    "tool_call",
    "tool_result",
  ]),
};

/**
 * Enums no TypeScript union restates. Adding an enum means adding it to exactly one
 * of these two lists.
 */
const SQL_ONLY_ENUMS = ["memory_embedding_job_status"];

async function asAdmin<T>(
  testContext: MemoryTestContext,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return testContext.adminDatabase.transaction(
    async (transaction) => (await transaction.query<T>(sql, params)).rows,
  );
}

async function constraintDefinitions(testContext: MemoryTestContext) {
  const rows = await asAdmin<{ name: string; definition: string }>(
    testContext,
    `SELECT constraint_row.conname AS name, pg_get_constraintdef(constraint_row.oid) AS definition
     FROM pg_constraint constraint_row
     JOIN pg_namespace namespace ON namespace.oid = constraint_row.connamespace
     WHERE namespace.nspname = 'public' AND constraint_row.contype = 'c'`,
  );
  return new Map(rows.map((row) => [row.name, row.definition]));
}

function capture(definition: string | undefined, pattern: RegExp): string {
  const match = definition === undefined ? null : pattern.exec(definition);
  if (!match?.[1]) throw new Error(`${pattern} does not match ${definition}`);
  return match[1];
}

test("every SQL enum matches the TypeScript union that restates it", async () => {
  const testContext = await createMemoryTestContext();
  const rows = await asAdmin<{ name: string; labels: string[] }>(
    testContext,
    `SELECT type_row.typname AS name,
            array_agg(enum_row.enumlabel ORDER BY enum_row.enumlabel) AS labels
     FROM pg_type type_row
     JOIN pg_namespace namespace ON namespace.oid = type_row.typnamespace
     JOIN pg_enum enum_row ON enum_row.enumtypid = type_row.oid
     WHERE namespace.nspname = 'public'
     GROUP BY type_row.typname`,
  );
  const sqlEnums = Object.fromEntries(rows.map((row) => [row.name, row.labels]));

  expect(Object.keys(sqlEnums).sort()).toEqual(
    [...Object.keys(TYPESCRIPT_ENUMS), ...SQL_ONLY_ENUMS].sort(),
  );
  for (const [name, values] of Object.entries(TYPESCRIPT_ENUMS)) {
    expect(sqlEnums[name], name).toEqual([...values].sort());
  }
  await testContext.close();
});

test("CHECK constraints bound what the TypeScript validators bound", async () => {
  const testContext = await createMemoryTestContext();
  const constraints = await constraintDefinitions(testContext);
  const bound = (name: string, column: string) =>
    Number(capture(constraints.get(name), new RegExp(`length\\(${column}\\) <= (\\d+)`)));

  // SQL counts code points; the TypeScript Code validators count UTF-16 units, so an
  // equal number keeps them at least as strict as the schema.
  expect(bound("memories_content_check", "content")).toBe(MEMORY_CONTENT_LIMITS.maximumCharacters);
  expect(bound("memory_proposals_proposed_content_check", "proposed_content")).toBe(
    MEMORY_CONTENT_LIMITS.maximumCharacters,
  );
  expect(bound("memory_chunks_content_check", "content")).toBe(MEMORY_CHUNK_MAXIMUM_CHARACTERS);
  // Workspace import writes Links only after validateMemoryLink, so a looser engine
  // bound would surface as a CHECK violation instead of invalid_archive.
  expect(bound("memory_links_kind_check", "kind")).toBe(MEMORY_LINK_LIMITS.maximumKindLength);
  const weightCheck = /weight >= \((\d+)\)::double precision\) AND \(weight <= \((\d+)\)/.exec(
    constraints.get("memory_links_weight_check") ?? "",
  );
  expect(weightCheck?.slice(1).map(Number)).toEqual([
    MEMORY_LINK_LIMITS.minimumWeight,
    MEMORY_LINK_LIMITS.maximumWeight,
  ]);
  expect(bound("observations_content_check", "content")).toBe(MAX_OBSERVATION_CONTENT_CHARACTERS);
  expect(bound("code_repositories_repository_key_check", "repository_key")).toBe(
    REPOSITORY_KEY_MAXIMUM_LENGTH,
  );
  for (const name of ["code_revision_files_path_check", "code_artifacts_path_check"]) {
    expect(bound(name, "path"), name).toBe(REPOSITORY_PATH_MAXIMUM_LENGTH);
  }

  const oidPattern = COMMIT_OID_PATTERN.source.replaceAll("(?:", "(");
  for (const [name, column] of [
    ["code_revisions_commit_oid_check", "commit_oid"],
    ["code_revision_files_object_oid_check", "object_oid"],
    ["code_index_jobs_commit_oid_check", "commit_oid"],
  ] as const) {
    expect(capture(constraints.get(name), new RegExp(`${column} ~ '([^']+)'`)), name).toBe(
      oidPattern,
    );
  }
  await testContext.close();
});

test("the frozen capabilities function and the published contract equal the enforced limits", async () => {
  const testContext = await createMemoryTestContext();
  const constraints = await constraintDefinitions(testContext);

  // Two limits are enforced only in SQL: the pending-Proposal trigger and the
  // expiry CHECK. Their TypeScript constants must name the same numbers.
  const [pendingTrigger] = await asAdmin<{ definition: string }>(
    testContext,
    "SELECT pg_get_functiondef('lore.validate_memory_proposal_target()'::regprocedure) AS definition",
  );
  expect(Number(capture(pendingTrigger?.definition, /\)\s*>=\s*(\d+)\s*THEN/))).toBe(
    MAXIMUM_PENDING_MEMORY_PROPOSALS,
  );
  const retentionDays = [
    ...(constraints.get("memory_proposals_check2") ?? "").matchAll(/'(\d+) days'::interval/g),
  ].map((match) => Number(match[1]));
  expect(retentionDays.length).toBeGreaterThan(0);
  expect(new Set(retentionDays)).toEqual(new Set([MEMORY_PROPOSAL_RETENTION_DAYS]));

  // The application serves limits from its constants; the baseline's function
  // still restates them for any reader of the SQL, so it must not drift.
  const [frozen] = await asAdmin<{
    capabilities: { features: unknown; limits: unknown; memoryChunking: unknown };
  }>(testContext, "SELECT lore.portable_core_capabilities() AS capabilities");
  expect(frozen?.capabilities.features).toEqual(DEPLOYMENT_FEATURES);
  expect(frozen?.capabilities.limits).toEqual(DEPLOYMENT_LIMITS);
  expect(frozen?.capabilities.memoryChunking).toEqual(MEMORY_CHUNKING_CAPABILITY);

  const capabilities = await createOperationsModule(testContext.database, {
    embeddingConfigured: true,
  }).capabilities();
  expect(capabilities.features).toEqual(DEPLOYMENT_FEATURES);
  expect(capabilities.limits).toEqual(DEPLOYMENT_LIMITS);
  expect(capabilities.memoryChunking).toEqual(MEMORY_CHUNKING_CAPABILITY);

  const published = operationsSchemas.Capabilities.properties.limits;
  expect([...published.required].sort()).toEqual(Object.keys(DEPLOYMENT_LIMITS).sort());
  expect(
    Object.fromEntries(
      Object.entries(published.properties).map(([name, schema]) => [name, schema.const]),
    ),
  ).toEqual(DEPLOYMENT_LIMITS);
  await testContext.close();
});
