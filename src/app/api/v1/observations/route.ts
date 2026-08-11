import { createObservationHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createObservationHandlers(await getRuntimeDatabase()).GET(request);
}
