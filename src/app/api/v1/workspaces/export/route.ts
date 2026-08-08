import { createPortabilityHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createPortabilityHandlers(await getRuntimeDatabase()).EXPORT(request);
}
