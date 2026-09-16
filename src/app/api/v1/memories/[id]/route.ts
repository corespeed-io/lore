import { createMemoryByIdHandlers } from "@/modules/memories/http";
import { getRuntimeDatabase } from "@/server/database/runtime";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/embedding/runtime";

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
    await getRuntimeMemoryModuleOptions({ maintenanceNotifications: true }),
  ).PATCH(request, (await context.params).id);
}

export async function DELETE(request: Request, context: RouteContext) {
  return createMemoryByIdHandlers(await getRuntimeDatabase()).DELETE(
    request,
    (await context.params).id,
  );
}
