import { expect, test } from "vitest";

test("test worker executes Bun", () => {
  expect(process.versions.bun).toEqual(expect.any(String));
  expect(process.versions.bun).not.toBe("");
});
