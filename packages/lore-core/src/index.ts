/**
 * @corespeed/lore-core — Lore's reusable memory engine.
 *
 * The kernel owns Memory storage, canonical content bounds, deterministic
 * chunking, hybrid retrieval, Memory Links/graph reads, leased embedding
 * maintenance over a PostgreSQL store. Hosts supply a bound
 * {@link MemoryStorageContext}; its transactions establish their own access
 * policy before the engine reads or writes. Identity, tenant authorization,
 * request replay and database role selection belong to the host.
 *
 * Subpath entries: `./postgres` (pg-backed database factories), `./episodes`
 * (optional Episode/Observation evidence capability), and `./testing`
 * (host-pluggable schema-contract tests). Hosts supply model adapters through
 * the embedding, reranking, and query-planning capability interfaces.
 */

export * from "./database-errors";
export * from "./db";
export * from "./embedding";
export * from "./graph";
export * from "./maintenance";
export * from "./memory";
export * from "./memory-chunking";
export * from "./memory-content";
export * from "./memory-storage";
export * from "./query-planning";
export * from "./reranking";
