import { createMemoryProposalReviewHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeMemoryModuleOptions } from "@/lib/runtime/embedding";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  return createMemoryProposalReviewHandlers(
    await getRuntimeDatabase(),
    await getRuntimeMemoryModuleOptions({ maintenanceNotifications: true }),
  ).POST(request, (await context.params).id);
}
