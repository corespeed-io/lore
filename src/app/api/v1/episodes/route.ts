import { createEpisodeHandlers } from "@/modules/episodes/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createEpisodeHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createEpisodeHandlers(await getRuntimeDatabase()).POST(request);
}
