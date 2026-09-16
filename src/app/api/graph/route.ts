import { createGraphHandlers } from "@/modules/graph/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createGraphHandlers(await getRuntimeDatabase()).GET(request);
}
