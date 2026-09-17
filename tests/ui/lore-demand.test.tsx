// @vitest-environment happy-dom

import type { Memory } from "@corespeed/lore-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Cache, SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readGraph } from "@/modules/graph/client";
import { useLoreGraph } from "@/modules/graph/hooks";
import { listMemories } from "@/modules/memories/client";
import { useLoreMemories } from "@/modules/memories/hooks";

vi.mock("@/modules/graph/client", () => ({ readGraph: vi.fn() }));
vi.mock("@/modules/memories/client", () => ({
  listMemories: vi.fn(),
  getMemory: vi.fn(),
  searchMemories: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
let cache: Cache;
let currentMemories: ReturnType<typeof useLoreMemories>;
let currentGraph: ReturnType<typeof useLoreGraph>;

function memory(index: number, workspaceId = "workspace-a"): Memory {
  return {
    id: `${workspaceId}-memory-${index}`,
    workspaceId,
    ownerUserId: "owner",
    createdByAgentId: null,
    scope: "shared",
    content: `Memory ${index}`,
    metadata: {},
    version: 1,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function fullPage(offset: number, workspaceId = "workspace-a"): Memory[] {
  return Array.from({ length: 100 }, (_, index) => memory(offset + index, workspaceId));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function Harness({ workspaceId, enabled }: { workspaceId: string; enabled: boolean }) {
  currentMemories = useLoreMemories(workspaceId, enabled);
  currentGraph = useLoreGraph(workspaceId, enabled);
  return null;
}

async function render(enabled: boolean, workspaceId = "workspace-a"): Promise<void> {
  await act(async () => {
    root.render(
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
          errorRetryInterval: 1,
        }}
      >
        <Harness workspaceId={workspaceId} enabled={enabled} />
      </SWRConfig>,
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await settle();
    assertion();
  });
}

function requestedPages(): Array<[string, number | undefined]> {
  return vi
    .mocked(listMemories)
    .mock.calls.map(([workspaceId, options]) => [workspaceId, options?.offset]);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  vi.mocked(listMemories).mockResolvedValue([memory(0)]);
  vi.mocked(readGraph).mockResolvedValue({ nodes: [], links: [] });
  cache = new Map();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("paused hooks retain their cache, ignore bound refreshes, and refresh once on reentry", async () => {
  await render(false);
  expect(listMemories).not.toHaveBeenCalled();
  expect(readGraph).not.toHaveBeenCalled();
  expect(currentMemories.isLoading).toBe(false);
  expect(currentGraph.isLoading).toBe(false);

  await render(true);
  await eventually(() => expect(currentMemories.memories).toHaveLength(1));
  expect(listMemories).toHaveBeenCalledTimes(1);
  expect(readGraph).toHaveBeenCalledTimes(1);
  const memories = currentMemories.data;
  const graph = currentGraph.data;

  await render(false);
  await act(async () => {
    await Promise.all([currentMemories.mutate(), currentGraph.mutate()]);
  });
  expect(currentMemories.data).toBe(memories);
  expect(currentGraph.data).toBe(graph);
  expect(listMemories).toHaveBeenCalledTimes(1);
  expect(readGraph).toHaveBeenCalledTimes(1);

  await render(true);
  await eventually(() => expect(listMemories).toHaveBeenCalledTimes(2));
  expect(readGraph).toHaveBeenCalledTimes(2);
  await render(true);
  await settle();
  expect(listMemories).toHaveBeenCalledTimes(2);
  expect(readGraph).toHaveBeenCalledTimes(2);
});

test("resuming a full paused page refreshes it once before advancing pagination", async () => {
  const first = deferred<Memory[]>();
  const refresh = deferred<Memory[]>();
  vi.mocked(listMemories)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(refresh.promise)
    .mockResolvedValue([]);

  await render(true);
  await render(false);
  await act(async () => first.resolve(fullPage(0)));
  await eventually(() => expect(currentMemories.memories).toHaveLength(100));
  expect(requestedPages()).toEqual([["workspace-a", 0]]);
  expect(currentMemories.isLoadingMore).toBe(false);

  await render(true);
  await settle();
  expect(requestedPages()).toEqual([
    ["workspace-a", 0],
    ["workspace-a", 0],
  ]);
  await act(async () => refresh.resolve(fullPage(0)));
  await eventually(() => expect(currentMemories.isLoadingMore).toBe(false));
  expect(requestedPages()).toEqual([
    ["workspace-a", 0],
    ["workspace-a", 0],
    ["workspace-a", 100],
  ]);
});

test.each(["none", "refresh", "patch"])(
  "rapid reentry waits for the in-flight batch before refreshing (paused mutation: %s)",
  async (pausedMutation) => {
    const oldSecondPage = deferred<Memory[]>();
    const refreshedFirstPage = deferred<Memory[]>();
    const finalPage = deferred<Memory[]>();
    const oldGraph = deferred<Awaited<ReturnType<typeof readGraph>>>();
    const freshSecondPage = fullPage(100).map((entry) => ({ ...entry, version: 2 }));
    vi.mocked(readGraph).mockReturnValueOnce(oldGraph.promise);
    vi.mocked(listMemories)
      .mockResolvedValueOnce(fullPage(0))
      .mockReturnValueOnce(oldSecondPage.promise)
      .mockReturnValueOnce(refreshedFirstPage.promise)
      .mockResolvedValueOnce(freshSecondPage)
      .mockReturnValueOnce(finalPage.promise);

    await render(true);
    await eventually(() => expect(requestedPages()).toHaveLength(2));
    // Mutation handlers may retain callbacks from before the route was paused.
    const mutateMemories = currentMemories.mutate;
    const mutateGraph = currentGraph.mutate;
    await render(false);
    if (pausedMutation === "refresh") {
      await act(async () => {
        await Promise.all([mutateMemories(), mutateGraph()]);
      });
    } else if (pausedMutation === "patch") {
      await act(async () => {
        await Promise.all([
          mutateMemories(
            (pages) => pages?.map((page) => page.map((entry) => ({ ...entry, version: 3 }))),
            { revalidate: true },
          ),
          mutateGraph({ nodes: [], links: [] }, { revalidate: true }),
        ]);
      });
      expect(currentMemories.data?.[0]?.[0]?.version).toBe(3);
      expect(currentGraph.data).toEqual({ nodes: [], links: [] });
    }
    await render(true);
    await settle();
    expect(requestedPages()).toEqual([
      ["workspace-a", 0],
      ["workspace-a", 100],
    ]);
    expect(readGraph).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldSecondPage.resolve(fullPage(100));
      oldGraph.resolve({ nodes: [], links: [] });
    });
    await eventually(() => expect(requestedPages()).toHaveLength(3));
    expect(requestedPages().at(-1)).toEqual(["workspace-a", 0]);
    expect(readGraph).toHaveBeenCalledTimes(2);

    await act(async () => refreshedFirstPage.resolve(fullPage(0)));
    await eventually(() => expect(requestedPages()).toHaveLength(5));
    expect(requestedPages()).toEqual([
      ["workspace-a", 0],
      ["workspace-a", 100],
      ["workspace-a", 0],
      ["workspace-a", 100],
      ["workspace-a", 200],
    ]);
    await act(async () => finalPage.resolve([]));
    await eventually(() => expect(currentMemories.isLoadingMore).toBe(false));
    expect(currentMemories.data?.[1]).toEqual(freshSecondPage);
    expect(currentMemories.memories).toHaveLength(200);
    expect(requestedPages()).toHaveLength(5);
  },
);

test("pausing a multi-page refresh stops its next request and keeps existing pages", async () => {
  vi.mocked(listMemories).mockImplementation(async (_workspaceId, options) =>
    options?.offset === 0 ? fullPage(0) : [memory(100)],
  );
  await render(true);
  await eventually(() => expect(currentMemories.memories).toHaveLength(101));
  const pages = currentMemories.data;
  const refresh = deferred<Memory[]>();
  vi.mocked(listMemories).mockReturnValueOnce(refresh.promise);
  let refreshing!: ReturnType<typeof currentMemories.mutate>;
  await act(async () => {
    refreshing = currentMemories.mutate();
  });
  expect(requestedPages()).toHaveLength(3);

  await render(false);
  await act(async () => {
    refresh.resolve(fullPage(0));
    await refreshing;
  });
  await settle();
  expect(requestedPages()).toHaveLength(3);
  expect(currentMemories.data).toBe(pages);
  expect(currentMemories.error).toBeUndefined();
  expect(currentMemories.isLoadingMore).toBe(false);
  expect(currentMemories.isValidating).toBe(false);

  await render(true);
  await eventually(() => expect(requestedPages()).toHaveLength(5));
  expect(currentMemories.error).toBeUndefined();
});

test("switching Workspaces stops the old page batch without exposing its cached data", async () => {
  vi.mocked(listMemories).mockImplementation(async (workspaceId, options) =>
    options?.offset === 0 ? fullPage(0, workspaceId) : [memory(100, workspaceId)],
  );
  await render(true);
  await eventually(() => expect(currentMemories.memories).toHaveLength(101));
  const refresh = deferred<Memory[]>();
  const nextWorkspace = deferred<Memory[]>();
  const nextGraph = deferred<Awaited<ReturnType<typeof readGraph>>>();
  vi.mocked(readGraph).mockReturnValueOnce(nextGraph.promise);
  vi.mocked(listMemories)
    .mockReturnValueOnce(refresh.promise)
    .mockReturnValueOnce(nextWorkspace.promise);
  let refreshing!: ReturnType<typeof currentMemories.mutate>;
  await act(async () => {
    refreshing = currentMemories.mutate();
  });

  await render(true, "workspace-b");
  expect(currentMemories.memories).toEqual([]);
  expect(currentGraph.data).toBeUndefined();
  expect(currentMemories.isLoading).toBe(true);
  await act(async () => {
    refresh.resolve(fullPage(0));
    await refreshing;
  });
  await settle();
  expect(requestedPages()).toEqual([
    ["workspace-a", 0],
    ["workspace-a", 100],
    ["workspace-a", 0],
    ["workspace-b", 0],
  ]);
  await act(async () => nextWorkspace.resolve([memory(0, "workspace-b")]));
  await act(async () => nextGraph.resolve({ nodes: [], links: [] }));
  await eventually(() => expect(currentMemories.memories).toEqual([memory(0, "workspace-b")]));
  expect(currentMemories.error).toBeUndefined();
});
