import { createPortabilityHandlers } from "@/modules/portability/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function POST(request: Request) {
  return createPortabilityHandlers(await getRuntimeDatabase()).IMPORT(request);
}
