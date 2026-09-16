export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankResult {
  documentId: string;
  score: number;
}

/** Score only the authorized evidence passages selected by the engine. */
export interface RerankingProvider {
  rerank(input: {
    query: string;
    documents: RerankDocument[];
    limit: number;
  }): Promise<RerankResult[]>;
}
