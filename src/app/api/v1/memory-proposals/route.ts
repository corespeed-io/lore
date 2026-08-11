import { createMemoryProposalHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createMemoryProposalHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createMemoryProposalHandlers(await getRuntimeDatabase()).POST(request);
}
