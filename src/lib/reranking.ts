export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankResult {
  documentId: string;
  score: number;
}

export interface RerankingProvider {
  provider: string;
  model: string;
  revision?: string;
  instruction?: string;
  transport?: string;
  decoding?: Record<string, unknown>;
  keepAlive?: number | string;
  rerank(input: {
    query: string;
    documents: RerankDocument[];
    limit: number;
  }): Promise<RerankResult[]>;
}
