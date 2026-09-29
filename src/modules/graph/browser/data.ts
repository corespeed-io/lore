"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import useSWR from "swr";
import { hasVisibleText, plainInline, revealHidden } from "@/modules/memories/browser/presentation";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getBrowserClient } from "@/shared/browser/sdk";
import { useRevalidateOnResume } from "@/shared/browser/use-revalidate-on-resume";
import { GRAPH_NODE_LIMIT, type GraphData } from "./types";

/** Labels by source: every Graph read brings up to 5,000, mostly the same as the last. */
const labels = new Map<string, string>();

function nodeLabel(source: string): string {
  let label = labels.get(source);
  if (label === undefined) {
    const words = plainInline(source).trim();
    label = hasVisibleText(words) ? words : revealHidden(source);
    if (labels.size >= 2 * GRAPH_NODE_LIMIT) labels.clear();
    labels.set(source, label);
  }
  return label;
}

export async function readGraph(workspaceId: string, signal?: AbortSignal): Promise<GraphData> {
  const graph = await getBrowserClient().workspace(workspaceId).graph(GRAPH_NODE_LIMIT, signal);
  return {
    // Labels come from Memory content; show their text, not its markup. The browser
    // shows no preview, so a surface that starts to must reduce it the same way.
    // A label whose words show nothing keeps its text as written rather than going blank.
    nodes: graph.nodes.map((node) => ({
      ...node,
      label: nodeLabel(node.label),
    })),
    links: [...graph.links],
    linksTruncated: graph.linksTruncated,
  };
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
