/**
 * @corespeed/lore-core — Lore's reusable memory engine.
 *
 * The kernel owns Memory storage, canonical content bounds, deterministic
 * chunking, hybrid retrieval, Memory Links/graph reads, leased embedding
 * maintenance, and replay-safe idempotency over a PostgreSQL schema whose
 * authorization is Postgres RLS. A host hands every call an already
 * authenticated {@link ActorContext}; the engine installs it as
 * transaction-local GUCs and lets the database enforce the boundary.
 *
 * Subpath entries: `./postgres` (pg-backed database factories), `./episodes`
 * (optional Episode/Observation evidence capability), `./providers`
 * (embedding/reranking/query-planning provider adapters).
 */

export * from "./actor-context";
export * from "./database-errors";
export * from "./db";
export * from "./embedding-config";
export * from "./graph";
export * from "./idempotency";
export * from "./maintenance";
export * from "./memory";
export * from "./memory-chunking";
export * from "./memory-content";
export * from "./provider-response";
export * from "./query-planning";
export * from "./reranking";
