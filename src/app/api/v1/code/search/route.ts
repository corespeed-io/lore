import { createCodeSearchHandlers } from "@/lib/code-http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createCodeSearchHandlers(await getRuntimeDatabase()).GET(request);
}
