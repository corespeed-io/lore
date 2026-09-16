import { createCodeSearchHandlers } from "@/modules/code/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createCodeSearchHandlers(await getRuntimeDatabase()).GET(request);
}
