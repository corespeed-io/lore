import { type ActorContext, installActorContext } from "./actor-context";
import type { PostgresDatabase, PostgresTransaction } from "./db";
import { canonicalJson, mutationRequestHash } from "./idempotency";
import { chunkMemoryContent } from "./memory-chunking";
import type { MemoryScope } from "./types";

export const WORKSPACE_ARCHIVE_FORMAT = "lore-workspace-v1";
export const MAX_WORKSPACE_ARCHIVE_MEMORIES = 10_000;
export const MAX_WORKSPACE_ARCHIVE_LINKS = 50_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PortabilityValidationError extends Error {
  override name = "PortabilityValidationError";
  readonly status = 400;
}

export class PortabilityAccessDeniedError extends Error {
  override name = "PortabilityAccessDeniedError";
  readonly status = 403;
}

export class WorkspaceExportLimitError extends Error {
  override name = "WorkspaceExportLimitError";
  readonly code = "workspace_export_limit_exceeded";
  readonly status = 409;
}

export interface WorkspaceArchiveMemory {
  id: string;
  ownerUserId: string;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceArchiveLink {
  id: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceArchive {
  manifest: {
    checksum: string;
    exportedAt: string;
    format: typeof WORKSPACE_ARCHIVE_FORMAT;
    memoryCount: number;
    linkCount: number;
    sourceDeploymentId: string;
    sourceWorkspaceId: string;
    visibility: "actor-visible";
  };
  memories: WorkspaceArchiveMemory[];
  links: WorkspaceArchiveLink[];
}

export interface ImportWorkspaceArchive {
  archive: WorkspaceArchive;
  conflictPolicy?: "error" | "remap" | "skip";
  dryRun?: boolean;
  ownerMap: Record<string, string>;
}

export interface WorkspaceImportResult {
  archiveChecksum: string;
  dryRun: boolean;
  importedLinks: number;
  importedMemories: number;
  memoryIdMap: Record<string, string>;
  replayed: boolean;
  skippedMemories: number;
}

interface ExportMemoryRow {
  id: string;
  owner_user_id: string;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ExportLinkRow {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

async function workspaceImportReceipt(
  transaction: PostgresTransaction,
  actor: ActorContext,
  checksum: string,
): Promise<WorkspaceImportResult | null> {
  const replay = await transaction.query<{ summary: WorkspaceImportResult }>(
    `SELECT summary
     FROM workspace_imports
     WHERE workspace_id = $1
       AND imported_by_user_id = $2
       AND archive_sha256 = $3`,
    [actor.workspaceId, actor.userId, checksum],
  );
  return replay.rows[0]?.summary ?? null;
}

function timestamp(value: unknown, name: string): string {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime()))
    throw new PortabilityValidationError(`${name} is invalid`);
  return parsed.toISOString();
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new PortabilityValidationError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function metadata(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PortabilityValidationError(`${name} must be an object`);
  }
  const pending: Array<{ depth: number; path: string; value: unknown }> = [
    { depth: 0, path: name, value },
  ];
  let scheduled = 1;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth > 32) {
      throw new PortabilityValidationError(`${name} exceeds 32 levels`);
    }
    if (typeof current.value === "string" && current.value.includes("\0")) {
      throw new PortabilityValidationError(`${current.path} contains an invalid null character`);
    }
    if (Array.isArray(current.value)) {
      for (const [index, item] of current.value.entries()) {
        scheduled += 1;
        if (scheduled > 10_000) {
          throw new PortabilityValidationError(`${name} exceeds 10000 values`);
        }
        pending.push({ depth: current.depth + 1, path: `${current.path}[${index}]`, value: item });
      }
    } else if (current.value && typeof current.value === "object") {
      for (const [key, item] of Object.entries(current.value)) {
        if (key.includes("\0")) {
          throw new PortabilityValidationError(
            `${current.path} contains an invalid null character`,
          );
        }
        scheduled += 1;
        if (scheduled > 10_000) {
          throw new PortabilityValidationError(`${name} exceeds 10000 values`);
        }
        pending.push({ depth: current.depth + 1, path: `${current.path}.${key}`, value: item });
      }
    }
  }
  if (canonicalJson(value).length > 100_000) {
    throw new PortabilityValidationError(`${name} exceeds 100000 characters`);
  }
  return value as Record<string, unknown>;
}

function archivePayload(archive: WorkspaceArchive): Omit<WorkspaceArchive, "manifest"> & {
  manifest: Omit<WorkspaceArchive["manifest"], "checksum">;
} {
  const { checksum: _checksum, ...manifest } = archive.manifest;
  return { manifest, memories: archive.memories, links: archive.links };
}

async function archiveChecksum(archive: WorkspaceArchive): Promise<string> {
  return mutationRequestHash(archivePayload(archive));
}

function normalizedArchive(archive: WorkspaceArchive): WorkspaceArchive {
  if (!archive || typeof archive !== "object") {
    throw new PortabilityValidationError("archive is required");
  }
  if (archive.manifest?.format !== WORKSPACE_ARCHIVE_FORMAT) {
    throw new PortabilityValidationError(`archive format must be ${WORKSPACE_ARCHIVE_FORMAT}`);
  }
  const sourceDeploymentId = uuid(
    archive.manifest.sourceDeploymentId,
    "manifest.sourceDeploymentId",
  );
  const sourceWorkspaceId = uuid(archive.manifest.sourceWorkspaceId, "manifest.sourceWorkspaceId");
  const exportedAt = timestamp(archive.manifest.exportedAt, "manifest.exportedAt");
  if (!/^[0-9a-f]{64}$/.test(archive.manifest.checksum)) {
    throw new PortabilityValidationError("manifest.checksum must be lowercase SHA-256");
  }
  if (archive.manifest.visibility !== "actor-visible") {
    throw new PortabilityValidationError("manifest.visibility must be actor-visible");
  }
  if (
    !Array.isArray(archive.memories) ||
    archive.memories.length > MAX_WORKSPACE_ARCHIVE_MEMORIES
  ) {
    throw new PortabilityValidationError(
      `archive memories must contain at most ${MAX_WORKSPACE_ARCHIVE_MEMORIES} items`,
    );
  }
  if (!Array.isArray(archive.links) || archive.links.length > MAX_WORKSPACE_ARCHIVE_LINKS) {
    throw new PortabilityValidationError(
      `archive links must contain at most ${MAX_WORKSPACE_ARCHIVE_LINKS} items`,
    );
  }
  if (
    archive.manifest.memoryCount !== archive.memories.length ||
    archive.manifest.linkCount !== archive.links.length
  ) {
    throw new PortabilityValidationError("archive manifest counts do not match its records");
  }
  const memoryIds = new Set<string>();
  const normalizedMemories: WorkspaceArchiveMemory[] = [];
  for (const [index, memory] of archive.memories.entries()) {
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
      throw new PortabilityValidationError(`memories[${index}] must be an object`);
    }
    const id = uuid(memory.id, `memories[${index}].id`);
    if (memoryIds.has(id)) throw new PortabilityValidationError(`duplicate Memory id ${id}`);
    memoryIds.add(id);
    const ownerUserId = uuid(memory.ownerUserId, `memories[${index}].ownerUserId`);
    if (memory.scope !== "private" && memory.scope !== "shared") {
      throw new PortabilityValidationError(`memories[${index}].scope is invalid`);
    }
    if (
      typeof memory.content !== "string" ||
      !memory.content.trim() ||
      memory.content.includes("\0") ||
      memory.content.length > 1_000_000
    ) {
      throw new PortabilityValidationError(`memories[${index}].content is invalid`);
    }
    const normalizedMetadata = metadata(memory.metadata, `memories[${index}].metadata`);
    const createdAt = timestamp(memory.createdAt, `memories[${index}].createdAt`);
    const updatedAt = timestamp(memory.updatedAt, `memories[${index}].updatedAt`);
    if (!Number.isInteger(memory.version) || memory.version < 1) {
      throw new PortabilityValidationError(`memories[${index}].version is invalid`);
    }
    normalizedMemories.push({
      ...memory,
      id,
      ownerUserId,
      metadata: normalizedMetadata,
      createdAt,
      updatedAt,
    });
  }
  const linkIds = new Set<string>();
  const normalizedLinks: WorkspaceArchiveLink[] = [];
  for (const [index, link] of archive.links.entries()) {
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      throw new PortabilityValidationError(`links[${index}] must be an object`);
    }
    const id = uuid(link.id, `links[${index}].id`);
    if (linkIds.has(id)) throw new PortabilityValidationError(`duplicate Link id ${id}`);
    linkIds.add(id);
    const source = uuid(link.sourceMemoryId, `links[${index}].sourceMemoryId`);
    const target = uuid(link.targetMemoryId, `links[${index}].targetMemoryId`);
    if (!memoryIds.has(source) || !memoryIds.has(target) || source === target) {
      throw new PortabilityValidationError(`links[${index}] has invalid endpoints`);
    }
    if (
      typeof link.kind !== "string" ||
      !link.kind.trim() ||
      link.kind.includes("\0") ||
      link.kind.length > 64
    ) {
      throw new PortabilityValidationError(`links[${index}].kind is invalid`);
    }
    if (!Number.isFinite(link.weight) || link.weight < 0 || link.weight > 1) {
      throw new PortabilityValidationError(`links[${index}].weight is invalid`);
    }
    const normalizedMetadata = metadata(link.metadata, `links[${index}].metadata`);
    const createdAt = timestamp(link.createdAt, `links[${index}].createdAt`);
    const updatedAt = timestamp(link.updatedAt, `links[${index}].updatedAt`);
    normalizedLinks.push({
      ...link,
      id,
      sourceMemoryId: source,
      targetMemoryId: target,
      metadata: normalizedMetadata,
      createdAt,
      updatedAt,
    });
  }
  return {
    manifest: {
      ...archive.manifest,
      exportedAt,
      sourceDeploymentId,
      sourceWorkspaceId,
    },
    memories: normalizedMemories,
    links: normalizedLinks,
  };
}

function normalizedOwnerMap(value: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PortabilityValidationError("ownerMap must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_WORKSPACE_ARCHIVE_MEMORIES) {
    throw new PortabilityValidationError(
      `ownerMap exceeds ${MAX_WORKSPACE_ARCHIVE_MEMORIES} entries`,
    );
  }
  const normalized: Record<string, string> = {};
  for (const [source, target] of entries) {
    const sourceId = uuid(source, "ownerMap source");
    const targetId = uuid(target, `ownerMap[${source}]`);
    if (normalized[sourceId] && normalized[sourceId] !== targetId) {
      throw new PortabilityValidationError(`ownerMap contains conflicting source ${sourceId}`);
    }
    normalized[sourceId] = targetId;
  }
  return normalized;
}

async function insertChunks(
  transaction: PostgresTransaction,
  workspaceId: string,
  memoryId: string,
  content: string,
): Promise<void> {
  const chunks = chunkMemoryContent(content);
  for (const [ordinal, chunk] of chunks.entries()) {
    await transaction.query(
      `INSERT INTO memory_chunks (id, workspace_id, memory_id, ordinal, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), workspaceId, memoryId, ordinal, chunk],
    );
  }
}

export function createPortabilityModule(database: PostgresDatabase) {
  return {
    async exportWorkspace(actor: ActorContext): Promise<WorkspaceArchive> {
      if (actor.agentId) throw new PortabilityAccessDeniedError("Workspace export requires a User");
      const exported = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const capabilities = await transaction.query<{ capabilities: Record<string, unknown> }>(
          "SELECT lore.portable_core_capabilities() AS capabilities",
        );
        const deploymentId = capabilities.rows[0]?.capabilities.deploymentId;
        if (typeof deploymentId !== "string") throw new Error("Deployment identity is unavailable");
        const memories = await transaction.query<ExportMemoryRow>(
          `SELECT id, owner_user_id, scope, content, metadata, version, created_at, updated_at
           FROM memories
           WHERE workspace_id = $1
           ORDER BY id
           LIMIT $2`,
          [actor.workspaceId, MAX_WORKSPACE_ARCHIVE_MEMORIES + 1],
        );
        if (memories.rows.length > MAX_WORKSPACE_ARCHIVE_MEMORIES) {
          throw new WorkspaceExportLimitError(
            `Workspace export exceeds ${MAX_WORKSPACE_ARCHIVE_MEMORIES} visible Memories`,
          );
        }
        const memoryIds = memories.rows.map((memory) => memory.id);
        const links = memoryIds.length
          ? await transaction.query<ExportLinkRow>(
              `SELECT id, source_memory_id, target_memory_id, kind, weight, metadata,
                      created_at, updated_at
               FROM memory_links
               WHERE workspace_id = $1
                 AND source_memory_id = ANY($2::uuid[])
                 AND target_memory_id = ANY($2::uuid[])
               ORDER BY id
               LIMIT $3`,
              [actor.workspaceId, memoryIds, MAX_WORKSPACE_ARCHIVE_LINKS + 1],
            )
          : { rows: [] as ExportLinkRow[] };
        if (links.rows.length > MAX_WORKSPACE_ARCHIVE_LINKS) {
          throw new WorkspaceExportLimitError(
            `Workspace export exceeds ${MAX_WORKSPACE_ARCHIVE_LINKS} visible Links`,
          );
        }
        return { deploymentId, memories: memories.rows, links: links.rows };
      });

      const archive: WorkspaceArchive = {
        manifest: {
          checksum: "",
          exportedAt: new Date().toISOString(),
          format: WORKSPACE_ARCHIVE_FORMAT,
          memoryCount: exported.memories.length,
          linkCount: exported.links.length,
          sourceDeploymentId: exported.deploymentId,
          sourceWorkspaceId: actor.workspaceId,
          visibility: "actor-visible",
        },
        memories: exported.memories.map((memory) => ({
          id: memory.id,
          ownerUserId: memory.owner_user_id,
          scope: memory.scope,
          content: memory.content,
          metadata: memory.metadata,
          version: memory.version,
          createdAt: timestamp(memory.created_at, "memory.createdAt"),
          updatedAt: timestamp(memory.updated_at, "memory.updatedAt"),
        })),
        links: exported.links.map((link) => ({
          id: link.id,
          sourceMemoryId: link.source_memory_id,
          targetMemoryId: link.target_memory_id,
          kind: link.kind,
          weight: Number(link.weight),
          metadata: link.metadata,
          createdAt: timestamp(link.created_at, "link.createdAt"),
          updatedAt: timestamp(link.updated_at, "link.updatedAt"),
        })),
      };
      archive.manifest.checksum = await archiveChecksum(archive);
      return archive;
    },

    async importWorkspace(
      actor: ActorContext,
      input: ImportWorkspaceArchive,
    ): Promise<WorkspaceImportResult> {
      if (actor.agentId) throw new PortabilityAccessDeniedError("Workspace import requires a User");
      const archive = normalizedArchive(input.archive);
      const checksum = await archiveChecksum(input.archive);
      if (checksum !== input.archive.manifest.checksum) {
        throw new PortabilityValidationError("archive checksum does not match its records");
      }
      const ownerMap = normalizedOwnerMap(input.ownerMap);
      const sourceOwners = new Set(archive.memories.map((memory) => memory.ownerUserId));
      for (const sourceOwner of sourceOwners) {
        if (ownerMap[sourceOwner] !== actor.userId.toLowerCase()) {
          throw new PortabilityValidationError(
            `ownerMap must explicitly map source owner ${sourceOwner} to the importing User`,
          );
        }
      }
      const conflictPolicy = input.conflictPolicy ?? "remap";
      if (!(["error", "remap", "skip"] as const).includes(conflictPolicy)) {
        throw new PortabilityValidationError("conflictPolicy must be error, remap, or skip");
      }
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const allowed = await transaction.query<{ allowed: boolean }>(
          "SELECT lore.can_write_memory($1, $2) AS allowed",
          [actor.workspaceId, actor.userId],
        );
        if (allowed.rows[0]?.allowed !== true) {
          throw new PortabilityAccessDeniedError("User cannot import into this Workspace");
        }

        const previousReceipt = await workspaceImportReceipt(transaction, actor, checksum);
        if (previousReceipt) {
          return {
            ...previousReceipt,
            dryRun: input.dryRun === true,
            memoryIdMap: input.dryRun ? {} : previousReceipt.memoryIdMap,
            replayed: true,
          };
        }

        const sourceIds = archive.memories.map((memory) => memory.id);
        const conflicts = await transaction.query<{ id: string }>(
          "SELECT id FROM memories WHERE workspace_id = $1 AND id = ANY($2::uuid[])",
          [actor.workspaceId, sourceIds],
        );
        const conflictingIds = new Set(conflicts.rows.map((row) => row.id));
        if (conflictPolicy === "error" && conflictingIds.size) {
          throw new PortabilityValidationError(
            "archive contains Memory ids already in this Workspace",
          );
        }
        const skippedMemories = conflictPolicy === "skip" ? conflictingIds.size : 0;
        const includedMemoryIds = new Set(
          archive.memories
            .filter((memory) => conflictPolicy !== "skip" || !conflictingIds.has(memory.id))
            .map((memory) => memory.id),
        );
        const expectedLinkCount = archive.links.filter(
          (link) =>
            includedMemoryIds.has(link.sourceMemoryId) &&
            includedMemoryIds.has(link.targetMemoryId),
        ).length;
        if (input.dryRun) {
          return {
            archiveChecksum: checksum,
            dryRun: true,
            importedLinks: expectedLinkCount,
            importedMemories: includedMemoryIds.size,
            memoryIdMap: {},
            replayed: false,
            skippedMemories,
          };
        }

        const importId = crypto.randomUUID();
        const claimed = await transaction.query<{ id: string }>(
          `INSERT INTO workspace_imports (
             id, workspace_id, imported_by_user_id, archive_sha256,
             source_deployment_id, source_workspace_id, summary
           ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
           ON CONFLICT (workspace_id, imported_by_user_id, archive_sha256) DO NOTHING
           RETURNING id`,
          [
            importId,
            actor.workspaceId,
            actor.userId,
            checksum,
            archive.manifest.sourceDeploymentId,
            archive.manifest.sourceWorkspaceId,
          ],
        );
        if (!claimed.rows[0]) {
          const result = await workspaceImportReceipt(transaction, actor, checksum);
          if (!result) throw new Error("Import receipt became unavailable");
          return { ...result, replayed: true };
        }
        await transaction.query("SELECT set_config('lore.request_id', $1, true)", [importId]);

        const memoryIdMap: Record<string, string> = {};
        for (const memory of archive.memories) {
          if (conflictPolicy === "skip" && conflictingIds.has(memory.id)) {
            continue;
          }
          // Always assign a fresh id. Trying to preserve an apparently unused
          // source id would let a primary-key conflict reveal an RLS-hidden Memory.
          const targetId = crypto.randomUUID();
          memoryIdMap[memory.id] = targetId;
          await transaction.query(
            `INSERT INTO memories (
               id, workspace_id, owner_user_id, created_by_agent_id,
               scope, content, metadata
             ) VALUES ($1, $2, $3, NULL, $4, $5, $6::jsonb)`,
            [
              targetId,
              actor.workspaceId,
              actor.userId,
              memory.scope,
              memory.content,
              JSON.stringify(memory.metadata),
            ],
          );
          await insertChunks(transaction, actor.workspaceId, targetId, memory.content);
          await transaction.query(
            `INSERT INTO memory_import_provenance (
               workspace_id, memory_id, import_id, source_memory_id,
               source_owner_user_id, source_created_at, source_updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              actor.workspaceId,
              targetId,
              importId,
              memory.id,
              memory.ownerUserId,
              memory.createdAt,
              memory.updatedAt,
            ],
          );
        }

        let importedLinks = 0;
        for (const link of archive.links) {
          const source = memoryIdMap[link.sourceMemoryId];
          const target = memoryIdMap[link.targetMemoryId];
          if (!source || !target) continue;
          const inserted = await transaction.query<{ id: string }>(
            `INSERT INTO memory_links (
               id, workspace_id, source_memory_id, target_memory_id,
               kind, weight, metadata
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
             ON CONFLICT (workspace_id, source_memory_id, target_memory_id, kind) DO NOTHING
             RETURNING id`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              source,
              target,
              link.kind,
              link.weight,
              JSON.stringify(link.metadata),
            ],
          );
          if (inserted.rows[0]) importedLinks += 1;
        }

        const result: WorkspaceImportResult = {
          archiveChecksum: checksum,
          dryRun: false,
          importedLinks,
          importedMemories: Object.keys(memoryIdMap).length,
          memoryIdMap,
          replayed: false,
          skippedMemories,
        };
        await transaction.query("UPDATE workspace_imports SET summary = $2::jsonb WHERE id = $1", [
          importId,
          JSON.stringify(result),
        ]);
        return result;
      });
    },
  };
}
