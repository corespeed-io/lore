export const MEMORY_PROPOSAL_KINDS = ["create", "update"] as const;
export const MEMORY_PROPOSAL_STATUSES = ["pending", "accepted", "rejected"] as const;

/** Memory, Observation, and Code evidence records one Proposal may cite, in total. */
export const MAXIMUM_MEMORY_PROPOSAL_EVIDENCE = 50;
/** The most Proposals one list read returns. */
export const MAXIMUM_MEMORY_PROPOSAL_LIST = 100;
/**
 * Unexpired pending Proposals one owner may hold in a Workspace. The
 * `lore.validate_memory_proposal_target` trigger enforces it.
 */
export const MAXIMUM_PENDING_MEMORY_PROPOSALS = 100;
/**
 * Days Proposal content is kept after submission or its latest review. The
 * `memory_proposals` CHECK constraint requires exactly this expiry.
 */
export const MEMORY_PROPOSAL_RETENTION_DAYS = 30;
