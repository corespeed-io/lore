import type { MemoryScope } from "@corespeed/lore-sdk";
import { typeSort } from "@/modules/memories/browser/presentation";
import { typeColor } from "@/shared/ui/colors";
import type { GraphNode } from "./types";

type LegendNode = Pick<GraphNode, "type" | "scope">;

export type GraphLegendFilter =
  | { kind: "type"; value: string }
  | { kind: "scope"; value: MemoryScope };

export interface GraphLegend {
  types: { type: string; color: string }[];
  /**
   * Explicit scope entries. Empty for an untyped graph, whose node types are
   * already `shared`/`private` so the palette and its labels name scope. Once any
   * node carries a configured type the palette encodes type instead, and scope
   * needs its own text (DESIGN.md §10: never color alone).
   */
  scopes: { scope: MemoryScope; count: number }[];
}

function nodeType(node: LegendNode): string {
  return node.type || "other";
}

/** A node's configured type, or null when its type is only its scope fallback. */
export function graphNodeConfiguredType(node: LegendNode): string | null {
  const type = nodeType(node);
  return type === node.scope ? null : type;
}

export function graphLegend(nodes: readonly LegendNode[]): GraphLegend {
  const types = [...new Set(nodes.map(nodeType))]
    .sort(typeSort)
    .map((type) => ({ type, color: typeColor(type) }));
  if (!nodes.some((node) => graphNodeConfiguredType(node) !== null)) return { types, scopes: [] };
  const counts: Record<MemoryScope, number> = { shared: 0, private: 0 };
  for (const node of nodes) counts[node.scope] += 1;
  const scopes = (["shared", "private"] as const)
    .filter((scope) => counts[scope] > 0)
    .map((scope) => ({ scope, count: counts[scope] }));
  return { types, scopes };
}

export function matchesGraphLegendFilter(node: LegendNode, filter: GraphLegendFilter): boolean {
  return filter.kind === "type" ? nodeType(node) === filter.value : node.scope === filter.value;
}

export function isGraphLegendFilter(
  filter: GraphLegendFilter | null,
  kind: GraphLegendFilter["kind"],
  value: string,
): boolean {
  return filter?.kind === kind && filter.value === value;
}
