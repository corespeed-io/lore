import type { MemoryScope } from "@corespeed/lore-sdk";

export type EpisodeKind = "conversation" | "workflow" | "document" | "event";

export type ObservationKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "document_fragment"
  | "event";

export interface Observation {
  id: string;
  workspaceId: string;
  episodeId: string;
  ordinal: number;
  kind: ObservationKind;
  observedAt: string;
  payloadSha256: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EpisodeSummary {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  recordedByActorKind: "human" | "agent";
  recordedByAgentId: string | null;
  kind: EpisodeKind;
  scope: MemoryScope;
  startedAt: string;
  endedAt: string;
  observationCount: number;
  createdAt: string;
}

export interface Episode extends EpisodeSummary {
  observations: Observation[];
}
