import { createContextRetrievalHandlers } from "@/lib/context-http";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeMemoryModuleOptions } from "@/lib/runtime/embedding";

export async function POST(request: Request) {
  return createContextRetrievalHandlers(
    await getRuntimeDatabase(),
    await getRuntimeMemoryModuleOptions(),
  ).POST(request);
}
