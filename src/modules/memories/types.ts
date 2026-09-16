import type { Memory } from "./schemas";

export interface MemorySearchResult {
  memory: Memory;
  score: number;
  rerankScore?: number;
  evidence: string;
}

export interface MemorySourceSummary {
  id: string;
  name: string;
  memoryCount: number;
}
