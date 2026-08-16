import { createCodeIndexJobHandlers } from "@/lib/code-http";
import { configuredCodeRepositoriesFromEnvironment } from "@/lib/code-index-queue";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function POST(request: Request) {
  const repositories = configuredCodeRepositoriesFromEnvironment(process.env);
  return createCodeIndexJobHandlers(await getRuntimeDatabase(), repositories).POST(request);
}
