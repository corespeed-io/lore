export interface GraphNode {
  id: string;
  label: string;
  type: string;
  text?: string;
}
export interface GraphLink {
  source: string;
  target: string;
}
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
export interface PageHit {
  slug: string;
  title?: string;
  type?: string;
  chunk_text?: string;
}
