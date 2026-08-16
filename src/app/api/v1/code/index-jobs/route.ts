import { createCodeIndexJobHandlers } from "@/lib/code-http";
import { configuredCodeRepositoriesFromEnvironment } from "@/lib/code-index-queue";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  // The list read never consults the registry; parsing it here would let a
  // malformed LORE_CODE_REPOSITORIES turn a read-only poll into a 500.
  return createCodeIndexJobHandlers(await getRuntimeDatabase(), {}).GET(request);
}

export async function POST(request: Request) {
  const repositories = configuredCodeRepositoriesFromEnvironment(process.env);
  return createCodeIndexJobHandlers(await getRuntimeDatabase(), repositories).POST(request);
}
