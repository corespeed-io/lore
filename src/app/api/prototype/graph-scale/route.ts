import { readGraphScaleBenchmark } from "./read-benchmark";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const startedAt = performance.now();
  try {
    const graph = await readGraphScaleBenchmark();
    return Response.json(graph, {
      headers: {
        "cache-control": "private, no-store",
        "server-timing": `benchmark-db;dur=${(performance.now() - startedAt).toFixed(1)}`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "benchmark read failed" },
      { status: 503 },
    );
  }
}
