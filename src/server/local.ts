// Compiler-enforced: this module opens DATABASE_URL and must never reach the
// client bundle.
import "server-only";
import { type Db, initSchema } from "./db";
import { makeDb, resolveDatabaseUrl } from "./drivers";
import { embeddingsConfigFromEnv, makeEmbedFn } from "./pipeline";
import { type Store, createStore } from "./store";

let storePromise: Promise<Store> | null = null;
let dbPromise: Promise<Db> | null = null;

// One store + one schema init per process/isolate; init failures are not
// cached so a fixed env/database heals on the next request. Whether the store
// holds sockets is the driver's business (Node pools; Workers opens a client
// per call/tx), so this singleton is safe on Workers too.
export function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = (async () => {
      const url = await resolveDatabaseUrl();
      if (!url) throw new Error("no database configured: bind HYPERDRIVE or set DATABASE_URL");
      const cfg = embeddingsConfigFromEnv();
      const db = await makeDb(url);
      await initSchema(db, { embeddingModel: cfg.model, embeddingDim: cfg.dim });
      dbPromise = Promise.resolve(db);
      return createStore(db, makeEmbedFn(cfg));
    })();
    storePromise.catch(() => {
      storePromise = null;
    });
  }
  return storePromise;
}

// The maintenance route needs the raw connection for its lease compare-and-set;
// everything else should go through the Store. Initializing via getStore keeps
// the schema check on one path.
export async function getDb(): Promise<Db> {
  await getStore();
  if (!dbPromise) throw new Error("database not initialized");
  return dbPromise;
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
