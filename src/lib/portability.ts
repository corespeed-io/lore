import { type ActorContext, installActorContext } from "./actor-context";
import type { PostgresDatabase, PostgresTransaction } from "./db";
import { canonicalJson, mutationRequestHash } from "./idempotency";
import { chunkMemoryContent } from "./memory-chunking";
import type { MemoryScope } from "./types";

export const WORKSPACE_ARCHIVE_FORMAT = "lore-workspace-v1";
const MAX_IMPORT_MEMORIES = 10_000;
const MAX_IMPORT_LINKS = 50_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PortabilityValidationError extends Error {
  override name = "PortabilityValidationError";
  readonly status = 400;
}

export class PortabilityAccessDeniedError extends Error {
  override name = "PortabilityAccessDeniedError";
  readonly status = 403;
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
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    if (visited > 10_000) {
      throw new PortabilityValidationError(`${name} exceeds 10000 values`);
    }
    if (current.depth > 32) {
      throw new PortabilityValidationError(`${name} exceeds 32 levels`);
    }
    if (typeof current.value === "string" && current.value.includes("\0")) {
      throw new PortabilityValidationError(`${current.path} contains an invalid null character`);
    }
    if (Array.isArray(current.value)) {
      for (const [index, item] of current.value.entries()) {
        pending.push({ depth: current.depth + 1, path: `${current.path}[${index}]`, value: item });
      }
    } else if (current.value && typeof current.value === "object") {
      for (const [key, item] of Object.entries(current.value)) {
        if (key.includes("\0")) {
          throw new PortabilityValidationError(
            `${current.path} contains an invalid null character`,
          );
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

function validateArchiveShape(archive: WorkspaceArchive): void {
  if (!archive || typeof archive !== "object") {
    throw new PortabilityValidationError("archive is required");
  }
  if (archive.manifest?.format !== WORKSPACE_ARCHIVE_FORMAT) {
    throw new PortabilityValidationError(`archive format must be ${WORKSPACE_ARCHIVE_FORMAT}`);
  }
  uuid(archive.manifest.sourceDeploymentId, "manifest.sourceDeploymentId");
  uuid(archive.manifest.sourceWorkspaceId, "manifest.sourceWorkspaceId");
  timestamp(archive.manifest.exportedAt, "manifest.exportedAt");
  if (!Array.isArray(archive.memories) || archive.memories.length > MAX_IMPORT_MEMORIES) {
    throw new PortabilityValidationError(
      `archive memories must contain at most ${MAX_IMPORT_MEMORIES} items`,
    );
  }
  if (!Array.isArray(archive.links) || archive.links.length > MAX_IMPORT_LINKS) {
    throw new PortabilityValidationError(
      `archive links must contain at most ${MAX_IMPORT_LINKS} items`,
    );
  }
  if (
    archive.manifest.memoryCount !== archive.memories.length ||
    archive.manifest.linkCount !== archive.links.length
  ) {
    throw new PortabilityValidationError("archive manifest counts do not match its records");
  }
  const memoryIds = new Set<string>();
  for (const [index, memory] of archive.memories.entries()) {
    const id = uuid(memory.id, `memories[${index}].id`);
    if (memoryIds.has(id)) throw new PortabilityValidationError(`duplicate Memory id ${id}`);
    memoryIds.add(id);
    uuid(memory.ownerUserId, `memories[${index}].ownerUserId`);
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
    metadata(memory.metadata, `memories[${index}].metadata`);
    timestamp(memory.createdAt, `memories[${index}].createdAt`);
    timestamp(memory.updatedAt, `memories[${index}].updatedAt`);
  }
  const linkIds = new Set<string>();
  for (const [index, link] of archive.links.entries()) {
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
    metadata(link.metadata, `links[${index}].metadata`);
  }
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
           ORDER BY id`,
          [actor.workspaceId],
        );
        const memoryIds = memories.rows.map((memory) => memory.id);
        const links = memoryIds.length
          ? await transaction.query<ExportLinkRow>(
              `SELECT id, source_memory_id, target_memory_id, kind, weight, metadata,
                      created_at, updated_at
               FROM memory_links
               WHERE workspace_id = $1
                 AND source_memory_id = ANY($2::uuid[])
                 AND target_memory_id = ANY($2::uuid[])
               ORDER BY id`,
              [actor.workspaceId, memoryIds],
            )
          : { rows: [] as ExportLinkRow[] };
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
      validateArchiveShape(input.archive);
      const checksum = await archiveChecksum(input.archive);
      if (checksum !== input.archive.manifest.checksum) {
        throw new PortabilityValidationError("archive checksum does not match its records");
      }
      const sourceOwners = new Set(input.archive.memories.map((memory) => memory.ownerUserId));
      for (const sourceOwner of sourceOwners) {
        if (input.ownerMap[sourceOwner] !== actor.userId) {
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

        const sourceIds = input.archive.memories.map((memory) => memory.id);
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
          input.archive.memories
            .filter((memory) => conflictPolicy !== "skip" || !conflictingIds.has(memory.id))
            .map((memory) => memory.id),
        );
        const expectedLinkCount = input.archive.links.filter(
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
            input.archive.manifest.sourceDeploymentId,
            input.archive.manifest.sourceWorkspaceId,
          ],
        );
        if (!claimed.rows[0]) {
          const replay = await transaction.query<{ summary: WorkspaceImportResult }>(
            `SELECT summary
             FROM workspace_imports
             WHERE workspace_id = $1
               AND imported_by_user_id = $2
               AND archive_sha256 = $3`,
            [actor.workspaceId, actor.userId, checksum],
          );
          const result = replay.rows[0]?.summary;
          if (!result) throw new Error("Import receipt became unavailable");
          return { ...result, replayed: true };
        }
        await transaction.query("SELECT set_config('lore.request_id', $1, true)", [importId]);

        const memoryIdMap: Record<string, string> = {};
        for (const memory of input.archive.memories) {
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
        for (const link of input.archive.links) {
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
