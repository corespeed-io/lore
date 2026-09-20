"use client";

import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { recordRequest } from "@/shared/browser/request-log";
import type { GraphData } from "./types";

// Development-only HTTP measurement, outside Lore's public API/SDK contract.
// Read the original response text to measure the decoded payload, including whitespace.
export async function readGraphScalePrototype(signal?: AbortSignal): Promise<{
  data: GraphData;
  milliseconds: number;
  bytes: number;
}> {
  const startedAt = performance.now();
  const at = Date.now();
  try {
    const response = await fetch("/api/prototype/graph-scale", { signal });
    if (!response.ok) throw new Error(`Graph benchmark request failed (${response.status})`);
    const body = await response.text();
    const data = JSON.parse(body) as GraphData;
    const milliseconds = performance.now() - startedAt;
    recordRequest({
      operation: "GET /api/prototype/graph-scale",
      at,
      latencyMs: milliseconds,
      ok: true,
    });
    return { data, milliseconds, bytes: new TextEncoder().encode(body).byteLength };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    recordRequest({
      operation: "GET /api/prototype/graph-scale",
      at,
      latencyMs: performance.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function useGraphScalePrototype() {
  return useSWR(loreKeys.graphScalePrototype, () => readGraphScalePrototype(), {
    // Keep one dataset stable during a renderer comparison.
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });
}
