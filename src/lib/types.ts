export type MemoryScope = "shared" | "private";

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
  updatedAt: string;
}

export interface Memory {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  createdByAgentId: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
  evidence: string;
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

export interface MemorySourceSummary {
  id: string;
  name: string;
  memoryCount: number;
}
