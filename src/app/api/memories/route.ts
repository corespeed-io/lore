import { createMemoryHandlers } from "@/modules/memories/http";
import { getRuntimeDatabase } from "@/server/database/runtime";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/embedding/runtime";

export async function GET(request: Request) {
  return createMemoryHandlers(
    await getRuntimeDatabase(),
    await getRuntimeMemoryModuleOptions(),
  ).GET(request);
}

export async function POST(request: Request) {
  return createMemoryHandlers(
    await getRuntimeDatabase(),
    await getRuntimeMemoryModuleOptions({ maintenanceNotifications: true }),
  ).POST(request);
}
