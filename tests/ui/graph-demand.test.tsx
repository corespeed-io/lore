// @vitest-environment happy-dom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { type Cache, SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GraphView } from "@/modules/graph/components/GraphView";
import type { GraphInstance } from "@/modules/graph/rendering/graph";
import type { GraphData } from "@/modules/graph/types";
import { clearRequestLog } from "@/shared/browser/request-log";

const renderer = vi.hoisted(() => ({
  mount: vi.fn(),
  unmount: vi.fn(),
  instance: {
    destroy: vi.fn(),
    fit: vi.fn(),
    highlight: vi.fn(),
    resetZoom: vi.fn(),
    select: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  },
}));

vi.mock("@/modules/graph/components/WorkerCanvasGraph", async () => {
  const { useEffect } = await import("react");
  return {
    WorkerCanvasGraph({
      registerGraphInstance,
    }: {
      registerGraphInstance: (instance: GraphInstance | null) => void;
    }) {
      useEffect(() => {
        renderer.mount();
        registerGraphInstance(renderer.instance);
        return () => {
          registerGraphInstance(null);
          renderer.instance.destroy();
          renderer.unmount();
        };
      }, [registerGraphInstance]);
      return <canvas data-testid="graph-canvas" />;
    },
  };
});

const workspaceId = "10000000-0000-4000-8000-000000000001";
const memoryId = "20000000-0000-4000-8000-000000000001";
const graph: GraphData = {
  nodes: [
    {
      id: memoryId,
      reference: "launch-decision",
      label: "Launch decision",
      type: "decision",
      preview: "We chose a gradual release.",
      scope: "shared",
      updatedAt: "2026-09-16T00:00:00.000Z",
    },
  ],
  links: [],
};

let container: HTMLDivElement;
let root: Root;
let cache: Cache;
const fetcher = vi.fn<typeof globalThis.fetch>();
const onOpen = vi.fn();

function render(active: boolean) {
  act(() => {
    root.render(
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          focusThrottleInterval: 0,
          errorRetryCount: 0,
        }}
      >
        <div hidden={!active}>
          <GraphView workspaceId={workspaceId} active={active} data={graph} onOpen={onOpen} />
        </div>
      </SWRConfig>,
    );
  });
}

function searchInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(".graph-search");
  if (!input) throw new Error("Graph search input is missing");
  return input;
}

function type(query: string) {
  const input = searchInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function revalidate(event: "focus" | "online") {
  await advance(1);
  act(() => window.dispatchEvent(new Event(event)));
  await advance(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  vi.clearAllMocks();
  fetcher.mockImplementation(async () =>
    Response.json([{ memory: { id: memoryId }, score: 1, evidence: "A gradual release." }]),
  );
  cache = new Map();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearRequestLog();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("hiding before debounce cancels HTTP demand and showing searches the current query once", async () => {
  const canvas = container.querySelector("canvas");
  const input = searchInput();
  type("old question");
  await advance(100);
  type("current question");
  render(false);
  await advance(1_000);
  expect(fetcher).not.toHaveBeenCalled();
  expect(searchInput()).toBe(input);
  expect(searchInput().value).toBe("current question");

  render(true);
  await advance(249);
  expect(fetcher).not.toHaveBeenCalled();
  await advance(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [request, init] = fetcher.mock.calls[0];
  const url = new URL(String(request));
  expect(url.pathname).toBe("/api/v1/memories");
  expect(url.searchParams.get("q")).toBe("current question");
  expect(url.searchParams.get("limit")).toBe("12");
  expect(new Headers(init?.headers).get("x-lore-workspace-id")).toBe(workspaceId);
  expect(container.querySelector("canvas")).toBe(canvas);
  expect(renderer.mount).toHaveBeenCalledTimes(1);
  expect(renderer.unmount).not.toHaveBeenCalled();
});

test("hidden loaded searches ignore focus and reconnect while retaining renderer and filters", async () => {
  type("release plan");
  await advance(250);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(renderer.instance.highlight).toHaveBeenLastCalledWith(new Set([memoryId]));

  // Prove the real SWR focus and reconnect listeners can request while this view is active.
  await revalidate("focus");
  expect(fetcher).toHaveBeenCalledTimes(2);
  await revalidate("online");
  expect(fetcher).toHaveBeenCalledTimes(3);
  const input = searchInput();
  const canvas = container.querySelector("canvas");
  const typeButton = container.querySelector<HTMLButtonElement>('[title="Filter to decision"]');
  if (!typeButton) throw new Error("Graph type filter is missing");
  act(() => typeButton.click());

  render(false);
  await revalidate("focus");
  await revalidate("online");
  await advance(1_000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(searchInput()).toBe(input);
  expect(input.value).toBe("release plan");
  expect(typeButton.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("canvas")).toBe(canvas);
  expect(renderer.mount).toHaveBeenCalledTimes(1);
  expect(renderer.unmount).not.toHaveBeenCalled();
  expect(renderer.instance.destroy).not.toHaveBeenCalled();

  render(true);
  expect(searchInput()).toBe(input);
  expect(input.value).toBe("release plan");
  expect(typeButton.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("canvas")).toBe(canvas);
  expect(renderer.mount).toHaveBeenCalledTimes(1);
  expect(renderer.unmount).not.toHaveBeenCalled();

  act(() => root.render(null));
  expect(renderer.unmount).toHaveBeenCalledTimes(1);
  expect(renderer.instance.destroy).toHaveBeenCalledTimes(1);
});
