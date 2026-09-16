import { createCodeDependencyHandlers } from "@/modules/code/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createCodeDependencyHandlers(await getRuntimeDatabase()).GET(request);
}
