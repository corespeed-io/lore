import { expect, test } from "vitest";
import { createMemoryMutationPrimitives } from "../src/index";
import { embeddingMaintenanceLeaseSeconds } from "../src/maintenance";

test("a provider without a request deadline gets the default lease", () => {
  // Three nominal 120-second attempts plus a minute for database completion.
  expect(embeddingMaintenanceLeaseSeconds(undefined)).toBe(420);
  expect(embeddingMaintenanceLeaseSeconds(120_000)).toBe(420);
});

test("a provider's request deadline sizes its lease within 30 seconds to an hour", () => {
  expect(embeddingMaintenanceLeaseSeconds(10_000)).toBe(90);
  expect(embeddingMaintenanceLeaseSeconds(600_000)).toBe(1_860);
  expect(embeddingMaintenanceLeaseSeconds(1)).toBe(61);
  expect(embeddingMaintenanceLeaseSeconds(10_000_000)).toBe(3_600);
});

test("an unusable request deadline falls back to the default lease", () => {
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(embeddingMaintenanceLeaseSeconds(timeout)).toBe(420);
  }
});

test("mutation primitives refuse a provider that embeds at another width", () => {
  const embeddingProvider = {
    provider: "fixture",
    model: "fixture",
    dimensions: 8,
    revision: "fixture-v1",
    async embed(): Promise<number[][]> {
      return [];
    },
  };
  expect(() =>
    createMemoryMutationPrimitives({ embeddingDimensions: 16, embeddingProvider }),
  ).toThrow(
    "embeddingDimensions must match embeddingProvider.dimensions: " +
      "the module is configured for 16 but the provider embeds at 8",
  );
  expect(() => createMemoryMutationPrimitives({ embeddingDimensions: 0 })).toThrow(
    "Embedding dimensions must be a positive integer",
  );
  expect(() =>
    createMemoryMutationPrimitives({ embeddingDimensions: 8, embeddingProvider }),
  ).not.toThrow();
});
