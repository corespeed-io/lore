// @vitest-environment happy-dom

import type { Memory, WorkspaceSummary } from "@corespeed/lore-sdk";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearRequestLog } from "@/shared/browser/request-log";
import { App } from "@/shell/App";

// Canvas/Worker rendering is unrelated to HTTP demand. All other components,
// domain hooks, browser clients, SWR, and the SDK execute normally.
vi.mock("@/modules/graph/components/GraphView", () => ({
  GraphView: () => <div data-testid="graph-renderer" />,
}));

const WORKSPACE_A = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "20000000-0000-4000-8000-000000000002";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const MEMORY_ID = "40000000-0000-4000-8000-000000000001";
const DATE = "2026-09-16T00:00:00.000Z";
const workspaces: WorkspaceSummary[] = [WORKSPACE_A, WORKSPACE_B].map((id, index) => ({
  id,
  name: `Workspace ${index + 1}`,
  role: "owner",
  createdAt: DATE,
  updatedAt: DATE,
}));

interface RecordedRequest {
  url: URL;
  workspaceId: string | null;
}

let container: HTMLDivElement;
let root: Root;
let requests: RecordedRequest[];
let unexpectedRequests: string[];
let browseResponse: (request: RecordedRequest) => Response | Promise<Response>;
let saveResponse: (request: Request) => Response | Promise<Response>;

function memory(index = 1): Memory {
  return {
    id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    workspaceId: WORKSPACE_A,
    ownerUserId: USER_ID,
    createdByAgentId: null,
    content: `Memory body ${index}`,
    metadata: { title: `Memory ${index}`, type: "note" },
    scope: "shared",
    version: 1,
    createdAt: DATE,
    updatedAt: DATE,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function recorded(path: string): RecordedRequest[] {
  return requests.filter(({ url }) => url.pathname === path);
}

function browseRequests(): RecordedRequest[] {
  return recorded("/api/v1/memories").filter(({ url }) => !url.searchParams.has("q"));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await settle();
    assertion();
  });
}

async function render(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  const cache = new Map();
  await act(async () => {
    root.render(
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          focusThrottleInterval: 0,
          shouldRetryOnError: false,
        }}
      >
        <App appTitle="Lore" appSubtitle="Test deployment" />
      </SWRConfig>,
    );
  });
  await eventually(() => expect(container.querySelector("#workspace-picker")).not.toBeNull());
}

async function navigate(label: string): Promise<void> {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Primary"] button'),
  ].find((element) => element.textContent?.trim() === label);
  expect(button, `Navigation button ${label}`).toBeDefined();
  await act(async () => button?.click());
  await settle();
}

async function focusWindow(): Promise<void> {
  await act(async () => window.dispatchEvent(new Event("focus")));
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  clearRequestLog();
  requests = [];
  unexpectedRequests = [];
  browseResponse = () => json([]);
  saveResponse = () => json(memory());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  vi.stubGlobal(
    "fetch",
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
        const request = new Request(input, init);
        const entry = {
          url: new URL(request.url),
          workspaceId: request.headers.get("x-lore-workspace-id"),
        };
        requests.push(entry);
        switch (entry.url.pathname) {
          case "/api/v1/workspaces":
            return json(workspaces);
          case "/api/v1/agents":
          case "/api/v1/memory-proposals":
          case "/api/v1/code/index-jobs":
          case `/api/v1/memories/${MEMORY_ID}/code-evidence`:
            return json([]);
          case "/api/v1/actor":
            return json({ userId: USER_ID, workspaceId: entry.workspaceId });
          case "/api/v1/capabilities":
            return json({
              apiVersion: "v1",
              schemaRevision: 3,
              deploymentId: WORKSPACE_A,
              features: {},
              activeEmbeddingGeneration: null,
              memoryChunking: {
                revision: "lore-memory-chunking-v2",
                maximumCharacters: 1200,
                overlapCharacters: 0,
              },
              limits: { workspaceArchiveMemories: 10000, workspaceArchiveLinks: 50000 },
            });
          case "/readyz":
            return json({
              status: "ready",
              components: {
                database: "ok",
                schema: "ok",
                rlsRole: "ok",
                vector: "ok",
                embedding: "disabled",
              },
            });
          case "/api/v1/graph":
            return json({
              nodes: [
                {
                  id: MEMORY_ID,
                  reference: MEMORY_ID,
                  label: "Memory 1",
                  type: "note",
                  preview: "Memory body 1",
                  scope: "shared",
                  updatedAt: DATE,
                },
              ],
              links: [],
            });
          case "/api/v1/memories":
            if (request.method === "POST") return saveResponse(request);
            return entry.url.searchParams.has("q") ? json([]) : browseResponse(entry);
          case `/api/v1/memories/${MEMORY_ID}`:
            return json(memory());
          default:
            unexpectedRequests.push(entry.url.pathname);
            throw new Error(`Unexpected HTTP request: ${entry.url.pathname}`);
        }
      },
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  expect(unexpectedRequests).toEqual([]);
});

test("Memory editor counts Unicode characters and displays server validation failures", async () => {
  await render("/memories");
  const createButton = container.querySelector<HTMLButtonElement>(".sidebar-new-memory");
  expect(createButton).not.toBeNull();
  await act(async () => createButton?.click());
  const textarea = container.querySelector<HTMLTextAreaElement>("#memory-editor-content");
  const submit = container.querySelector<HTMLButtonElement>(".memory-editor [type=submit]");
  if (!textarea || !submit) throw new Error("Memory editor not mounted");

  async function enter(content: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        content,
      );
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  await enter("😀".repeat(32_000));
  expect(submit.disabled).toBe(false);
  expect(textarea.getAttribute("aria-invalid")).toBe("false");
  await enter(`${"😀".repeat(32_000)}x`);
  expect(submit.disabled).toBe(true);
  expect(textarea.getAttribute("aria-invalid")).toBe("true");

  const content = "invalid\0content";
  const writes: unknown[] = [];
  saveResponse = async (request) => {
    writes.push(await request.json());
    expect(request.headers.get("x-lore-workspace-id")).toBe(WORKSPACE_A);
    return Response.json(
      { code: "invalid_request", error: "Memory content contains an invalid null character" },
      { status: 400 },
    );
  };
  await enter(content);
  await act(async () => submit.click());
  await eventually(() =>
    expect(container.querySelector(".memory-editor-error")?.textContent).toContain(
      "Memory content contains an invalid null character",
    ),
  );
  expect(writes).toEqual([{ content, scope: "shared" }]);
  expect(textarea.value).toBe(content);
  expect(submit.disabled).toBe(false);
});

test.each([
  ["/agents", "/api/v1/agents"],
  ["/operations", "/api/v1/code/index-jobs"],
  ["/proposals", "/api/v1/memory-proposals"],
])("cold %s loads its own data without Memory browse or Graph", async (path, expectedPath) => {
  await render(path);
  await eventually(() => expect(recorded(expectedPath)).toHaveLength(1));
  await settle();
  expect(browseRequests()).toEqual([]);
  expect(recorded("/api/v1/graph")).toEqual([]);
});

test("a cold search link searches without loading browse pages or Graph", async () => {
  await render("/memories?q=release+decision");
  await eventually(() => expect(recorded("/api/v1/memories")).toHaveLength(1));
  expect(recorded("/api/v1/memories")[0]?.url.searchParams.get("q")).toBe("release decision");
  expect(container.querySelector<HTMLInputElement>("#memory-search")?.value).toBe(
    "release decision",
  );
  expect(browseRequests()).toEqual([]);
  expect(recorded("/api/v1/graph")).toEqual([]);
});

test("a cold Memory detail loads detail, Graph, and citations without browse pages", async () => {
  await render(`/memories/${MEMORY_ID}`);
  await eventually(() => {
    expect(recorded(`/api/v1/memories/${MEMORY_ID}/code-evidence`)).toHaveLength(1);
    expect(container.textContent).toContain("Memory body 1");
  });
  expect(recorded(`/api/v1/memories/${MEMORY_ID}`)).toHaveLength(1);
  expect(recorded("/api/v1/graph")).toHaveLength(1);
  expect(browseRequests()).toEqual([]);
});

test("leaving search stops hidden query revalidation on focus", async () => {
  await render("/memories?q=release");
  await eventually(() => expect(recorded("/api/v1/memories")).toHaveLength(1));
  await navigate("Agents");
  const agentReads = recorded("/api/v1/agents").length;
  await focusWindow();
  await eventually(() => expect(recorded("/api/v1/agents").length).toBeGreaterThan(agentReads));
  expect(recorded("/api/v1/memories")).toHaveLength(1);
  expect(browseRequests()).toEqual([]);
  expect(recorded("/api/v1/graph")).toEqual([]);
});

test("navigation starts required reads and hidden Graph does not revalidate on focus", async () => {
  await render("/agents");
  await navigate("Graph");
  await eventually(() =>
    expect(container.querySelector('[data-testid="graph-renderer"]')).not.toBeNull(),
  );
  expect(recorded("/api/v1/graph")).toHaveLength(1);
  expect(browseRequests()).toEqual([]);

  await focusWindow();
  await eventually(() => expect(recorded("/api/v1/graph")).toHaveLength(2));
  await navigate("Agents");
  const agentReads = recorded("/api/v1/agents").length;
  await focusWindow();
  await eventually(() => expect(recorded("/api/v1/agents").length).toBeGreaterThan(agentReads));
  expect(recorded("/api/v1/graph")).toHaveLength(2);

  await navigate("Memories");
  await eventually(() => expect(browseRequests()).toHaveLength(1));
  expect(recorded("/api/v1/graph")).toHaveLength(2);
});

test("leaving browse stops pagination after an in-flight page completes", async () => {
  let finishPage: (response: Response) => void = () => {
    throw new Error("No page is pending");
  };
  const pendingPage = new Promise<Response>((resolve) => {
    finishPage = resolve;
  });
  browseResponse = ({ url }) => {
    const offset = Number(url.searchParams.get("offset"));
    return offset === 0
      ? json(Array.from({ length: 100 }, (_, index) => memory(index + 1)))
      : pendingPage;
  };
  await render("/memories");
  await eventually(() =>
    expect(browseRequests().map(({ url }) => url.searchParams.get("offset"))).toEqual(["0", "100"]),
  );
  await navigate("Agents");
  await act(async () =>
    finishPage(json(Array.from({ length: 100 }, (_, index) => memory(index + 101)))),
  );
  await settle();
  await focusWindow();
  expect(browseRequests().map(({ url }) => url.searchParams.get("offset"))).toEqual(["0", "100"]);
  expect(recorded("/api/v1/graph")).toEqual([]);
});

test("switching Workspace never requests the previous Memory in the new Workspace", async () => {
  await render(`/memories/${MEMORY_ID}`);
  await eventually(() =>
    expect(recorded(`/api/v1/memories/${MEMORY_ID}/code-evidence`)).toHaveLength(1),
  );
  const picker = container.querySelector("#workspace-picker");
  if (!(picker instanceof HTMLSelectElement)) throw new Error("Workspace picker not mounted");
  await act(async () => {
    picker.value = WORKSPACE_B;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await eventually(() =>
    expect(browseRequests().some(({ workspaceId }) => workspaceId === WORKSPACE_B)).toBe(true),
  );
  expect(recorded(`/api/v1/memories/${MEMORY_ID}`).map(({ workspaceId }) => workspaceId)).toEqual([
    WORKSPACE_A,
  ]);
  expect(
    recorded(`/api/v1/memories/${MEMORY_ID}/code-evidence`).map(({ workspaceId }) => workspaceId),
  ).toEqual([WORKSPACE_A]);
  expect(container.textContent).not.toContain("Memory body 1");
});
