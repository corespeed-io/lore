import { LORE_CONTRACT, type MemoryScope } from "@corespeed/lore-sdk";

/**
 * The native Graph read budget. A graph of this size may omit visible Memories,
 * so its counts are lower bounds and a missing reference is not proof of absence.
 */
export const GRAPH_NODE_LIMIT = LORE_CONTRACT.limits.graphNodes;

/** True when the read may have omitted visible Memories. */
export function isGraphCapped(data: GraphData): boolean {
  return data.nodes.length >= GRAPH_NODE_LIMIT;
}

/**
 * True when counts derived from Links (degrees, neighbors, the Link total) are lower
 * bounds: the read may have omitted Memories, or cut its durable Links.
 */
export function areGraphLinksPartial(data: GraphData): boolean {
  return isGraphCapped(data) || data.linksTruncated === true;
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
  /** True when the read cut durable Links. Only the Graph endpoint's reads set it. */
  linksTruncated?: boolean;
}
