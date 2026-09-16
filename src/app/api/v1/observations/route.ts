import { createObservationHandlers } from "@/modules/episodes/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createObservationHandlers(await getRuntimeDatabase()).GET(request);
}
