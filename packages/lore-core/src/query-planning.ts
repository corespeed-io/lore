export interface QueryPlanningProvider {
  provider: string;
  model: string;
  revision?: string;
  transport?: string;
  instruction?: string;
  decoding?: Record<string, unknown>;
  keepAlive?: string | number;
  plan(input: { query: string; maxQueries: number }): Promise<string[]>;
}
