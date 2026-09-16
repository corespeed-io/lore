// @vitest-environment happy-dom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Sidebar } from "@/shell/Sidebar";

let container: HTMLDivElement;
let root: Root;
let input: HTMLInputElement;
const onSearch = vi.fn();

function render(
  workspaceId = "workspace-a",
  searchCancelRef?: React.RefObject<(() => void) | null>,
) {
  act(() => {
    root.render(
      <Sidebar
        activeTab="search"
        activeWorkspaceId={workspaceId}
        workspaces={[]}
        onWorkspaceChange={() => {}}
        onCreateWorkspace={() => {}}
        onNewMemory={() => {}}
        onTabChange={() => {}}
        onSearch={onSearch}
        searchCancelRef={searchCancelRef}
      />,
    );
  });
  input = container.querySelector("#memory-search") as HTMLInputElement;
}

function type(value: string) {
  act(() => {
    // Bypass React's value tracker, as a real browser keystroke does.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keydown(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => input.dispatchEvent(event));
  return event;
}

function compose(event: "compositionstart" | "compositionend") {
  act(() => input.dispatchEvent(new CompositionEvent(event, { bubbles: true })));
}

function submit() {
  act(() => (container.querySelector('[type="submit"]') as HTMLButtonElement).click());
}

function advance(ms = 220) {
  act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSearch.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("labels the search field, hint, landmark, and submit action", () => {
  expect(container.querySelector('label[for="memory-search"]')?.textContent).toBe(
    "Search memories",
  );
  expect(input.getAttribute("aria-describedby")).toBe("memory-search-hint");
  expect(container.querySelector("#memory-search-hint")?.textContent).toContain("ask a question");
  expect(container.querySelector("search")?.getAttribute("aria-label")).toBe("Search memories");
  expect(container.querySelector('[type="submit"]')?.textContent).toBe("Semantic search");
});

test("debounces natural-language typing and clearing", () => {
  type("What did we decide");
  advance(150);
  type("What did we decide about launch?");
  advance(219);
  expect(onSearch).not.toHaveBeenCalled();
  advance(1);
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("What did we decide about launch?");
  type("");
  advance();
  expect(onSearch).toHaveBeenLastCalledWith("");
});

test.each(["button", "Enter"])("%s submits immediately once and closes navigation", (action) => {
  act(() =>
    (container.querySelector('[aria-label="Open navigation"]') as HTMLButtonElement).click(),
  );
  expect(container.querySelector(".sidebar-open")).not.toBeNull();
  type("How did we resolve the deployment failure?");
  advance(100);
  if (action === "button") submit();
  else expect(keydown().defaultPrevented).toBe(true);
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("How did we resolve the deployment failure?");
  expect(container.querySelector(".sidebar-open")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  advance(1000);
  expect(onSearch).toHaveBeenCalledTimes(1);
});

test.each(["我们如何发布", "リリースの決定", "배포 결정"])(
  "waits for IME composition: %s",
  (query) => {
    type("unfinished");
    advance(100);
    compose("compositionstart");
    type(query);
    advance(1000);
    expect(keydown({ isComposing: true }).defaultPrevented).toBe(true);
    submit();
    expect(onSearch).not.toHaveBeenCalled();
    compose("compositionend");
    // Browsers can dispatch one last input event after compositionend.
    type(`${query}?`);
    advance(219);
    expect(onSearch).not.toHaveBeenCalled();
    advance(1);
    expect(onSearch).toHaveBeenCalledExactlyOnceWith(`${query}?`);
  },
);

test("uses the composition ref even when the native Enter flag is absent", () => {
  compose("compositionstart");
  type("候选词");
  keydown();
  advance(1000);
  expect(onSearch).not.toHaveBeenCalled();
});

test("ignores native composing Enter even without a compositionstart event", () => {
  keydown({ isComposing: true });
  expect(onSearch).not.toHaveBeenCalled();
});

test("guards Safari's compositionend-before-Enter sequence then permits deliberate submission", () => {
  compose("compositionstart");
  type("发布决定");
  compose("compositionend");
  keydown({ keyCode: 229 });
  expect(onSearch).not.toHaveBeenCalled();
  keydown();
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("发布决定");
  advance(1000);
  expect(onSearch).toHaveBeenCalledTimes(1);
});

test("submits an Enter reported as keyCode 229 with no recent composition", () => {
  // Some Android soft keyboards report keyCode 229 for a deliberate Enter
  // outside any composition; that Enter must still search.
  type("deployment failure");
  advance(100);
  expect(keydown({ keyCode: 229 }).defaultPrevented).toBe(true);
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("deployment failure");
});

test("expires the post-composition keyCode 229 guard and skips unchanged compositions", () => {
  type("deploy failure");
  advance();
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("deploy failure");
  compose("compositionstart");
  compose("compositionend");
  advance(600);
  // A composition that changed nothing schedules nothing.
  expect(onSearch).toHaveBeenCalledTimes(1);
  keydown({ keyCode: 229 });
  expect(onSearch).toHaveBeenCalledTimes(2);
  expect(onSearch).toHaveBeenLastCalledWith("deploy failure");
});

test("blur ends the composition guard so explicit submission recovers", () => {
  compose("compositionstart");
  type("发布决定");
  act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  submit();
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("发布决定");
});

test("typing recovers a composition aborted without compositionend", () => {
  compose("compositionstart");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "recovered query",
    );
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false }));
  });
  advance();
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("recovered query");
});

test("exposes a cancel handle for App's query-context resets", () => {
  const cancelRef: React.RefObject<(() => void) | null> = { current: null };
  render("workspace-a", cancelRef);
  type("stale query");
  act(() => cancelRef.current?.());
  advance(1000);
  expect(onSearch).not.toHaveBeenCalled();
  type("fresh query");
  advance();
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("fresh query");
});

test("cancels pending search on Workspace change", () => {
  type("old workspace query");
  render("workspace-b");
  advance(1000);
  expect(onSearch).not.toHaveBeenCalled();
  type("new workspace query");
  advance();
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("new workspace query");
});

test("cancels pending search when Sidebar unmounts", () => {
  type("pending query");
  act(() => root.render(null));
  advance(1000);
  expect(onSearch).not.toHaveBeenCalled();
});
