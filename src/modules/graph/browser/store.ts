import type { GraphData, GraphNode } from "./types";

/** The loaded Graph indexed for Memory detail: nodes, wikilink references, and adjacency. */
export interface GraphStore {
  byId: Record<string, GraphNode>;
  /** A reference resolves to a node only when exactly one visible node carries it. */
  byReference: Record<string, string>;
  adj: Record<string, Set<string>>;
}

export interface GraphNeighbor {
  id: string;
  label: string;
}

/**
 * Index one Graph read. A node answers to its id and its Memory Reference; a
 * reference two nodes share is ambiguous and resolves to neither, so a wikilink
 * never guesses between them.
 */
export function buildGraphStore(data: GraphData): GraphStore {
  const byId: GraphStore["byId"] = {};
  const byReference = Object.create(null) as GraphStore["byReference"];
  const ambiguousReferences = new Set<string>();
  const adj: GraphStore["adj"] = {};
  for (const node of data.nodes) {
    byId[node.id] = node;
    adj[node.id] = new Set([node.id]);
    for (const reference of new Set([node.id, node.reference])) {
      if (!reference || ambiguousReferences.has(reference)) continue;
      const existing = byReference[reference];
      if (existing && existing !== node.id) {
        delete byReference[reference];
        ambiguousReferences.add(reference);
      } else {
        byReference[reference] = node.id;
      }
    }
  }
  for (const link of data.links) {
    if (!adj[link.source]) adj[link.source] = new Set();
    if (!adj[link.target]) adj[link.target] = new Set();
    adj[link.source]?.add(link.target);
    adj[link.target]?.add(link.source);
  }
  return { byId, byReference, adj };
}

/** A node's direct neighbors in the loaded Graph, never itself. */
export function graphNeighbors(graph: GraphStore | null, id: string): GraphNeighbor[] {
  const adjacent = graph?.adj[id];
  if (!graph || !adjacent) return [];
  return [...adjacent]
    .filter((neighborId) => neighborId !== id)
    .map((neighborId) => ({ id: neighborId, label: graph.byId[neighborId]?.label ?? neighborId }));
}
