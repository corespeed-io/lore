import { createCodeDependencyHandlers } from "@/lib/code-http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createCodeDependencyHandlers(await getRuntimeDatabase()).GET(request);
}
