import type {
  MemoryMutationPrimitivesOptions,
  PostgresDatabase,
  PostgresTransaction,
} from "@corespeed/lore-core";
import {
  MEMORY_CHUNKING_REVISION,
  MemoryContentValidationError,
  prepareMemoryContent,
} from "@corespeed/lore-core";
import { MemoryMetadataSchema, type MemoryScope } from "@/modules/memories/schemas";
import { createMemoryMutationPrimitives } from "@/modules/memories/service";
import { mutationRequestHash } from "@/server/api/idempotency";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";

export const WORKSPACE_ARCHIVE_FORMAT = "lore-workspace-v1";
export const MAX_WORKSPACE_ARCHIVE_MEMORIES = 10_000;
export const MAX_WORKSPACE_ARCHIVE_LINKS = 50_000;
/** The largest accepted import request body, in UTF-8 bytes. */
export const MAX_WORKSPACE_IMPORT_BODY_BYTES = 50_000_000;
/**
 * Export budget for one compact archive, in UTF-8 bytes. An import body also carries
 * the ownerMap (at most 10,000 entries of about 80 bytes) and its own envelope, so
 * this margin keeps every archive that export produces importable.
 */
export const MAX_WORKSPACE_ARCHIVE_BYTES = 48_000_000;
// Upper bounds for each serialized record beyond its measured JSON content (or kind)
// and metadata: ids, timestamps, version or weight, property names, and separators.
const ARCHIVE_MEMORY_OVERHEAD_BYTES = 256;
const ARCHIVE_LINK_OVERHEAD_BYTES = 320;
const ARCHIVE_MANIFEST_BYTES = 1_024;
// Each import INSERT carries one bounded JSON array parameter.
const IMPORT_BATCH_ROWS = 5_000;
const IMPORT_BATCH_CHARACTERS = 4_000_000;
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

export interface PortabilityModuleOptions extends MemoryMutationPrimitivesOptions {
  /** Export budget in UTF-8 bytes; defaults to {@link MAX_WORKSPACE_ARCHIVE_BYTES}. */
  maximumArchiveBytes?: number;
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
  running_bytes: number | string;
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
  running_bytes: number | string;
}

interface NormalizedArchiveMemory extends WorkspaceArchiveMemory {
  chunks: readonly string[];
}

interface NormalizedArchive {
  manifest: WorkspaceArchive["manifest"];
  memories: NormalizedArchiveMemory[];
  links: WorkspaceArchiveLink[];
}

interface ImportReceipt {
  id: string;
  summary: WorkspaceImportResult;
}

async function workspaceImportReceipt(
  transaction: PostgresTransaction,
  actor: ActorContext,
  checksum: string,
  lock: boolean,
): Promise<ImportReceipt | null> {
  // Locking serializes concurrent re-imports of one archive behind the receipt row.
  const receipt = await transaction.query<ImportReceipt>(
    `SELECT id, summary
     FROM workspace_imports
     WHERE workspace_id = $1
       AND imported_by_user_id = $2
       AND archive_sha256 = $3
     ${lock ? "FOR UPDATE" : ""}`,
    [actor.workspaceId, actor.userId, checksum],
  );
  return receipt.rows[0] ?? null;
}

/** Source Memory id to imported Memory id, for every imported Memory that still exists. */
async function survivingImportedMemories(
  transaction: PostgresTransaction,
  actor: ActorContext,
  importId: string,
): Promise<Map<string, string>> {
  const provenance = await transaction.query<{ memory_id: string; source_memory_id: string }>(
    `SELECT memory_id, source_memory_id
     FROM memory_import_provenance
     WHERE workspace_id = $1 AND import_id = $2`,
    [actor.workspaceId, importId],
  );
  return new Map(provenance.rows.map((row) => [row.source_memory_id, row.memory_id]));
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

// Archive metadata obeys the same wire contract as a direct Memory write, so an
// exported Memory can always be imported again.
function metadata(value: unknown, name: string): Record<string, unknown> {
  let parsed: ReturnType<typeof MemoryMetadataSchema.safeParse>;
  try {
    parsed = MemoryMetadataSchema.safeParse(value);
  } catch (error) {
    // Recursive JSON parsing can exhaust the runtime stack before Zod returns an issue.
    if (error instanceof RangeError) {
      throw new PortabilityValidationError(`${name} is too deeply nested`, { cause: error });
    }
    throw error;
  }
  if (!parsed.success) {
    throw new PortabilityValidationError(
      `${name}: ${parsed.error.issues[0]?.message ?? "metadata is invalid"}`,
    );
  }
  return parsed.data;
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

function normalizedArchive(archive: WorkspaceArchive): NormalizedArchive {
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
  const normalizedMemories: NormalizedArchiveMemory[] = [];
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
    let chunks: readonly string[];
    try {
      chunks = prepareMemoryContent(memory.content).chunks;
    } catch (error) {
      if (error instanceof MemoryContentValidationError) {
        throw new PortabilityValidationError(`memories[${index}].content: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
    const normalizedMetadata = metadata(memory.metadata, `memories[${index}].metadata`);
    const createdAt = timestamp(memory.createdAt, `memories[${index}].createdAt`);
    const updatedAt = timestamp(memory.updatedAt, `memories[${index}].updatedAt`);
    if (!Number.isInteger(memory.version) || memory.version < 1) {
      throw new PortabilityValidationError(`memories[${index}].version is invalid`);
    }
    normalizedMemories.push({
      id,
      ownerUserId,
      scope: memory.scope,
      content: memory.content,
      metadata: normalizedMetadata,
      version: memory.version,
      createdAt,
      updatedAt,
      chunks,
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
      id,
      sourceMemoryId: source,
      targetMemoryId: target,
      kind: link.kind,
      weight: link.weight,
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

/** Serialize records into bounded JSON arrays, one lazily built parameter per INSERT. */
function* recordBatches(records: readonly object[]): Generator<string> {
  let pending: string[] = [];
  let characters = 0;
  for (const record of records) {
    const serialized = JSON.stringify(record);
    if (
      pending.length > 0 &&
      (pending.length >= IMPORT_BATCH_ROWS ||
        characters + serialized.length > IMPORT_BATCH_CHARACTERS)
    ) {
      yield `[${pending.join(",")}]`;
      pending = [];
      characters = 0;
    }
    pending.push(serialized);
    characters += serialized.length + 1;
  }
  if (pending.length > 0) yield `[${pending.join(",")}]`;
}

/**
 * Run one set-based INSERT per bounded batch. `sql` reads its rows from
 * `jsonb_to_recordset($1::jsonb)`, so RLS WITH CHECK and row triggers still apply to
 * every row exactly as they would to single-row inserts. Returns RETURNING row count.
 */
async function insertInBatches(
  transaction: PostgresTransaction,
  sql: string,
  records: readonly object[],
  parameters: readonly unknown[],
): Promise<number> {
  let returned = 0;
  for (const batch of recordBatches(records)) {
    const result = await transaction.query<{ id: string }>(sql, [batch, ...parameters]);
    returned += result.rows.length;
  }
  return returned;
}

const INSERT_IMPORTED_MEMORIES = `INSERT INTO memories (
     id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata
   )
   SELECT record.id, $2::uuid, $3::uuid, NULL::uuid, record.scope, record.content,
          record.metadata
   FROM jsonb_to_recordset($1::jsonb) AS record(
     id uuid, scope memory_scope, content text, metadata jsonb
   )`;

const INSERT_IMPORTED_CHUNKS = `INSERT INTO memory_chunks (
     id, workspace_id, memory_id, ordinal, content, chunking_revision
   )
   SELECT gen_random_uuid(), $2::uuid, record.memory_id, record.ordinal, record.content,
          $3::text
   FROM jsonb_to_recordset($1::jsonb) AS record(
     memory_id uuid, ordinal integer, content text
   )`;

const INSERT_IMPORT_PROVENANCE = `INSERT INTO memory_import_provenance (
     workspace_id, memory_id, import_id, source_memory_id,
     source_owner_user_id, source_created_at, source_updated_at
   )
   SELECT $2::uuid, record.memory_id, $3::uuid, record.source_memory_id,
          record.source_owner_user_id, record.source_created_at, record.source_updated_at
   FROM jsonb_to_recordset($1::jsonb) AS record(
     memory_id uuid, source_memory_id uuid, source_owner_user_id uuid,
     source_created_at timestamptz, source_updated_at timestamptz
   )`;

const INSERT_IMPORTED_LINKS = `INSERT INTO memory_links (
     id, workspace_id, source_memory_id, target_memory_id, kind, weight, metadata
   )
   SELECT gen_random_uuid(), $2::uuid, record.source_memory_id, record.target_memory_id,
          record.kind, record.weight, record.metadata
   FROM jsonb_to_recordset($1::jsonb) AS record(
     source_memory_id uuid, target_memory_id uuid, kind text, weight real, metadata jsonb
   )
   ON CONFLICT (workspace_id, source_memory_id, target_memory_id, kind) DO NOTHING
   RETURNING id`;

export function createPortabilityModule(
  database: PostgresDatabase,
  options: PortabilityModuleOptions = {},
) {
  const { maximumArchiveBytes = MAX_WORKSPACE_ARCHIVE_BYTES, ...mutationOptions } = options;
  const { enqueueEmbeddingJobsInTransaction, notifyMaintenance } =
    createMemoryMutationPrimitives(mutationOptions);

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
        const recordBudget = maximumArchiveBytes - ARCHIVE_MANIFEST_BYTES;
        // Size every visible Memory before reading content, then fetch only rows that
        // start inside the byte budget. The first row that crosses it is the sentinel.
        const memories = await transaction.query<ExportMemoryRow>(
          `WITH sized AS (
             SELECT id,
                    octet_length(to_json(content)::text) + octet_length(metadata::text)
                      + $4::integer AS record_bytes
             FROM memories
             WHERE workspace_id = $1
             ORDER BY id
             LIMIT $2
           ), budgeted AS (
             SELECT id, record_bytes, sum(record_bytes) OVER (ORDER BY id) AS running_bytes
             FROM sized
           )
           SELECT memory.id, memory.owner_user_id, memory.scope, memory.content,
                  memory.metadata, memory.version, memory.created_at, memory.updated_at,
                  budgeted.running_bytes::float8 AS running_bytes
           FROM budgeted
           JOIN memories memory ON memory.workspace_id = $1 AND memory.id = budgeted.id
           WHERE budgeted.running_bytes - budgeted.record_bytes <= $3::bigint
           ORDER BY memory.id`,
          [
            actor.workspaceId,
            MAX_WORKSPACE_ARCHIVE_MEMORIES + 1,
            recordBudget,
            ARCHIVE_MEMORY_OVERHEAD_BYTES,
          ],
        );
        if (memories.rows.length > MAX_WORKSPACE_ARCHIVE_MEMORIES) {
          throw new WorkspaceExportLimitError(
            `Workspace export exceeds ${MAX_WORKSPACE_ARCHIVE_MEMORIES} visible Memories`,
          );
        }
        const memoryBytes = Number(memories.rows.at(-1)?.running_bytes ?? 0);
        if (memoryBytes > recordBudget) {
          throw new WorkspaceExportLimitError(
            `Workspace export exceeds ${maximumArchiveBytes} archive bytes`,
          );
        }
        const memoryIds = memories.rows.map((memory) => memory.id);
        const linkBudget = recordBudget - memoryBytes;
        const links = memoryIds.length
          ? await transaction.query<ExportLinkRow>(
              `WITH sized AS (
                 SELECT id,
                        octet_length(to_json(kind)::text) + octet_length(metadata::text)
                          + $5::integer AS record_bytes
                 FROM memory_links
                 WHERE workspace_id = $1
                   AND source_memory_id = ANY($2::uuid[])
                   AND target_memory_id = ANY($2::uuid[])
                 ORDER BY id
                 LIMIT $3
               ), budgeted AS (
                 SELECT id, record_bytes, sum(record_bytes) OVER (ORDER BY id) AS running_bytes
                 FROM sized
               )
               SELECT link.id, link.source_memory_id, link.target_memory_id, link.kind,
                      link.weight, link.metadata, link.created_at, link.updated_at,
                      budgeted.running_bytes::float8 AS running_bytes
               FROM budgeted
               JOIN memory_links link ON link.workspace_id = $1 AND link.id = budgeted.id
               WHERE budgeted.running_bytes - budgeted.record_bytes <= $4::bigint
               ORDER BY link.id`,
              [
                actor.workspaceId,
                memoryIds,
                MAX_WORKSPACE_ARCHIVE_LINKS + 1,
                linkBudget,
                ARCHIVE_LINK_OVERHEAD_BYTES,
              ],
            )
          : { rows: [] as ExportLinkRow[] };
        if (links.rows.length > MAX_WORKSPACE_ARCHIVE_LINKS) {
          throw new WorkspaceExportLimitError(
            `Workspace export exceeds ${MAX_WORKSPACE_ARCHIVE_LINKS} visible Links`,
          );
        }
        if (Number(links.rows.at(-1)?.running_bytes ?? 0) > linkBudget) {
          throw new WorkspaceExportLimitError(
            `Workspace export exceeds ${maximumArchiveBytes} archive bytes`,
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
      const dryRun = input.dryRun === true;
      const imported = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const allowed = await transaction.query<{ allowed: boolean }>(
          "SELECT lore.can_write_memory($1, $2) AS allowed",
          [actor.workspaceId, actor.userId],
        );
        if (allowed.rows[0]?.allowed !== true) {
          throw new PortabilityAccessDeniedError("User cannot import into this Workspace");
        }

        // A receipt replays only while every Memory it imported still exists. After the
        // importing User deletes some or all of them, importing the same archive again
        // restores just the missing Memories and reconnects them to the survivors.
        const receipt = await workspaceImportReceipt(transaction, actor, checksum, !dryRun);
        const survivors = receipt
          ? await survivingImportedMemories(transaction, actor, receipt.id)
          : new Map<string, string>();
        if (receipt && survivors.size === Object.keys(receipt.summary.memoryIdMap).length) {
          return {
            jobIds: [],
            result: {
              ...receipt.summary,
              dryRun,
              memoryIdMap: dryRun ? {} : receipt.summary.memoryIdMap,
              replayed: true,
            },
          };
        }

        const missingMemories = archive.memories.filter((memory) => !survivors.has(memory.id));
        const conflicts = missingMemories.length
          ? await transaction.query<{ id: string }>(
              "SELECT id FROM memories WHERE workspace_id = $1 AND id = ANY($2::uuid[])",
              [actor.workspaceId, missingMemories.map((memory) => memory.id)],
            )
          : { rows: [] };
        const conflictingIds = new Set(conflicts.rows.map((row) => row.id));
        if (conflictPolicy === "error" && conflictingIds.size) {
          throw new PortabilityValidationError(
            "archive contains Memory ids already in this Workspace",
          );
        }
        const skippedMemories = conflictPolicy === "skip" ? conflictingIds.size : 0;
        const includedMemories = missingMemories.filter(
          (memory) => conflictPolicy !== "skip" || !conflictingIds.has(memory.id),
        );
        const includedMemoryIds = new Set(includedMemories.map((memory) => memory.id));
        const mapped = (id: string) => includedMemoryIds.has(id) || survivors.has(id);
        // Links among surviving Memories are left as the User kept or removed them.
        const includedLinks = archive.links.filter(
          (link) =>
            mapped(link.sourceMemoryId) &&
            mapped(link.targetMemoryId) &&
            (includedMemoryIds.has(link.sourceMemoryId) ||
              includedMemoryIds.has(link.targetMemoryId)),
        );
        if (dryRun) {
          return {
            jobIds: [],
            result: {
              archiveChecksum: checksum,
              dryRun: true,
              importedLinks: includedLinks.length,
              importedMemories: includedMemories.length,
              memoryIdMap: {},
              replayed: false,
              skippedMemories,
            },
          };
        }

        let importId = receipt?.id;
        if (!importId) {
          const claimed = await transaction.query<{ id: string }>(
            `INSERT INTO workspace_imports (
               id, workspace_id, imported_by_user_id, archive_sha256,
               source_deployment_id, source_workspace_id, summary
             ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
             ON CONFLICT (workspace_id, imported_by_user_id, archive_sha256) DO NOTHING
             RETURNING id`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              actor.userId,
              checksum,
              archive.manifest.sourceDeploymentId,
              archive.manifest.sourceWorkspaceId,
            ],
          );
          importId = claimed.rows[0]?.id;
          if (!importId) {
            const concurrent = await workspaceImportReceipt(transaction, actor, checksum, false);
            if (!concurrent) throw new Error("Import receipt became unavailable");
            return { jobIds: [], result: { ...concurrent.summary, replayed: true } };
          }
        }
        await transaction.query("SELECT set_config('lore.request_id', $1, true)", [importId]);

        // Always assign fresh ids. Trying to preserve an apparently unused source id
        // would let a primary-key conflict reveal an RLS-hidden Memory.
        const memoryIdMap: Record<string, string> = Object.fromEntries(survivors);
        const targets = includedMemories.map((memory) => {
          const targetId = crypto.randomUUID();
          memoryIdMap[memory.id] = targetId;
          return { memory, targetId };
        });
        await insertInBatches(
          transaction,
          INSERT_IMPORTED_MEMORIES,
          targets.map(({ memory, targetId }) => ({
            id: targetId,
            scope: memory.scope,
            content: memory.content,
            metadata: memory.metadata,
          })),
          [actor.workspaceId, actor.userId],
        );
        await insertInBatches(
          transaction,
          INSERT_IMPORTED_CHUNKS,
          targets.flatMap(({ memory, targetId }) =>
            memory.chunks.map((content, ordinal) => ({ memory_id: targetId, ordinal, content })),
          ),
          [actor.workspaceId, MEMORY_CHUNKING_REVISION],
        );
        await insertInBatches(
          transaction,
          INSERT_IMPORT_PROVENANCE,
          targets.map(({ memory, targetId }) => ({
            memory_id: targetId,
            source_memory_id: memory.id,
            source_owner_user_id: memory.ownerUserId,
            source_created_at: memory.createdAt,
            source_updated_at: memory.updatedAt,
          })),
          [actor.workspaceId, importId],
        );
        const jobIds = await enqueueEmbeddingJobsInTransaction(
          transaction,
          targets.map(({ memory, targetId }) => ({
            id: targetId,
            workspace_id: actor.workspaceId,
            owner_user_id: actor.userId,
            scope: memory.scope,
            version: 1,
          })),
        );
        const importedLinks = await insertInBatches(
          transaction,
          INSERT_IMPORTED_LINKS,
          includedLinks.map((link) => ({
            source_memory_id: memoryIdMap[link.sourceMemoryId],
            target_memory_id: memoryIdMap[link.targetMemoryId],
            kind: link.kind,
            weight: link.weight,
            metadata: link.metadata,
          })),
          [actor.workspaceId],
        );

        const result: WorkspaceImportResult = {
          archiveChecksum: checksum,
          dryRun: false,
          importedLinks,
          importedMemories: targets.length,
          memoryIdMap,
          replayed: false,
          skippedMemories,
        };
        await transaction.query("UPDATE workspace_imports SET summary = $2::jsonb WHERE id = $1", [
          importId,
          JSON.stringify(result),
        ]);
        return { jobIds, result };
      });
      // Queue hints are post-commit latency optimizations; the jobs are durable.
      for (const jobId of imported.jobIds) notifyMaintenance(jobId);
      return imported.result;
    },
  };
}
