import type {
  MemoryMutationPrimitivesOptions,
  MemoryScope,
  PostgresDatabase,
  PostgresTransaction,
  PreparedMemoryContent,
} from "@corespeed/lore-core";
import {
  insertMemoryLinksInTransaction,
  isStorableText,
  LoreValidationError,
  MemoryContentValidationError,
  prepareMemoryContent,
  queryInRecordBatches,
  validateMemoryLink,
  validateMemoryScope,
} from "@corespeed/lore-core";
import { createMemoryMutationPrimitives } from "@/modules/memories/service";
import { MemoryMetadataSchema } from "@/server/api/shared-schemas";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import { DomainError } from "@/server/errors";
import { workspaceArchiveChecksum } from "./checksum";
import {
  MAX_WORKSPACE_ARCHIVE_BYTES,
  MAX_WORKSPACE_ARCHIVE_LINKS,
  MAX_WORKSPACE_ARCHIVE_MEMORIES,
  WORKSPACE_ARCHIVE_FORMAT,
  WORKSPACE_ARCHIVE_FORMATS,
  type WorkspaceArchiveFormat,
} from "./limits";

/** Embedding jobs an import wakes directly: ten Queue batches, like one sweep. */
const MAX_IMPORT_MAINTENANCE_NOTIFICATIONS = 1_000;
// Upper bounds for each serialized record beyond its measured JSON content (or kind)
// and metadata: ids, timestamps, version or weight, property names, and separators.
const ARCHIVE_MEMORY_OVERHEAD_BYTES = 256;
const ARCHIVE_LINK_OVERHEAD_BYTES = 320;
const ARCHIVE_MANIFEST_BYTES = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PortabilityValidationError extends DomainError {
  override name = "PortabilityValidationError";
  readonly code = "invalid_archive";
}

export class PortabilityAccessDeniedError extends DomainError {
  override name = "PortabilityAccessDeniedError";
  readonly code = "access_denied";
}

export class WorkspaceExportLimitError extends DomainError {
  override name = "WorkspaceExportLimitError";
  readonly code = "workspace_export_limit_exceeded";
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
    format: WorkspaceArchiveFormat;
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
  created_at: Date | string;
  updated_at: Date | string;
  running_bytes: number | string;
}

interface ExportLinkRow {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  running_bytes: number | string;
}

interface NormalizedArchiveMemory extends WorkspaceArchiveMemory {
  /** Validated once, before the import transaction; the insert reuses its chunks. */
  preparedContent: PreparedMemoryContent;
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

// PostgreSQL's ISO text form of a timestamptz: `2026-09-24 12:34:56.123456+00`.
const POSTGRES_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)(Z|[+-]\d{2}(?::\d{2})?)$/;

/**
 * A database timestamp as archive text. The `pg` and PGlite drivers return a Date,
 * whose ISO form keeps its milliseconds (`String(Date)` would drop them). Text, as
 * a type-parser override would return it, keeps its full precision but is rewritten
 * to RFC 3339 and validated, so an archive never carries a timestamp its own
 * import would refuse.
 */
export function exportedTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const match = POSTGRES_TIMESTAMP.exec(value);
  const [date, time, offset] = match?.slice(1) ?? [];
  const text =
    date && time && offset
      ? `${date}T${time}${offset.length === 3 ? `${offset}:00` : offset}`
      : value;
  try {
    return importedTimestamp(text, "timestamp");
  } catch {
    throw new Error(`Database returned a timestamp outside the archive format: ${value}`);
  }
}

// RFC 3339 `date-time`, as the archive schema publishes it, to PostgreSQL's
// microsecond precision.
const ARCHIVE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;
// PostgreSQL refuses a time zone displacement beyond 15:59.
const MAX_OFFSET_HOURS = 15;

/**
 * Validate an archive timestamp without JavaScript's lenient Date parsing, which
 * rolls 2026-02-30 into March and accepts years and offsets PostgreSQL rejects.
 * The text is returned unchanged, so its full precision reaches import provenance.
 */
function importedTimestamp(value: unknown, name: string): string {
  const match = typeof value === "string" ? ARCHIVE_TIMESTAMP.exec(value) : null;
  if (typeof value !== "string" || !match) {
    throw new PortabilityValidationError(`${name} must be an RFC 3339 timestamp`);
  }
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = match
    .slice(1)
    .map((field) => Number(field ?? 0));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    year < 1 ||
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > MAX_OFFSET_HOURS ||
    offsetMinutes > 59
  ) {
    throw new PortabilityValidationError(`${name} is out of range`);
  }
  return value;
}

/**
 * Reject archive JSON that only PostgreSQL would refuse, at write time, which a dry
 * run never reaches: NUL or an unpaired surrogate in any key or string. An own
 * `__proto__` key is refused too, because the metadata schema drops it while the
 * checksum covers it, so the stored metadata would differ from the checksummed one.
 */
function assertStorableJson(value: unknown, name: string): void {
  try {
    JSON.stringify(value, (key: string, item: unknown) => {
      if (key === "__proto__") {
        throw new PortabilityValidationError(`${name} must not contain a __proto__ key`);
      }
      if (!isStorableText(key) || (typeof item === "string" && !isStorableText(item))) {
        throw new PortabilityValidationError(`${name} contains a NUL character or invalid Unicode`);
      }
      return item;
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new PortabilityValidationError(`${name} is too deeply nested`, { cause: error });
    }
    throw error;
  }
}

/** An engine rule, reported as an archive validation failure. */
function archiveRule<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof LoreValidationError) {
      throw new PortabilityValidationError(error.message, { cause: error });
    }
    throw error;
  }
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
  // First, so an archive keeps its own storability and __proto__ messages.
  assertStorableJson(value, name);
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
  return workspaceArchiveChecksum(archivePayload(archive), archive.manifest.format);
}

/** The checksum of an archive supplied for import, whose fields may be arbitrarily deep. */
async function importedArchiveChecksum(archive: WorkspaceArchive): Promise<string> {
  try {
    return await archiveChecksum(archive);
  } catch (error) {
    // The checksum covers every field, including unknown ones validation ignores, so
    // deep nesting there still exhausts the canonical JSON recursion.
    if (error instanceof RangeError) {
      throw new PortabilityValidationError("archive is too deeply nested", { cause: error });
    }
    throw error;
  }
}

function normalizedArchive(archive: WorkspaceArchive): NormalizedArchive {
  if (!archive || typeof archive !== "object") {
    throw new PortabilityValidationError("archive is required");
  }
  if (!WORKSPACE_ARCHIVE_FORMATS.includes(archive.manifest?.format)) {
    throw new PortabilityValidationError(
      `archive format must be ${WORKSPACE_ARCHIVE_FORMATS.join(" or ")}`,
    );
  }
  const sourceDeploymentId = uuid(
    archive.manifest.sourceDeploymentId,
    "manifest.sourceDeploymentId",
  );
  const sourceWorkspaceId = uuid(archive.manifest.sourceWorkspaceId, "manifest.sourceWorkspaceId");
  const exportedAt = importedTimestamp(archive.manifest.exportedAt, "manifest.exportedAt");
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
    const scope = archiveRule(() => validateMemoryScope(memory.scope, `memories[${index}].scope`));
    // Chunking is the content rule. Keep the result so the insert does not chunk again.
    let preparedContent: PreparedMemoryContent;
    try {
      preparedContent = prepareMemoryContent(memory.content);
    } catch (error) {
      if (error instanceof MemoryContentValidationError) {
        throw new PortabilityValidationError(`memories[${index}].content: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
    const normalizedMetadata = metadata(memory.metadata, `memories[${index}].metadata`);
    const createdAt = importedTimestamp(memory.createdAt, `memories[${index}].createdAt`);
    const updatedAt = importedTimestamp(memory.updatedAt, `memories[${index}].updatedAt`);
    if (!Number.isInteger(memory.version) || memory.version < 1) {
      throw new PortabilityValidationError(`memories[${index}].version is invalid`);
    }
    normalizedMemories.push({
      id,
      ownerUserId,
      scope,
      content: memory.content,
      preparedContent,
      metadata: normalizedMetadata,
      version: memory.version,
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
    if (!memoryIds.has(source) || !memoryIds.has(target)) {
      throw new PortabilityValidationError(`links[${index}] has invalid endpoints`);
    }
    // A Link is required to name its kind and weight; the engine owns their rules.
    if (link.kind === undefined || link.weight === undefined) {
      throw new PortabilityValidationError(`links[${index}] must include kind and weight`);
    }
    const normalizedMetadata = metadata(link.metadata, `links[${index}].metadata`);
    const { kind, weight } = archiveRule(() =>
      validateMemoryLink(
        {
          sourceMemoryId: source,
          targetMemoryId: target,
          kind: link.kind,
          weight: link.weight,
          metadata: normalizedMetadata,
        },
        `links[${index}]`,
      ),
    );
    const createdAt = importedTimestamp(link.createdAt, `links[${index}].createdAt`);
    const updatedAt = importedTimestamp(link.updatedAt, `links[${index}].updatedAt`);
    normalizedLinks.push({
      id,
      sourceMemoryId: source,
      targetMemoryId: target,
      kind,
      weight,
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

/** One provenance row per imported Memory, written in bounded record batches. */
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

export function createPortabilityModule(
  database: PostgresDatabase,
  options: PortabilityModuleOptions = {},
) {
  const { maximumArchiveBytes = MAX_WORKSPACE_ARCHIVE_BYTES, ...mutationOptions } = options;
  const { insertMemoriesInTransaction, notifyMaintenanceMany } =
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
          createdAt: exportedTimestamp(memory.created_at),
          updatedAt: exportedTimestamp(memory.updated_at),
        })),
        links: exported.links.map((link) => ({
          id: link.id,
          sourceMemoryId: link.source_memory_id,
          targetMemoryId: link.target_memory_id,
          kind: link.kind,
          weight: Number(link.weight),
          metadata: link.metadata,
          createdAt: exportedTimestamp(link.created_at),
          updatedAt: exportedTimestamp(link.updated_at),
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
      const checksum = await importedArchiveChecksum(input.archive);
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
        const inserted = await insertMemoriesInTransaction(
          transaction,
          actor,
          targets.map(({ memory, targetId }) => ({
            id: targetId,
            scope: memory.scope,
            content: memory.content,
            preparedContent: memory.preparedContent,
            metadata: memory.metadata,
          })),
        );
        await queryInRecordBatches(
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
        const jobIds = inserted.jobIds;
        const importedLinks = await insertMemoryLinksInTransaction(
          transaction,
          actor.workspaceId,
          includedLinks.map((link) => ({
            sourceMemoryId: memoryIdMap[link.sourceMemoryId],
            targetMemoryId: memoryIdMap[link.targetMemoryId],
            kind: link.kind,
            weight: link.weight,
            metadata: link.metadata,
          })),
        );

        const result: WorkspaceImportResult = {
          archiveChecksum: checksum,
          dryRun: false,
          importedLinks: importedLinks.length,
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
      // Wake maintenance for a bounded number of jobs; the scheduled sweep delivers the
      // rest, so a 10,000-Memory import never fans out into thousands of queue sends.
      notifyMaintenanceMany(imported.jobIds.slice(0, MAX_IMPORT_MAINTENANCE_NOTIFICATIONS));
      return imported.result;
    },
  };
}
