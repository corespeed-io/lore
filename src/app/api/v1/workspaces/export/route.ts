import { createPortabilityHandlers } from "@/modules/portability/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createPortabilityHandlers(await getRuntimeDatabase()).EXPORT(request);
}
