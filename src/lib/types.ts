export interface GraphNode {
  id: string;
  label: string;
  type: string;
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
  score?: number;
  evidence?: string;
  updated_at?: string;
}
export interface SourceInfo {
  id: string;
  name: string;
  page_count: number;
}
export interface SalientPage {
  slug: string;
  title: string;
  type: string;
  updated_at: string;
  source_id?: string;
}
