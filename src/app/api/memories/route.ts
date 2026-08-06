import { createMemoryHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeMemoryModuleOptions } from "@/lib/runtime/embedding";

export async function GET(request: Request) {
  return createMemoryHandlers(await getRuntimeDatabase(), getRuntimeMemoryModuleOptions()).GET(
    request,
  );
}

export async function POST(request: Request) {
  return createMemoryHandlers(await getRuntimeDatabase(), getRuntimeMemoryModuleOptions()).POST(
    request,
  );
}
