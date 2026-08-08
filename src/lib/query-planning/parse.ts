export function parsePlannedQueries(content: unknown, maximum: number): string[] {
  if (typeof content !== "string") {
    throw new Error("query planner returned no text content");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("query planner returned invalid JSON");
  }
  const queries =
    typeof parsed === "object" && parsed !== null && "queries" in parsed
      ? (parsed as { queries?: unknown }).queries
      : undefined;
  if (!Array.isArray(queries) || queries.some((query) => typeof query !== "string")) {
    throw new Error("query planner returned an invalid queries array");
  }
  return queries
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, maximum);
}
