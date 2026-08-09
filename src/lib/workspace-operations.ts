import type { ImportWorkspaceArchive, WorkspaceArchive } from "./portability";

export const MAX_WORKSPACE_ARCHIVE_FILE_BYTES = 50_000_000;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceImportConflictPolicy = NonNullable<ImportWorkspaceArchive["conflictPolicy"]>;

export class WorkspaceArchiveParseError extends Error {
  override name = "WorkspaceArchiveParseError";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseWorkspaceArchiveText(text: string): WorkspaceArchive {
  if (text.length > MAX_WORKSPACE_ARCHIVE_FILE_BYTES) {
    throw new WorkspaceArchiveParseError("Archive exceeds Lore's 50 MB import limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkspaceArchiveParseError("This file is not valid JSON.");
  }

  const archive = record(parsed);
  const manifest = record(archive?.manifest);
  const memories = archive?.memories;
  const links = archive?.links;
  if (!archive || !manifest || !Array.isArray(memories) || !Array.isArray(links)) {
    throw new WorkspaceArchiveParseError("This is not a Lore Workspace archive.");
  }
  if (manifest.format !== "lore-workspace-v1") {
    throw new WorkspaceArchiveParseError("Archive format must be lore-workspace-v1.");
  }
  if (typeof manifest.checksum !== "string" || !/^[0-9a-f]{64}$/.test(manifest.checksum)) {
    throw new WorkspaceArchiveParseError("Archive checksum must be a lowercase SHA-256 value.");
  }
  if (
    !nonNegativeInteger(manifest.memoryCount) ||
    !nonNegativeInteger(manifest.linkCount) ||
    manifest.memoryCount !== memories.length ||
    manifest.linkCount !== links.length
  ) {
    throw new WorkspaceArchiveParseError("Archive counts do not match its records.");
  }
  for (const [index, value] of memories.entries()) {
    const memory = record(value);
    if (
      !memory ||
      typeof memory.id !== "string" ||
      typeof memory.ownerUserId !== "string" ||
      (memory.scope !== "shared" && memory.scope !== "private")
    ) {
      throw new WorkspaceArchiveParseError(`Memory ${index + 1} has an invalid identity or scope.`);
    }
  }
  if (links.some((value) => !record(value))) {
    throw new WorkspaceArchiveParseError("Archive Links must be JSON objects.");
  }

  return archive as unknown as WorkspaceArchive;
}

export function workspaceArchiveSourceOwners(archive: WorkspaceArchive): string[] {
  return [...new Set(archive.memories.map((memory) => memory.ownerUserId.toLowerCase()))].sort();
}

export function workspaceOwnerMap(
  archive: WorkspaceArchive,
  targetOwnerUserId: string,
): Record<string, string> {
  const target = targetOwnerUserId.trim().toLowerCase();
  return Object.fromEntries(workspaceArchiveSourceOwners(archive).map((owner) => [owner, target]));
}

export function workspaceImportFingerprint(
  archive: WorkspaceArchive,
  targetOwnerUserId: string,
  conflictPolicy: WorkspaceImportConflictPolicy,
): string {
  return `${archive.manifest.checksum}:${targetOwnerUserId.trim().toLowerCase()}:${conflictPolicy}`;
}

export function workspaceArchiveFilename(workspaceId: string, exportedAt: string): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(exportedAt)?.[0] ?? "archive";
  return `lore-workspace-${workspaceId}-${date}.json`;
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}
