"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getBrowserClient } from "@/shared/browser/sdk";
import { useRevalidateOnResume } from "@/shared/browser/use-revalidate-on-resume";
import type { GraphData } from "./types";

export async function readGraph(workspaceId: string, signal?: AbortSignal): Promise<GraphData> {
  const graph = await getBrowserClient().workspace(workspaceId).graph(5_000, signal);
  return { nodes: [...graph.nodes], links: [...graph.links] };
}

export function useLoreGraph(workspaceId: string, enabled = true) {
  const demand = useRef(enabled);
  useLayoutEffect(() => {
    demand.current = enabled;
    return () => {
      demand.current = false;
    };
  }, [enabled]);
  const swr = useSWR(
    workspaceId ? loreKeys.graph(workspaceId) : null,
    ([, , scopedWorkspaceId]) => readGraph(scopedWorkspaceId),
    { isPaused: () => !enabled },
  );
  useRevalidateOnResume(workspaceId, enabled, swr.isValidating, swr.mutate);
  const mutate = useCallback<typeof swr.mutate>(
    (...args) => {
      if (demand.current) return swr.mutate(...args);
      // Keep an in-flight request tracked while allowing paused cache patches.
      if (!args.length) return Promise.resolve(swr.data);
      const [data, options] = args;
      return swr.mutate(data, {
        ...(typeof options === "object" ? options : {}),
        revalidate: false,
      });
    },
    [swr.data, swr.mutate],
  );

  return {
    ...swr,
    mutate,
    error: enabled ? swr.error : undefined,
    isLoading: enabled && Boolean(workspaceId) && !swr.data && !swr.error,
    isValidating: enabled && swr.isValidating,
  };
}
