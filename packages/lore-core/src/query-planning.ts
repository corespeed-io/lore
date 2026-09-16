/** Expand a question without accessing Memory content or changing authorization. */
export interface QueryPlanningProvider {
  plan(input: { query: string; maxQueries: number }): Promise<string[]>;
}
