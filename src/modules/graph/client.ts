import { getBrowserClient } from "@/shared/browser/sdk";
import type { GraphData } from "./types";

export async function readGraph(workspaceId: string, signal?: AbortSignal): Promise<GraphData> {
  const graph = await getBrowserClient().workspace(workspaceId).graph(5_000, signal);
  return { nodes: [...graph.nodes], links: [...graph.links] };
}
