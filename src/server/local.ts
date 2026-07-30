// Compiler-enforced: this module opens DATABASE_URL and must never reach the
// client bundle.
import "server-only";
import { Pool } from "pg";
import { type Db, initSchema } from "./db";
import { embeddingsConfigFromEnv, makeEmbedFn } from "./pipeline";
import { type Store, createStore } from "./store";

function pgDb(pool: Pool): Db {
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

let storePromise: Promise<Store> | null = null;

// One pool + one schema init per process; init failures are not cached so a
// fixed env/database heals on the next request.
export function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is not set");
      const cfg = embeddingsConfigFromEnv();
      const db = pgDb(new Pool({ connectionString: url, max: 5 }));
      await initSchema(db, { embeddingModel: cfg.model, embeddingDim: cfg.dim });
      return createStore(db, makeEmbedFn(cfg));
    })();
    storePromise.catch(() => {
      storePromise = null;
    });
  }
  return storePromise;
}

// gbrain.ts calls this in standalone mode — same {isError, text} envelope as
// the remote-gbrain path so nothing downstream changes.
export async function callLocalTool(
  tool: string,
  args: object,
): Promise<{ isError: boolean; text: string }> {
  const { handleRpc } = await import("./mcp");
  const rpc = await handleRpc(getStore, "read", "tools/call", {
    name: tool,
    arguments: args as Record<string, unknown>,
  });
  if (rpc.error) throw new Error(rpc.error.message);
  const result = rpc.result as { content: { text: string }[]; isError: boolean };
  return { isError: Boolean(result.isError), text: result.content[0]?.text ?? "" };
}
