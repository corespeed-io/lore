import type { MemoryScope } from "@corespeed/lore-sdk";

/**
 * The native Graph read budget. A graph of this size may omit visible Memories,
 * so its counts are lower bounds and a missing reference is not proof of absence.
 */
export const GRAPH_NODE_LIMIT = 5_000;

export function isGraphCapped(data: GraphData): boolean {
  return data.nodes.length >= GRAPH_NODE_LIMIT;
}

export interface GraphNode {
  id: string;
  reference: string;
  label: string;
  type: string;
  preview: string;
  scope: MemoryScope;
  updatedAt: string;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
