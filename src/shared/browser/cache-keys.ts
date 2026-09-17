import type { MemoryProposalStatus } from "@corespeed/lore-sdk";

export const loreKeys = {
  workspaces: ["lore", "workspaces"] as const,
  memories: (workspaceId: string, pageIndex: number) =>
    ["lore", "memories", workspaceId, pageIndex] as const,
  memory: (workspaceId: string, memoryId: string) =>
    ["lore", "memory", workspaceId, memoryId] as const,
  search: (workspaceId: string, query: string, limit: number) =>
    ["lore", "search", workspaceId, query, limit] as const,
  graph: (workspaceId: string) => ["lore", "graph", workspaceId] as const,
  graphScalePrototype: ["lore", "prototype", "graph-scale"] as const,
  agents: (workspaceId: string) => ["lore", "agents", workspaceId] as const,
  memoryProposals: (workspaceId: string, status: MemoryProposalStatus) =>
    ["lore", "memory-proposals", workspaceId, status] as const,
  memoryCodeEvidence: (workspaceId: string, memoryId: string) =>
    ["lore", "memory-code-evidence", workspaceId, memoryId] as const,
  codeIndexJobs: (workspaceId: string, limit: number) =>
    ["lore", "code-index-jobs", workspaceId, limit] as const,
  observations: (workspaceId: string, observationIds: readonly string[]) =>
    ["lore", "observations", workspaceId, observationIds.join(",")] as const,
  capabilities: (workspaceId: string) => ["lore", "capabilities", workspaceId] as const,
  currentActor: (workspaceId: string) => ["lore", "current-actor", workspaceId] as const,
  readiness: ["lore", "readiness"] as const,
  agentCredentials: (workspaceId: string, agentId: string) =>
    ["lore", "agent-credentials", workspaceId, agentId] as const,
  createWorkspace: ["lore", "mutation", "create-workspace"] as const,
  manageAgents: (workspaceId: string) =>
    ["lore", "mutation", "manage-agents", workspaceId] as const,
  reviewMemoryProposal: (workspaceId: string) =>
    ["lore", "mutation", "review-memory-proposal", workspaceId] as const,
  exportWorkspace: (workspaceId: string) =>
    ["lore", "mutation", "export-workspace", workspaceId] as const,
  validateWorkspaceImport: (workspaceId: string) =>
    ["lore", "mutation", "validate-workspace-import", workspaceId] as const,
  importWorkspace: (workspaceId: string) =>
    ["lore", "mutation", "import-workspace", workspaceId] as const,
  saveMemory: (workspaceId: string) => ["lore", "mutation", "save-memory", workspaceId] as const,
  forgetMemory: (workspaceId: string) =>
    ["lore", "mutation", "forget-memory", workspaceId] as const,
};
