// Workspace archive bounds, shared by import/export and the published contract.

/**
 * Every archive format import accepts, oldest first. v1 and v2 differ only in how the
 * checksum orders object keys (`checksum.ts`); v3 orders them as v2 does and gives
 * every Memory its title and gloss, which the earlier formats cannot carry; v4 also
 * gives every Memory its occurredAt. A release that does not import a format refuses
 * its archive rather than drop what it carries.
 */
export const WORKSPACE_ARCHIVE_FORMATS = [
  "lore-workspace-v1",
  "lore-workspace-v2",
  "lore-workspace-v3",
  "lore-workspace-v4",
] as const;
export type WorkspaceArchiveFormat = (typeof WORKSPACE_ARCHIVE_FORMATS)[number];
/** The format export writes: the newest one import accepts. */
export const WORKSPACE_ARCHIVE_FORMAT: WorkspaceArchiveFormat = "lore-workspace-v4";
/** The formats whose Memories carry a title and gloss, which each must state (null for none). */
export const TITLED_WORKSPACE_ARCHIVE_FORMATS: readonly WorkspaceArchiveFormat[] = [
  "lore-workspace-v3",
  "lore-workspace-v4",
];
/** The formats whose Memories carry an occurredAt, which each must state (null for none). */
export const TIMED_WORKSPACE_ARCHIVE_FORMATS: readonly WorkspaceArchiveFormat[] = [
  "lore-workspace-v4",
];
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
