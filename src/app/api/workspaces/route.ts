import { createWorkspaceHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createWorkspaceHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createWorkspaceHandlers(await getRuntimeDatabase()).POST(request);
}
