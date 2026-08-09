import { createActorHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createActorHandlers(await getRuntimeDatabase()).GET(request);
}
