import { expect, test } from "vitest";
import { isOperationalProbePath } from "../middleware.js";

test("operational probes bypass application authentication without widening API access", () => {
  expect(isOperationalProbePath("/livez")).toBe(true);
  expect(isOperationalProbePath("/readyz")).toBe(true);
  expect(isOperationalProbePath("/api/health")).toBe(true);

  expect(isOperationalProbePath("/api/v1/memories")).toBe(false);
  expect(isOperationalProbePath("/livez/extra")).toBe(false);
  expect(isOperationalProbePath("/readyz?full=1")).toBe(false);
});
