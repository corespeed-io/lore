import { createMemoryProposalHandlers } from "@/modules/proposals/http";
import { getRuntimeDatabase } from "@/server/database/runtime";

export async function GET(request: Request) {
  return createMemoryProposalHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createMemoryProposalHandlers(await getRuntimeDatabase()).POST(request);
}
