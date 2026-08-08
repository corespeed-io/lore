import { createPortabilityHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function POST(request: Request) {
  return createPortabilityHandlers(await getRuntimeDatabase()).IMPORT(request);
}
