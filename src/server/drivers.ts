// One driver (node-postgres) on every deploy target; the only platform
// difference is connection lifetime and where the connection string comes from.
//
//   Node hosts (local, Docker/Railway, Vercel): a long-lived Pool over
//   DATABASE_URL.
//
//   Cloudflare Workers: workerd forbids holding sockets across requests, so
//   every query/transaction opens a short-lived Client and closes it. That is
//   only fast because the blessed path is a HYPERDRIVE binding (wrangler
//   hyperdrive create …) — the real pool lives at Cloudflare's edge and
//   connecting to it costs milliseconds. A plain DATABASE_URL still works as
//   a fallback but pays a fresh TLS handshake to the origin DB per query.

import type { Db, Query } from "./db";

export function isWorkerd(): boolean {
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  return ua === "Cloudflare-Workers";
}

// Hyperdrive connection strings are only resolvable from the binding at
// runtime; they never appear in process.env.
async function hyperdriveUrl(): Promise<string | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as {
      HYPERDRIVE?: { connectionString?: string };
    };
    return env.HYPERDRIVE?.connectionString ?? null;
  } catch {
    return null;
  }
}

export async function resolveDatabaseUrl(): Promise<string | null> {
  if (isWorkerd()) {
    const viaHyperdrive = await hyperdriveUrl();
    if (viaHyperdrive) return viaHyperdrive;
  }
  return process.env.DATABASE_URL || null;
}

async function pooledDb(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 5 });
  return {
    query: async (text, params) => {
      const res = await pool.query(text, params as unknown[]);
      return { rows: res.rows as Record<string, unknown>[] };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(async (text, params) => {
          const res = await client.query(text, params as unknown[]);
          return { rows: res.rows as Record<string, unknown>[] };
        });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

// Workers: a fresh Client per query and per transaction, fully opened and
// closed inside one request — never crosses the isolate I/O boundary.
async function perRequestDb(url: string): Promise<Db> {
  const { Client } = await import("pg");
  async function withClient<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(async (text, params) => {
        const res = await client.query(text, params as unknown[]);
        return { rows: res.rows as Record<string, unknown>[] };
      });
    } finally {
      await client.end().catch(() => {});
    }
  }
  return {
    query: (text, params) => withClient((q) => q(text, params)),
    tx(fn) {
      return withClient(async (q) => {
        await q("BEGIN");
        try {
          const out = await fn(q);
          await q("COMMIT");
          return out;
        } catch (e) {
          await q("ROLLBACK").catch(() => {});
          throw e;
        }
      });
    },
  };
}

export function makeDb(url: string): Promise<Db> {
  return isWorkerd() ? perRequestDb(url) : pooledDb(url);
}
