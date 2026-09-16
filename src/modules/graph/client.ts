import { requestJson } from "@/shared/browser/http";
import type { GraphData } from "./types";

export function readGraph(workspaceId: string, signal?: AbortSignal): Promise<GraphData> {
  return requestJson("/api/graph?limit=5000", {
    workspaceId,
    operation: "GET /api/graph",
    signal,
  });
}
