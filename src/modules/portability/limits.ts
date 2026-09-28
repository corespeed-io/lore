// Workspace archive bounds, shared by import/export and the published contract.

/**
 * Every archive format import accepts, oldest first. They differ only in how the
 * checksum orders object keys (`checksum.ts`).
 */
export const WORKSPACE_ARCHIVE_FORMATS = ["lore-workspace-v1", "lore-workspace-v2"] as const;
export type WorkspaceArchiveFormat = (typeof WORKSPACE_ARCHIVE_FORMATS)[number];
/** The format export writes: the newest one import accepts. */
export const WORKSPACE_ARCHIVE_FORMAT: WorkspaceArchiveFormat = "lore-workspace-v2";
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
