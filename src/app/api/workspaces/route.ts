import { createWorkspaceHandlers } from "@/modules/workspaces/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createWorkspaceHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createWorkspaceHandlers(await getRuntimeDatabase()).POST(request);
}
