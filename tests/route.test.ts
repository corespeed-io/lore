import { expect, test } from "vitest";
import { parseRoute, routeUrl } from "@/lib/route";

test("Agent management has a stable deep link in the native shell", () => {
  expect(parseRoute("/agents", "")).toEqual({ tab: "agents" });
  expect(routeUrl({ tab: "agents" })).toBe("/agents");
  expect(parseRoute("/", "?tab=agents")).toMatchObject({ tab: "agents" });
});
