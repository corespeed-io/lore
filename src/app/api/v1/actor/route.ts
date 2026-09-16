import { createActorHandlers } from "@/modules/identity/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createActorHandlers(await getRuntimeDatabase()).GET(request);
}
