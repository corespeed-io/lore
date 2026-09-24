import { expect, test } from "vitest";
import { displayCount, readState, UNKNOWN_COUNT } from "@/shared/browser/read-state";
import { memoryPanelNotice, overviewStats } from "@/shell/overview/presentation";

const settled = {
  memoryCount: 42,
  sourceCount: 3,
  memoriesState: "ready",
  memoriesComplete: true,
  linkCount: 7,
  graphState: "ready",
  graphCapped: false,
} as const;

test("a read with data is ready even behind a failed refresh; without data it is unknown", () => {
  expect(readState({ hasData: false, hasError: false })).toBe("loading");
  expect(readState({ hasData: false, hasError: true })).toBe("error");
  expect(readState({ hasData: true, hasError: false })).toBe("ready");
  expect(readState({ hasData: true, hasError: true })).toBe("ready");
});

test("unknown counts render as a dash and bounded windows as a lower bound", () => {
  expect(displayCount(0, "loading")).toBe(UNKNOWN_COUNT);
  expect(displayCount(0, "error")).toBe(UNKNOWN_COUNT);
  expect(displayCount(0, "ready")).toBe("0");
  expect(displayCount(5_000, "ready", true)).toBe("5,000+");
  expect(displayCount(1_234, "ready")).toBe("1,234");
});

test("the Dashboard never shows zeros while its reads are loading or failed", () => {
  const loading = overviewStats({
    ...settled,
    memoryCount: 0,
    sourceCount: 0,
    linkCount: 0,
    memoriesState: "loading",
    memoriesComplete: false,
    graphState: "loading",
  });
  expect(loading).toEqual({ memories: "—", links: "—", sources: "—" });

  const failed = overviewStats({
    ...settled,
    memoryCount: 0,
    linkCount: 0,
    memoriesState: "error",
    graphState: "error",
  });
  expect(failed).toEqual({ memories: "—", links: "—", sources: "—" });

  expect(overviewStats(settled)).toEqual({ memories: "42", links: "7", sources: "3" });
});

test("a capped or still-filling browse window and a capped Graph are lower bounds", () => {
  expect(
    overviewStats({ ...settled, memoryCount: 5_000, memoriesComplete: false, graphCapped: true }),
  ).toEqual({ memories: "5,000+", links: "7+", sources: "3+" });
  expect(overviewStats({ ...settled, memoryCount: 300, memoriesComplete: false }).memories).toBe(
    "300+",
  );
});

test("Memory-derived panels replace empty copy until browse has data", () => {
  expect(memoryPanelNotice("loading")).toBe("Loading memories…");
  expect(memoryPanelNotice("error")).toBe("Memories are currently unavailable.");
  expect(memoryPanelNotice("ready")).toBeNull();
});
