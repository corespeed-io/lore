interface CentralityNode {
  id: string;
}

interface CentralityLink {
  source: string;
  target: string;
}

export interface GraphNodeCentrality {
  degree: number;
  gravity: number;
  hub: boolean;
  radius: number;
}

const MAX_HUBS = 8;
const HUB_RATIO = 0.008;

export function graphNodeCentrality(
  nodes: readonly CentralityNode[],
  links: readonly CentralityLink[],
): Map<string, GraphNodeCentrality> {
  const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const link of links) {
    if (link.source === link.target || !neighbors.has(link.source) || !neighbors.has(link.target)) {
      continue;
    }
    neighbors.get(link.source)?.add(link.target);
    neighbors.get(link.target)?.add(link.source);
  }

  const ranked = nodes
    .map((node) => ({ id: node.id, degree: neighbors.get(node.id)?.size ?? 0 }))
    .sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id));
  const orderedDegrees = ranked.map((node) => node.degree).sort((left, right) => left - right);
  const medianDegree = orderedDegrees[Math.floor(orderedDegrees.length / 2)] ?? 0;
  const maximumDegree = ranked[0]?.degree ?? 0;
  const hubLimit = Math.min(MAX_HUBS, Math.max(1, Math.ceil(nodes.length * HUB_RATIO)));
  const hubIds = new Set(
    ranked
      .filter((node) => node.degree >= 3 && node.degree >= Math.max(3, medianDegree * 2))
      .slice(0, hubLimit)
      .map((node) => node.id),
  );
  const gravityDenominator = Math.log1p(maximumDegree);

  return new Map(
    ranked.map((node) => {
      const gravity = gravityDenominator > 0 ? Math.log1p(node.degree) / gravityDenominator : 0;
      return [
        node.id,
        {
          degree: node.degree,
          gravity,
          hub: hubIds.has(node.id),
          radius: 4 + Math.min(12, 2.2 * Math.log2(node.degree + 1)),
        },
      ];
    }),
  );
}
