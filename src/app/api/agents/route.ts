import { createAgentHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createAgentHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createAgentHandlers(await getRuntimeDatabase()).POST(request);
}
