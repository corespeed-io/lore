import { createGraphHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createGraphHandlers(await getRuntimeDatabase()).GET(request);
}
