import { createMemoryByIdHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeMemoryModuleOptions } from "@/lib/runtime/embedding";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  return createMemoryByIdHandlers(await getRuntimeDatabase()).GET(
    request,
    (await context.params).id,
  );
}

export async function PATCH(request: Request, context: RouteContext) {
  return createMemoryByIdHandlers(
    await getRuntimeDatabase(),
    await getRuntimeMemoryModuleOptions(),
  ).PATCH(request, (await context.params).id);
}

export async function DELETE(request: Request, context: RouteContext) {
  return createMemoryByIdHandlers(await getRuntimeDatabase()).DELETE(
    request,
    (await context.params).id,
  );
}
