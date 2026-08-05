import { createMemoryHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";

export async function GET(request: Request) {
  return createMemoryHandlers(await getRuntimeDatabase()).GET(request);
}

export async function POST(request: Request) {
  return createMemoryHandlers(await getRuntimeDatabase()).POST(request);
}
