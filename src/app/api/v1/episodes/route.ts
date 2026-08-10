import { createEpisodeHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createEpisodeHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createEpisodeHandlers(await getRuntimeDatabase()).POST(request);
}
