import type { MemoryScope } from "@/modules/memories/schemas";

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
