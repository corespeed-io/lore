import { createAgentHandlers } from "@/modules/agents/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createAgentHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createAgentHandlers(await getRuntimeDatabase()).POST(request);
}
