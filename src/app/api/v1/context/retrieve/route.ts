import { createContextRetrievalHandlers } from "@/modules/context/http";
import { getRuntimeDatabase } from "@/server/database/runtime";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/embedding/runtime";

export async function POST(request: Request) {
  return createContextRetrievalHandlers(
    await getRuntimeDatabase(),
    await getRuntimeMemoryModuleOptions(),
  ).POST(request);
}
