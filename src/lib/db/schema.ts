import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const agentGrantPermission = pgEnum("agent_grant_permission", ["read", "write"]);
export const agentGrantStatus = pgEnum("agent_grant_status", ["active", "revoked"]);
export const agentStatus = pgEnum("agent_status", ["active", "disabled"]);
export const embeddingGenerationStatus = pgEnum("embedding_generation_status", [
  "building",
  "active",
  "retiring",
  "failed",
]);
export const episodeKind = pgEnum("episode_kind", [
  "conversation",
  "workflow",
  "document",
  "event",
]);
export const evaluationRunStatus = pgEnum("evaluation_run_status", [
  "running",
  "completed",
  "failed",
]);
export const membershipRole = pgEnum("membership_role", ["owner", "admin", "member"]);
export const membershipStatus = pgEnum("membership_status", ["active", "suspended"]);
export const memoryEmbeddingJobStatus = pgEnum("memory_embedding_job_status", [
  "pending",
  "processing",
  "succeeded",
  "dead",
  "cancelled",
]);
export const memoryProposalKind = pgEnum("memory_proposal_kind", ["create", "update"]);
export const memoryProposalStatus = pgEnum("memory_proposal_status", [
  "pending",
  "accepted",
  "rejected",
]);
export const memoryScope = pgEnum("memory_scope", ["shared", "private"]);
export const observationKind = pgEnum("observation_kind", [
  "message",
  "tool_call",
  "tool_result",
  "document_fragment",
  "event",
]);

export const identities = pgTable(
  "identities",
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    provider: text().notNull(),
    subject: text().notNull(),
    email: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "identities_user_id_fkey",
    }).onDelete("cascade"),
    unique("identities_provider_subject_key").on(table.provider, table.subject),
    pgPolicy("identities_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`(user_id = lore.current_user_id())`,
    }),
    check("identities_provider_check", sql`btrim(provider) <> ''::text`),
    check("identities_subject_check", sql`btrim(subject) <> ''::text`),
  ],
).enableRLS();

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (_table) => [
    pgPolicy("users_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`lore.can_read_user(id)`,
    }),
    check("users_display_name_check", sql`btrim(display_name) <> ''::text`),
  ],
).enableRLS();

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid().primaryKey().notNull(),
    name: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (_table) => [
    pgPolicy("workspaces_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`((id = lore.current_workspace_id()) AND lore.is_active_member(id))`,
    }),
    check("workspaces_name_check", sql`btrim(name) <> ''::text`),
  ],
).enableRLS();

export const memories = pgTable(
  "memories",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    createdByAgentId: uuid("created_by_agent_id"),
    scope: memoryScope().default("shared").notNull(),
    content: text().notNull(),
    metadata: jsonb().default({}).notNull(),
    version: integer().default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("memories_created_by_agent_idx")
      .using("btree", table.createdByAgentId.asc().nullsLast())
      .where(sql`(created_by_agent_id IS NOT NULL)`),
    index("memories_metadata_gin_idx").using(
      "gin",
      table.metadata.asc().nullsLast().op("jsonb_path_ops"),
    ),
    index("memories_owner_updated_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.ownerUserId.asc().nullsLast(),
      table.updatedAt.desc().nullsFirst(),
    ),
    index("memories_workspace_updated_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.updatedAt.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.createdByAgentId],
      foreignColumns: [agents.id],
      name: "memories_created_by_agent_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
      name: "memories_owner_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "memories_workspace_id_fkey",
    }).onDelete("cascade"),
    unique("memories_workspace_id_id_key").on(table.workspaceId, table.id),
    pgPolicy("memories_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`lore.can_write_memory(workspace_id, owner_user_id)`,
    }),
    pgPolicy("memories_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`lore.can_write_memory(workspace_id, owner_user_id)`,
      withCheck: sql`lore.can_write_memory(workspace_id, owner_user_id)`,
    }),
    pgPolicy("memories_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`(lore.can_write_memory(workspace_id, owner_user_id) AND (NOT (created_by_agent_id IS DISTINCT FROM lore.current_agent_id())))`,
    }),
    pgPolicy("memories_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`lore.can_read_memory(workspace_id, owner_user_id, scope)`,
    }),
    check("memories_content_check", sql`btrim(content) <> ''::text`),
    check("memories_metadata_check", sql`jsonb_typeof(metadata) = 'object'::text`),
    check("memories_version_check", sql`version > 0`),
  ],
).enableRLS();

export const agents = pgTable(
  "agents",
  {
    id: uuid().primaryKey().notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    name: text().notNull(),
    status: agentStatus().default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
      name: "agents_owner_user_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("agents_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL))`,
    }),
    pgPolicy("agents_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL))`,
      withCheck: sql`((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL))`,
    }),
    pgPolicy("agents_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL))`,
    }),
    pgPolicy("agents_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL))`,
    }),
    check("agents_name_check", sql`btrim(name) <> ''::text`),
  ],
).enableRLS();

export const memoryLinks = pgTable(
  "memory_links",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceMemoryId: uuid("source_memory_id").notNull(),
    targetMemoryId: uuid("target_memory_id").notNull(),
    kind: text().notNull(),
    weight: real().default(1).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("memory_links_workspace_source_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.sourceMemoryId.asc().nullsLast(),
    ),
    index("memory_links_workspace_target_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.targetMemoryId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "memory_links_workspace_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.sourceMemoryId],
      foreignColumns: [memories.workspaceId, memories.id],
      name: "memory_links_workspace_id_source_memory_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.targetMemoryId],
      foreignColumns: [memories.workspaceId, memories.id],
      name: "memory_links_workspace_id_target_memory_id_fkey",
    }).onDelete("cascade"),
    unique("memory_links_workspace_id_source_memory_id_target_memory_id_key").on(
      table.workspaceId,
      table.sourceMemoryId,
      table.targetMemoryId,
      table.kind,
    ),
    pgPolicy("memory_links_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM memories source
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND lore.can_write_memory(source.workspace_id, source.owner_user_id)))))`,
    }),
    pgPolicy("memory_links_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`(EXISTS ( SELECT 1
   FROM memories source
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND lore.can_write_memory(source.workspace_id, source.owner_user_id))))`,
      withCheck: sql`((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM (memories source
     JOIN memories target ON ((target.workspace_id = source.workspace_id)))
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND (target.id = memory_links.target_memory_id) AND lore.can_write_memory(source.workspace_id, source.owner_user_id) AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope)))))`,
    }),
    pgPolicy("memory_links_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM (memories source
     JOIN memories target ON ((target.workspace_id = source.workspace_id)))
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND (target.id = memory_links.target_memory_id) AND lore.can_write_memory(source.workspace_id, source.owner_user_id) AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope)))))`,
    }),
    pgPolicy("memory_links_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM (memories source
     JOIN memories target ON ((target.workspace_id = source.workspace_id)))
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND (target.id = memory_links.target_memory_id) AND lore.can_read_memory(source.workspace_id, source.owner_user_id, source.scope) AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope)))))`,
    }),
    check("memory_links_check", sql`source_memory_id <> target_memory_id`),
    check("memory_links_kind_check", sql`(btrim(kind) <> ''::text) AND (length(kind) <= 64)`),
    check("memory_links_metadata_check", sql`jsonb_typeof(metadata) = 'object'::text`),
    check(
      "memory_links_weight_check",
      sql`(weight >= (0)::double precision) AND (weight <= (1)::double precision)`,
    ),
  ],
).enableRLS();

export const evaluationSuites = pgTable(
  "evaluation_suites",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    name: text().notNull(),
    version: integer().default(1).notNull(),
    description: text().default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("evaluation_suites_workspace_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.createdByUserId.asc().nullsLast(),
      table.updatedAt.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "evaluation_suites_created_by_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "evaluation_suites_workspace_id_fkey",
    }).onDelete("cascade"),
    unique("evaluation_suites_workspace_id_id_key").on(table.workspaceId, table.id),
    unique("evaluation_suites_workspace_id_id_created_by_user_id_key").on(
      table.workspaceId,
      table.id,
      table.createdByUserId,
    ),
    unique("evaluation_suites_workspace_id_created_by_user_id_name_vers_key").on(
      table.workspaceId,
      table.createdByUserId,
      table.name,
      table.version,
    ),
    pgPolicy("evaluation_suites_all", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`lore.can_manage_evaluations(workspace_id, created_by_user_id)`,
      withCheck: sql`lore.can_manage_evaluations(workspace_id, created_by_user_id)`,
    }),
    check("evaluation_suites_name_check", sql`btrim(name) <> ''::text`),
    check("evaluation_suites_version_check", sql`version > 0`),
  ],
).enableRLS();

export const evaluationCases = pgTable(
  "evaluation_cases",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    suiteId: uuid("suite_id").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    ordinal: integer().notNull(),
    query: text().notNull(),
    expectedMemoryIds: uuid("expected_memory_ids").array().notNull(),
    forbiddenMemoryIds: uuid("forbidden_memory_ids").array().default([""]).notNull(),
    resultLimit: integer("result_limit").default(10).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("evaluation_cases_suite_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.createdByUserId.asc().nullsLast(),
      table.suiteId.asc().nullsLast(),
      table.ordinal.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "evaluation_cases_created_by_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.suiteId, table.createdByUserId],
      foreignColumns: [
        evaluationSuites.workspaceId,
        evaluationSuites.id,
        evaluationSuites.createdByUserId,
      ],
      name: "evaluation_cases_workspace_id_suite_id_created_by_user_id_fkey",
    }).onDelete("cascade"),
    unique("evaluation_cases_workspace_id_id_key").on(table.workspaceId, table.id),
    unique("evaluation_cases_workspace_id_id_created_by_user_id_key").on(
      table.workspaceId,
      table.id,
      table.createdByUserId,
    ),
    unique("evaluation_cases_suite_id_ordinal_key").on(table.suiteId, table.ordinal),
    pgPolicy("evaluation_cases_all", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`lore.can_manage_evaluations(workspace_id, created_by_user_id)`,
      withCheck: sql`lore.can_manage_evaluations(workspace_id, created_by_user_id)`,
    }),
    check("evaluation_cases_expected_memory_ids_check", sql`cardinality(expected_memory_ids) > 0`),
    check("evaluation_cases_ordinal_check", sql`ordinal >= 0`),
    check("evaluation_cases_query_check", sql`btrim(query) <> ''::text`),
    check(
      "evaluation_cases_result_limit_check",
      sql`(result_limit >= 1) AND (result_limit <= 100)`,
    ),
  ],
).enableRLS();

export const memoryChunks = pgTable(
  "memory_chunks",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    ordinal: integer().notNull(),
    content: text().notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple'::regconfig, content)`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    embedding: vector({ dimensions: 1024 }),
    embeddingModel: text("embedding_model"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: "string" }),
    embeddingProvider: text("embedding_provider"),
    embeddingRevision: text("embedding_revision"),
    searchVectorEnglish: tsvector("search_vector_english").generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, content)`,
    ),
    entityAliases: text("entity_aliases")
      .array()
      .generatedAlwaysAs(sql`lore.extract_entity_aliases(content)`),
  },
  (table) => [
    index("memory_chunks_embedding_cosine_idx")
      .using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops"))
      .where(sql`(embedding IS NOT NULL)`),
    index("memory_chunks_entity_aliases_idx").using(
      "gin",
      table.entityAliases.asc().nullsLast().op("array_ops"),
    ),
    index("memory_chunks_search_english_idx").using(
      "gin",
      table.searchVectorEnglish.asc().nullsLast().op("tsvector_ops"),
    ),
    index("memory_chunks_search_idx").using(
      "gin",
      table.searchVector.asc().nullsLast().op("tsvector_ops"),
    ),
    index("memory_chunks_workspace_memory_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.memoryId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.workspaceId, table.memoryId],
      foreignColumns: [memories.workspaceId, memories.id],
      name: "memory_chunks_workspace_id_memory_id_fkey",
    }).onDelete("cascade"),
    unique("memory_chunks_memory_id_ordinal_key").on(table.memoryId, table.ordinal),
    pgPolicy("memory_chunks_maintenance_update", {
      as: "permissive",
      for: "update",
      to: "lore_maintenance",
      using: sql`lore.can_maintain_memory(workspace_id, memory_id)`,
      withCheck: sql`lore.can_maintain_memory(workspace_id, memory_id)`,
    }),
    pgPolicy("memory_chunks_maintenance_select", {
      as: "permissive",
      for: "select",
      to: "lore_maintenance",
      using: sql`lore.can_maintain_memory(workspace_id, memory_id)`,
    }),
    pgPolicy("memory_chunks_delete", {
      as: "permissive",
      for: "delete",
      to: "lore_app",
      using: sql`(EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))`,
    }),
    pgPolicy("memory_chunks_update", {
      as: "permissive",
      for: "update",
      to: "lore_app",
      using: sql`(EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))`,
      withCheck: sql`(EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))`,
    }),
    pgPolicy("memory_chunks_insert", {
      as: "permissive",
      for: "insert",
      to: "lore_app",
      withCheck: sql`(EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))`,
    }),
    pgPolicy("memory_chunks_select", {
      as: "permissive",
      for: "select",
      to: "lore_app",
      using: sql`(EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope))))`,
    }),
    check("memory_chunks_content_check", sql`btrim(content) <> ''::text`),
    check(
      "memory_chunks_embedding_state_check",
      sql`((embedding IS NULL) AND (embedding_provider IS NULL) AND (embedding_model IS NULL) AND (embedding_revision IS NULL) AND (embedded_at IS NULL)) OR ((embedding IS NOT NULL) AND (btrim(embedding_provider) <> ''::text) AND (btrim(embedding_model) <> ''::text) AND (btrim(embedding_revision) <> ''::text) AND (vector_dims(embedding) = 1024) AND (embedded_at IS NOT NULL))`,
    ),
    check("memory_chunks_ordinal_check", sql`ordinal >= 0`),
  ],
).enableRLS();

export const memoryEmbeddingJobs = pgTable(
  "memory_embedding_jobs",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    memoryScope: memoryScope("memory_scope").notNull(),
    memoryVersion: integer("memory_version").notNull(),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingRevision: text("embedding_revision").notNull(),
    status: memoryEmbeddingJobStatus().default("pending").notNull(),
    attemptCount: smallint("attempt_count").default(0).notNull(),
    maxAttempts: smallint("max_attempts").default(8).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    leaseToken: uuid("lease_token"),
    leasedAt: timestamp("leased_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    generationId: uuid("generation_id"),
  },
  (table) => [
    index("memory_embedding_jobs_generation_status_idx").using(
      "btree",
      table.generationId.asc().nullsLast(),
      table.status.asc().nullsLast(),
      table.availableAt.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("memory_embedding_jobs_pending_idx")
      .using(
        "btree",
        table.embeddingProvider.asc().nullsLast(),
        table.embeddingModel.asc().nullsLast(),
        table.embeddingRevision.asc().nullsLast(),
        table.availableAt.asc().nullsLast(),
        table.createdAt.asc().nullsLast(),
        table.id.asc().nullsLast(),
      )
      .where(
        sql`(status = ANY (ARRAY['pending'::memory_embedding_job_status, 'processing'::memory_embedding_job_status]))`,
      ),
    index("memory_embedding_jobs_terminal_completed_idx")
      .using("btree", table.completedAt.asc().nullsLast())
      .where(
        sql`(status = ANY (ARRAY['succeeded'::memory_embedding_job_status, 'dead'::memory_embedding_job_status, 'cancelled'::memory_embedding_job_status]))`,
      ),
    foreignKey({
      columns: [table.generationId],
      foreignColumns: [embeddingGenerations.id],
      name: "memory_embedding_jobs_generation_id_fkey",
    }),
    foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
      name: "memory_embedding_jobs_owner_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.memoryId],
      foreignColumns: [memories.workspaceId, memories.id],
      name: "memory_embedding_jobs_workspace_id_memory_id_fkey",
    }).onDelete("cascade"),
    unique("memory_embedding_jobs_workspace_id_memory_id_memory_version_key").on(
      table.workspaceId,
      table.memoryId,
      table.memoryVersion,
      table.embeddingProvider,
      table.embeddingModel,
      table.embeddingRevision,
    ),
    pgPolicy("memory_embedding_jobs_insert", {
      as: "permissive",
      for: "insert",
      to: "lore_app",
      withCheck: sql`((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.workspace_id = memory_embedding_jobs.workspace_id) AND (memory.id = memory_embedding_jobs.memory_id) AND (memory.owner_user_id = memory_embedding_jobs.owner_user_id) AND (memory.scope = memory_embedding_jobs.memory_scope) AND (memory.version = memory_embedding_jobs.memory_version) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))))`,
    }),
    check("memory_embedding_jobs_attempt_count_check", sql`attempt_count >= 0`),
    check(
      "memory_embedding_jobs_check",
      sql`((status = 'pending'::memory_embedding_job_status) AND (lease_token IS NULL) AND (leased_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'processing'::memory_embedding_job_status) AND (lease_token IS NOT NULL) AND (leased_at IS NOT NULL) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::memory_embedding_job_status, 'dead'::memory_embedding_job_status, 'cancelled'::memory_embedding_job_status])) AND (lease_token IS NULL) AND (leased_at IS NULL) AND (completed_at IS NOT NULL))`,
    ),
    check("memory_embedding_jobs_embedding_model_check", sql`btrim(embedding_model) <> ''::text`),
    check(
      "memory_embedding_jobs_embedding_provider_check",
      sql`btrim(embedding_provider) <> ''::text`,
    ),
    check(
      "memory_embedding_jobs_embedding_revision_check",
      sql`btrim(embedding_revision) <> ''::text`,
    ),
    check(
      "memory_embedding_jobs_last_error_check",
      sql`(last_error IS NULL) OR (length(last_error) <= 1000)`,
    ),
    check(
      "memory_embedding_jobs_max_attempts_check",
      sql`(max_attempts >= 1) AND (max_attempts <= 32)`,
    ),
    check("memory_embedding_jobs_memory_version_check", sql`memory_version > 0`),
  ],
).enableRLS();

export const evaluationRuns = pgTable(
  "evaluation_runs",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    suiteId: uuid("suite_id").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    status: evaluationRunStatus().default("running").notNull(),
    metrics: jsonb(),
    error: text(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("evaluation_runs_suite_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.createdByUserId.asc().nullsLast(),
      table.suiteId.asc().nullsLast(),
      table.startedAt.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "evaluation_runs_created_by_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.suiteId, table.createdByUserId],
      foreignColumns: [
        evaluationSuites.workspaceId,
        evaluationSuites.id,
        evaluationSuites.createdByUserId,
      ],
      name: "evaluation_runs_workspace_id_suite_id_created_by_user_id_fkey",
    }).onDelete("cascade"),
    unique("evaluation_runs_workspace_id_id_key").on(table.workspaceId, table.id),
    unique("evaluation_runs_workspace_id_id_created_by_user_id_key").on(
      table.workspaceId,
      table.id,
      table.createdByUserId,
    ),
    pgPolicy("evaluation_runs_all", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`lore.can_manage_evaluations(workspace_id, created_by_user_id)`,
      withCheck: sql`lore.can_manage_evaluations(workspace_id, created_by_user_id)`,
    }),
    check(
      "evaluation_runs_check",
      sql`((status = 'running'::evaluation_run_status) AND (completed_at IS NULL)) OR ((status <> 'running'::evaluation_run_status) AND (completed_at IS NOT NULL))`,
    ),
  ],
).enableRLS();

export const evaluationResults = pgTable(
  "evaluation_results",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    caseId: uuid("case_id").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    retrievedMemoryIds: uuid("retrieved_memory_ids").array().notNull(),
    metrics: jsonb().notNull(),
    latencyMs: doublePrecision("latency_ms").notNull(),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 16, scale: 8 })
      .default("0")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "evaluation_results_created_by_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.caseId, table.createdByUserId],
      foreignColumns: [
        evaluationCases.workspaceId,
        evaluationCases.id,
        evaluationCases.createdByUserId,
      ],
      name: "evaluation_results_workspace_id_case_id_created_by_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.runId, table.createdByUserId],
      foreignColumns: [
        evaluationRuns.workspaceId,
        evaluationRuns.id,
        evaluationRuns.createdByUserId,
      ],
      name: "evaluation_results_workspace_id_run_id_created_by_user_id_fkey",
    }).onDelete("cascade"),
    unique("evaluation_results_run_id_case_id_key").on(table.runId, table.caseId),
    pgPolicy("evaluation_results_all", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`lore.can_manage_evaluations(workspace_id, created_by_user_id)`,
      withCheck: sql`lore.can_manage_evaluations(workspace_id, created_by_user_id)`,
    }),
    check("evaluation_results_estimated_cost_usd_check", sql`estimated_cost_usd >= (0)::numeric`),
    check("evaluation_results_latency_ms_check", sql`latency_ms >= (0)::double precision`),
    check("evaluation_results_metrics_check", sql`jsonb_typeof(metrics) = 'object'::text`),
  ],
).enableRLS();

export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid().primaryKey().notNull(),
    agentId: uuid("agent_id").notNull(),
    secretPrefix: text("secret_prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      name: "agent_credentials_agent_id_fkey",
    }).onDelete("cascade"),
    unique("agent_credentials_secret_hash_key").on(table.secretHash),
    pgPolicy("agent_credentials_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`(lore.agent_owned_by_current_user(agent_id) AND (lore.current_agent_id() IS NULL))`,
      withCheck: sql`(lore.agent_owned_by_current_user(agent_id) AND (lore.current_agent_id() IS NULL))`,
    }),
    pgPolicy("agent_credentials_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`(lore.agent_owned_by_current_user(agent_id) AND (lore.current_agent_id() IS NULL))`,
    }),
    pgPolicy("agent_credentials_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`(lore.agent_owned_by_current_user(agent_id) AND (lore.current_agent_id() IS NULL))`,
    }),
    check("agent_credentials_secret_hash_check", sql`length(secret_hash) = 64`),
    check(
      "agent_credentials_secret_prefix_check",
      sql`(length(secret_prefix) >= 8) AND (length(secret_prefix) <= 32)`,
    ),
  ],
).enableRLS();

export const loreSystemState = pgTable(
  "lore_system_state",
  {
    singleton: boolean().default(true).primaryKey().notNull(),
    deploymentId: uuid("deployment_id").defaultRandom().notNull(),
    schemaRevision: integer("schema_revision").notNull(),
    apiVersion: text("api_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (_table) => [
    check("lore_system_state_api_version_check", sql`btrim(api_version) <> ''::text`),
    check("lore_system_state_schema_revision_check", sql`schema_revision > 0`),
    check("lore_system_state_singleton_check", sql`CHECK (singleton)`),
  ],
);

export const requestIdempotencyRecords = pgTable(
  "request_idempotency_records",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: uuid("actor_id").notNull(),
    operation: text().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestSha256: text("request_sha256").notNull(),
    status: text().default("in_progress").notNull(),
    responseStatus: smallint("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" })
      .default(sql`(now() + '24:00:00'::interval)`)
      .notNull(),
  },
  (table) => [
    index("request_idempotency_records_expiry_idx").using(
      "btree",
      table.expiresAt.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.actorUserId],
      foreignColumns: [users.id],
      name: "request_idempotency_records_actor_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "request_idempotency_records_workspace_id_fkey",
    }).onDelete("cascade"),
    unique("request_idempotency_records_workspace_id_actor_kind_actor_i_key").on(
      table.workspaceId,
      table.actorKind,
      table.actorId,
      table.operation,
      table.idempotencyKey,
    ),
    pgPolicy("request_idempotency_records_all", {
      as: "permissive",
      for: "all",
      to: "lore_app",
      using: sql`((workspace_id = lore.current_workspace_id()) AND (actor_user_id = lore.current_user_id()) AND (actor_kind =
CASE
    WHEN (lore.current_agent_id() IS NULL) THEN 'user'::text
    ELSE 'agent'::text
END) AND (actor_id = COALESCE(lore.current_agent_id(), lore.current_user_id())))`,
      withCheck: sql`((workspace_id = lore.current_workspace_id()) AND (actor_user_id = lore.current_user_id()) AND (actor_kind =
CASE
    WHEN (lore.current_agent_id() IS NULL) THEN 'user'::text
    ELSE 'agent'::text
END) AND (actor_id = COALESCE(lore.current_agent_id(), lore.current_user_id())))`,
    }),
    check(
      "request_idempotency_records_actor_kind_check",
      sql`actor_kind = ANY (ARRAY['user'::text, 'agent'::text])`,
    ),
    check(
      "request_idempotency_records_check",
      sql`((status = 'in_progress'::text) AND (response_status IS NULL) AND (response_body IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (response_status IS NOT NULL) AND (response_body IS NOT NULL) AND (completed_at IS NOT NULL))`,
    ),
    check(
      "request_idempotency_records_idempotency_key_check",
      sql`(btrim(idempotency_key) <> ''::text) AND (length(idempotency_key) <= 128)`,
    ),
    check(
      "request_idempotency_records_operation_check",
      sql`(btrim(operation) <> ''::text) AND (length(operation) <= 128)`,
    ),
    check(
      "request_idempotency_records_request_sha256_check",
      sql`request_sha256 ~ '^[0-9a-f]{64}$'::text`,
    ),
    check(
      "request_idempotency_records_response_status_check",
      sql`(response_status >= 100) AND (response_status <= 599)`,
    ),
    check(
      "request_idempotency_records_status_check",
      sql`status = ANY (ARRAY['in_progress'::text, 'completed'::text])`,
    ),
  ],
).enableRLS();

export const memoryEvents = pgTable(
  "memory_events",
  {
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    sequence: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({
      name: "memory_events_sequence_seq",
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: "9223372036854775807",
      cache: 1,
    }),
    id: uuid().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    memoryScope: memoryScope("memory_scope").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    sourceMemoryId: uuid("source_memory_id"),
    relatedMemoryId: uuid("related_memory_id"),
    eventType: text("event_type").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorAgentId: uuid("actor_agent_id"),
    requestId: uuid("request_id"),
    beforeVersion: integer("before_version"),
    afterVersion: integer("after_version"),
    changedFields: text("changed_fields").array().default(["RAY"]).notNull(),
    beforeContentSha256: text("before_content_sha256"),
    afterContentSha256: text("after_content_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" })
      .default(sql`(now() + '90 days'::interval)`)
      .notNull(),
  },
  (table) => [
    index("memory_events_expiry_idx").using("btree", table.expiresAt.asc().nullsLast()),
    index("memory_events_workspace_sequence_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.sequence.asc().nullsLast(),
    ),
    unique("memory_events_id_key").on(table.id),
    pgPolicy("memory_events_select", {
      as: "permissive",
      for: "select",
      to: "lore_app",
      using: sql`(((resource_type = 'memory'::text) AND ((EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.workspace_id = memory_events.workspace_id) AND (memory.id = memory_events.resource_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)))) OR ((event_type = 'memory.deleted'::text) AND lore.can_read_memory(workspace_id, owner_user_id, memory_scope)))) OR ((resource_type = 'memory_link'::text) AND (EXISTS ( SELECT 1
   FROM (memories source_memory
     JOIN memories target_memory ON (((target_memory.workspace_id = source_memory.workspace_id) AND (target_memory.id = memory_events.related_memory_id))))
  WHERE ((source_memory.workspace_id = memory_events.workspace_id) AND (source_memory.id = memory_events.source_memory_id) AND lore.can_read_memory(source_memory.workspace_id, source_memory.owner_user_id, source_memory.scope) AND lore.can_read_memory(target_memory.workspace_id, target_memory.owner_user_id, target_memory.scope))))))`,
    }),
    check(
      "memory_events_after_content_sha256_check",
      sql`(after_content_sha256 IS NULL) OR (after_content_sha256 ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      "memory_events_before_content_sha256_check",
      sql`(before_content_sha256 IS NULL) OR (before_content_sha256 ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      "memory_events_check",
      sql`((resource_type = 'memory'::text) AND (source_memory_id IS NULL) AND (related_memory_id IS NULL)) OR ((resource_type = 'memory_link'::text) AND (source_memory_id IS NOT NULL) AND (related_memory_id IS NOT NULL))`,
    ),
    check(
      "memory_events_event_type_check",
      sql`event_type = ANY (ARRAY['memory.created'::text, 'memory.updated'::text, 'memory.deleted'::text, 'memory_link.created'::text, 'memory_link.updated'::text, 'memory_link.deleted'::text])`,
    ),
    check(
      "memory_events_resource_type_check",
      sql`resource_type = ANY (ARRAY['memory'::text, 'memory_link'::text])`,
    ),
  ],
).enableRLS();

export const embeddingGenerations = pgTable(
  "embedding_generations",
  {
    id: uuid().primaryKey().notNull(),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimensions: integer("embedding_dimensions").notNull(),
    embeddingRevision: text("embedding_revision").notNull(),
    status: embeddingGenerationStatus().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true, mode: "string" }),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "string" }),
    validatedAt: timestamp("validated_at", { withTimezone: true, mode: "string" }),
    failureDetail: text("failure_detail"),
  },
  (table) => [
    uniqueIndex("embedding_generations_one_active_idx")
      .using("btree", table.status.asc().nullsLast())
      .where(sql`(status = 'active'::embedding_generation_status)`),
    unique("embedding_generations_embedding_provider_embedding_model_em_key").on(
      table.embeddingProvider,
      table.embeddingModel,
      table.embeddingDimensions,
      table.embeddingRevision,
    ),
    pgPolicy("embedding_generations_select", {
      as: "permissive",
      for: "select",
      to: "lore_app",
      using: sql`(status = ANY (ARRAY['active'::embedding_generation_status, 'retiring'::embedding_generation_status]))`,
    }),
    check(
      "embedding_generations_check",
      sql`((status = 'active'::embedding_generation_status) AND (activated_at IS NOT NULL) AND (retired_at IS NULL)) OR ((status = 'retiring'::embedding_generation_status) AND (activated_at IS NOT NULL) AND (retired_at IS NOT NULL)) OR ((status = ANY (ARRAY['building'::embedding_generation_status, 'failed'::embedding_generation_status])) AND (activated_at IS NULL))`,
    ),
    check("embedding_generations_embedding_dimensions_check", sql`embedding_dimensions = 1024`),
    check("embedding_generations_embedding_model_check", sql`btrim(embedding_model) <> ''::text`),
    check(
      "embedding_generations_embedding_provider_check",
      sql`btrim(embedding_provider) <> ''::text`,
    ),
    check(
      "embedding_generations_embedding_revision_check",
      sql`btrim(embedding_revision) <> ''::text`,
    ),
    check(
      "embedding_generations_failure_detail_check",
      sql`(failure_detail IS NULL) OR (length(failure_detail) <= 1000)`,
    ),
  ],
).enableRLS();

export const workspaceImports = pgTable(
  "workspace_imports",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    importedByUserId: uuid("imported_by_user_id").notNull(),
    archiveSha256: text("archive_sha256").notNull(),
    sourceDeploymentId: uuid("source_deployment_id").notNull(),
    sourceWorkspaceId: uuid("source_workspace_id").notNull(),
    summary: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.importedByUserId],
      foreignColumns: [users.id],
      name: "workspace_imports_imported_by_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "workspace_imports_workspace_id_fkey",
    }).onDelete("cascade"),
    unique("workspace_imports_workspace_id_imported_by_user_id_archive__key").on(
      table.workspaceId,
      table.importedByUserId,
      table.archiveSha256,
    ),
    pgPolicy("workspace_imports_all", {
      as: "permissive",
      for: "all",
      to: "lore_app",
      using: sql`((workspace_id = lore.current_workspace_id()) AND (imported_by_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id))`,
      withCheck: sql`((workspace_id = lore.current_workspace_id()) AND (imported_by_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id))`,
    }),
    check("workspace_imports_archive_sha256_check", sql`archive_sha256 ~ '^[0-9a-f]{64}$'::text`),
    check("workspace_imports_summary_check", sql`jsonb_typeof(summary) = 'object'::text`),
  ],
).enableRLS();

export const memoryProposals = pgTable(
  "memory_proposals",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    proposedByActorKind: text("proposed_by_actor_kind").notNull(),
    proposedByAgentId: uuid("proposed_by_agent_id"),
    kind: memoryProposalKind().notNull(),
    targetMemoryId: uuid("target_memory_id"),
    baseMemoryVersion: integer("base_memory_version"),
    proposedContent: text("proposed_content").notNull(),
    proposedScope: memoryScope("proposed_scope").notNull(),
    proposedMetadata: jsonb("proposed_metadata").default({}).notNull(),
    changesContent: boolean("changes_content").notNull(),
    changesScope: boolean("changes_scope").notNull(),
    changesMetadata: boolean("changes_metadata").notNull(),
    status: memoryProposalStatus().default("pending").notNull(),
    reviewedByUserId: uuid("reviewed_by_user_id"),
    acceptedMemoryId: uuid("accepted_memory_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" })
      .default(sql`(now() + '30 days'::interval)`)
      .notNull(),
  },
  (table) => [
    index("memory_proposals_expiry_idx").using("btree", table.expiresAt.asc().nullsLast()),
    index("memory_proposals_owner_status_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.ownerUserId.asc().nullsLast(),
      table.status.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
      name: "memory_proposals_owner_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.proposedByAgentId],
      foreignColumns: [agents.id],
      name: "memory_proposals_proposed_by_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.reviewedByUserId],
      foreignColumns: [users.id],
      name: "memory_proposals_reviewed_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "memory_proposals_workspace_id_fkey",
    }).onDelete("cascade"),
    unique("memory_proposals_workspace_id_id_key").on(table.workspaceId, table.id),
    pgPolicy("memory_proposals_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`lore.can_review_memory_proposal(workspace_id, owner_user_id)`,
      withCheck: sql`lore.can_review_memory_proposal(workspace_id, owner_user_id)`,
    }),
    pgPolicy("memory_proposals_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`(lore.can_write_memory(workspace_id, owner_user_id) AND (proposed_by_actor_kind =
CASE
    WHEN (lore.current_agent_id() IS NULL) THEN 'human'::text
    ELSE 'agent'::text
END) AND (NOT (proposed_by_agent_id IS DISTINCT FROM lore.current_agent_id())) AND (status = 'pending'::memory_proposal_status))`,
    }),
    pgPolicy("memory_proposals_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`(lore.can_read_memory_proposal(workspace_id, owner_user_id) AND (expires_at > now()))`,
    }),
    check(
      "memory_proposals_check",
      sql`(proposed_by_actor_kind = 'agent'::text) OR (proposed_by_agent_id IS NULL)`,
    ),
    check(
      "memory_proposals_check1",
      sql`((kind = 'create'::memory_proposal_kind) AND (target_memory_id IS NULL) AND (base_memory_version IS NULL) AND changes_content AND changes_scope AND changes_metadata) OR ((kind = 'update'::memory_proposal_kind) AND (target_memory_id IS NOT NULL) AND (base_memory_version > 0) AND (changes_content OR changes_scope OR changes_metadata))`,
    ),
    check(
      "memory_proposals_check2",
      sql`((status = 'pending'::memory_proposal_status) AND (reviewed_by_user_id IS NULL) AND (accepted_memory_id IS NULL) AND (reviewed_at IS NULL) AND (expires_at = (created_at + '30 days'::interval))) OR ((status = 'accepted'::memory_proposal_status) AND (reviewed_by_user_id IS NOT NULL) AND (accepted_memory_id IS NOT NULL) AND (reviewed_at IS NOT NULL) AND (expires_at = (reviewed_at + '30 days'::interval))) OR ((status = 'rejected'::memory_proposal_status) AND (reviewed_by_user_id IS NOT NULL) AND (accepted_memory_id IS NULL) AND (reviewed_at IS NOT NULL) AND (expires_at = (reviewed_at + '30 days'::interval)))`,
    ),
    check(
      "memory_proposals_proposed_by_actor_kind_check",
      sql`proposed_by_actor_kind = ANY (ARRAY['human'::text, 'agent'::text])`,
    ),
    check("memory_proposals_proposed_content_check", sql`btrim(proposed_content) <> ''::text`),
    check(
      "memory_proposals_proposed_metadata_check",
      sql`jsonb_typeof(proposed_metadata) = 'object'::text`,
    ),
  ],
).enableRLS();

export const episodes = pgTable(
  "episodes",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    recordedByActorKind: text("recorded_by_actor_kind").notNull(),
    recordedByAgentId: uuid("recorded_by_agent_id"),
    kind: episodeKind().notNull(),
    scope: memoryScope().default("private").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("episodes_owner_created_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.ownerUserId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    index("episodes_workspace_created_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [users.id],
      name: "episodes_owner_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.recordedByAgentId],
      foreignColumns: [agents.id],
      name: "episodes_recorded_by_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "episodes_workspace_id_fkey",
    }).onDelete("cascade"),
    unique("episodes_workspace_id_id_key").on(table.workspaceId, table.id),
    pgPolicy("episodes_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`lore.can_write_memory(workspace_id, owner_user_id)`,
    }),
    pgPolicy("episodes_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`lore.can_read_memory(workspace_id, owner_user_id, scope)`,
    }),
    check("episodes_check", sql`ended_at >= started_at`),
    check(
      "episodes_check1",
      sql`(recorded_by_actor_kind = 'agent'::text) OR (recorded_by_agent_id IS NULL)`,
    ),
    check(
      "episodes_recorded_by_actor_kind_check",
      sql`recorded_by_actor_kind = ANY (ARRAY['human'::text, 'agent'::text])`,
    ),
  ],
).enableRLS();

export const observations = pgTable(
  "observations",
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    episodeId: uuid("episode_id").notNull(),
    ordinal: integer().notNull(),
    kind: observationKind().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    content: text().notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("observations_episode_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.episodeId.asc().nullsLast(),
      table.ordinal.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.workspaceId, table.episodeId],
      foreignColumns: [episodes.workspaceId, episodes.id],
      name: "observations_workspace_id_episode_id_fkey",
    }).onDelete("cascade"),
    unique("observations_workspace_id_id_key").on(table.workspaceId, table.id),
    unique("observations_episode_id_ordinal_key").on(table.episodeId, table.ordinal),
    pgPolicy("observations_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`(EXISTS ( SELECT 1
   FROM episodes episode
  WHERE ((episode.id = observations.episode_id) AND (episode.workspace_id = observations.workspace_id))))`,
    }),
    check(
      "observations_content_check",
      sql`(btrim(content) <> ''::text) AND (length(content) <= 100000)`,
    ),
    check("observations_metadata_check", sql`jsonb_typeof(metadata) = 'object'::text`),
    check("observations_ordinal_check", sql`ordinal >= 0`),
    check("observations_payload_sha256_check", sql`payload_sha256 ~ '^[0-9a-f]{64}$'::text`),
  ],
).enableRLS();

export const memoryProposalEvidence = pgTable(
  "memory_proposal_evidence",
  {
    workspaceId: uuid("workspace_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    ordinal: integer().notNull(),
  },
  (table) => [
    index("memory_proposal_evidence_memory_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.memoryId.asc().nullsLast(),
      table.proposalId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.workspaceId, table.memoryId],
      foreignColumns: [memories.workspaceId, memories.id],
      name: "memory_proposal_evidence_workspace_id_memory_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.proposalId],
      foreignColumns: [memoryProposals.workspaceId, memoryProposals.id],
      name: "memory_proposal_evidence_workspace_id_proposal_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.proposalId, table.memoryId],
      name: "memory_proposal_evidence_pkey",
    }),
    unique("memory_proposal_evidence_proposal_id_ordinal_key").on(table.proposalId, table.ordinal),
    pgPolicy("memory_proposal_evidence_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`(lore.can_append_memory_proposal_evidence(workspace_id, proposal_id) AND (EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.id = memory_proposal_evidence.memory_id) AND (memory.workspace_id = memory_proposal_evidence.workspace_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)))))`,
    }),
    pgPolicy("memory_proposal_evidence_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`((EXISTS ( SELECT 1
   FROM memory_proposals proposal
  WHERE ((proposal.id = memory_proposal_evidence.proposal_id) AND (proposal.workspace_id = memory_proposal_evidence.workspace_id)))) AND (EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.id = memory_proposal_evidence.memory_id) AND (memory.workspace_id = memory_proposal_evidence.workspace_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)))))`,
    }),
    check("memory_proposal_evidence_ordinal_check", sql`ordinal >= 0`),
  ],
).enableRLS();

export const memoryProposalObservationEvidence = pgTable(
  "memory_proposal_observation_evidence",
  {
    workspaceId: uuid("workspace_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    observationId: uuid("observation_id"),
    observationReferenceId: uuid("observation_reference_id").notNull(),
    ordinal: integer().notNull(),
  },
  (table) => [
    index("memory_proposal_observation_evidence_observation_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.observationId.asc().nullsLast(),
      table.proposalId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.workspaceId, table.proposalId],
      foreignColumns: [memoryProposals.workspaceId, memoryProposals.id],
      name: "memory_proposal_observation_evide_workspace_id_proposal_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.observationId],
      foreignColumns: [observations.id],
      name: "memory_proposal_observation_evidence_observation_id_fkey",
    }).onDelete("set null"),
    primaryKey({
      columns: [table.proposalId, table.observationReferenceId],
      name: "memory_proposal_observation_evidence_pkey",
    }),
    unique("memory_proposal_observation_evidence_proposal_id_ordinal_key").on(
      table.proposalId,
      table.ordinal,
    ),
    pgPolicy("memory_proposal_observation_evidence_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`(lore.can_append_memory_proposal_evidence(workspace_id, proposal_id) AND (observation_id = observation_reference_id) AND (EXISTS ( SELECT 1
   FROM observations observation
  WHERE ((observation.id = memory_proposal_observation_evidence.observation_id) AND (observation.workspace_id = memory_proposal_observation_evidence.workspace_id)))))`,
    }),
    pgPolicy("memory_proposal_observation_evidence_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`(EXISTS ( SELECT 1
   FROM memory_proposals proposal
  WHERE ((proposal.id = memory_proposal_observation_evidence.proposal_id) AND (proposal.workspace_id = memory_proposal_observation_evidence.workspace_id))))`,
    }),
    check(
      "memory_proposal_observation_evidence_check",
      sql`(observation_id IS NULL) OR (observation_id = observation_reference_id)`,
    ),
    check("memory_proposal_observation_evidence_ordinal_check", sql`ordinal >= 0`),
  ],
).enableRLS();

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: membershipRole().default("member").notNull(),
    status: membershipStatus().default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "memberships_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "memberships_workspace_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.workspaceId, table.userId], name: "memberships_pkey" }),
    pgPolicy("memberships_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`lore.can_manage_workspace(workspace_id)`,
    }),
    pgPolicy("memberships_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`lore.can_manage_workspace(workspace_id)`,
      withCheck: sql`lore.can_manage_workspace(workspace_id)`,
    }),
    pgPolicy("memberships_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`lore.can_manage_workspace(workspace_id)`,
    }),
    pgPolicy("memberships_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`((workspace_id = lore.current_workspace_id()) AND lore.is_active_member(workspace_id))`,
    }),
  ],
).enableRLS();

export const agentWorkspaceGrants = pgTable(
  "agent_workspace_grants",
  {
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    permission: agentGrantPermission().default("read").notNull(),
    status: agentGrantStatus().default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      name: "agent_workspace_grants_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "agent_workspace_grants_workspace_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.workspaceId, table.agentId],
      name: "agent_workspace_grants_pkey",
    }),
    pgPolicy("agent_grants_delete", {
      as: "permissive",
      for: "delete",
      to: "public",
      using: sql`((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id) AND lore.agent_owned_by_current_user(agent_id))`,
    }),
    pgPolicy("agent_grants_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id) AND lore.agent_owned_by_current_user(agent_id))`,
      withCheck: sql`((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id) AND lore.agent_owned_by_current_user(agent_id))`,
    }),
    pgPolicy("agent_grants_insert", {
      as: "permissive",
      for: "insert",
      to: "public",
      withCheck: sql`((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id) AND lore.agent_owned_by_current_user(agent_id))`,
    }),
    pgPolicy("agent_grants_select", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.agent_owned_by_current_user(agent_id))`,
    }),
  ],
).enableRLS();

export const memoryChunkEmbeddings = pgTable(
  "memory_chunk_embeddings",
  {
    generationId: uuid("generation_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    chunkId: uuid("chunk_id").notNull(),
    embedding: vector({ dimensions: 1024 }).notNull(),
    embeddedAt: timestamp("embedded_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("memory_chunk_embeddings_cosine_idx")
      .using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops"))
      .with({ m: "16", ef_construction: "64" }),
    index("memory_chunk_embeddings_workspace_memory_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.memoryId.asc().nullsLast(),
      table.generationId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.chunkId],
      foreignColumns: [memoryChunks.id],
      name: "memory_chunk_embeddings_chunk_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.generationId],
      foreignColumns: [embeddingGenerations.id],
      name: "memory_chunk_embeddings_generation_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.memoryId],
      foreignColumns: [memories.workspaceId, memories.id],
      name: "memory_chunk_embeddings_workspace_id_memory_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.generationId, table.chunkId],
      name: "memory_chunk_embeddings_pkey",
    }),
    pgPolicy("memory_chunk_embeddings_maintenance_all", {
      as: "permissive",
      for: "all",
      to: "lore_maintenance",
      using: sql`lore.can_maintain_embedding(generation_id, workspace_id, memory_id)`,
      withCheck: sql`lore.can_maintain_embedding(generation_id, workspace_id, memory_id)`,
    }),
    pgPolicy("memory_chunk_embeddings_delete", {
      as: "permissive",
      for: "delete",
      to: "lore_app",
      using: sql`(EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.workspace_id = memory_chunk_embeddings.workspace_id) AND (memory.id = memory_chunk_embeddings.memory_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))`,
    }),
    pgPolicy("memory_chunk_embeddings_select", {
      as: "permissive",
      for: "select",
      to: "lore_app",
      using: sql`(EXISTS ( SELECT 1
   FROM (embedding_generations generation
     JOIN memories memory ON (((memory.workspace_id = memory_chunk_embeddings.workspace_id) AND (memory.id = memory_chunk_embeddings.memory_id))))
  WHERE ((generation.id = memory_chunk_embeddings.generation_id) AND (generation.status = ANY (ARRAY['active'::embedding_generation_status, 'retiring'::embedding_generation_status])) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope))))`,
    }),
    check("memory_chunk_embeddings_embedding_check", sql`vector_dims(embedding) = 1024`),
  ],
).enableRLS();

export const memoryImportProvenance = pgTable(
  "memory_import_provenance",
  {
    workspaceId: uuid("workspace_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    importId: uuid("import_id").notNull(),
    sourceMemoryId: uuid("source_memory_id").notNull(),
    sourceOwnerUserId: uuid("source_owner_user_id").notNull(),
    sourceCreatedAt: timestamp("source_created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.importId],
      foreignColumns: [workspaceImports.id],
      name: "memory_import_provenance_import_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.memoryId],
      foreignColumns: [memories.workspaceId, memories.id],
      name: "memory_import_provenance_workspace_id_memory_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.workspaceId, table.memoryId],
      name: "memory_import_provenance_pkey",
    }),
    pgPolicy("memory_import_provenance_insert", {
      as: "permissive",
      for: "insert",
      to: "lore_app",
      withCheck: sql`(EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.workspace_id = memory_import_provenance.workspace_id) AND (memory.id = memory_import_provenance.memory_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))`,
    }),
    pgPolicy("memory_import_provenance_select", {
      as: "permissive",
      for: "select",
      to: "lore_app",
      using: sql`(EXISTS ( SELECT 1
   FROM memories memory
  WHERE ((memory.workspace_id = memory_import_provenance.workspace_id) AND (memory.id = memory_import_provenance.memory_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope))))`,
    }),
  ],
).enableRLS();
