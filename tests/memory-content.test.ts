import { MemoryContentValidationError, prepareMemoryContent } from "@corespeed/lore-core";
import { expect, test } from "vitest";

test("Memory content rejects a lone surrogate anywhere, including at the end", () => {
  // Trailing high surrogate: charCodeAt past the end returns NaN, whose
  // comparisons are all false — the regression this test pins down.
  expect(() => prepareMemoryContent("abc\ud800")).toThrow(MemoryContentValidationError);
  expect(() => prepareMemoryContent("abc\ud800def")).toThrow(MemoryContentValidationError);
  expect(() => prepareMemoryContent("abc\udfffdef")).toThrow(MemoryContentValidationError);
  // A well-formed astral pair stays valid.
  expect(prepareMemoryContent("abc\u{20BB7}def").content).toBe("abc\u{20BB7}def");
});
