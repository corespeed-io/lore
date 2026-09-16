import type { Memory as SdkMemory } from "@corespeed/lore-sdk";
import { expect, expectTypeOf, test } from "vitest";
import type { Memory } from "@/modules/memories/schemas";
import {
  CreateMemoryInputSchema,
  MemoryMetadataSchema,
  MemorySchema,
  memoryOpenApiSchemas,
  UpdateMemoryInputSchema,
} from "@/modules/memories/schemas";
import type { Memory as CoreMemory } from "../../../src/modules/memories/service";

test("the inferred wire model stays aligned with the engine and generated SDK", () => {
  expectTypeOf<Memory>().toMatchTypeOf<CoreMemory>();
  expectTypeOf<Memory>().toMatchTypeOf<SdkMemory>();
});

test("writes retain HTTP trimming and code-point bounds without trimming stored responses", () => {
  const content = "😀".repeat(32_000);
  expect(CreateMemoryInputSchema.parse({ content: `  ${content}\n` }).content).toBe(content);
  expect(CreateMemoryInputSchema.safeParse({ content: `${content}x` }).success).toBe(false);
  expect(CreateMemoryInputSchema.safeParse({ content: " \n " }).success).toBe(false);
  expect(CreateMemoryInputSchema.safeParse({ content: "bad\uD800" }).success).toBe(false);
  expect(CreateMemoryInputSchema.safeParse({ content: "bad\0" }).success).toBe(false);
  expect(MemorySchema.shape.content.parse("  preserve formatting\n")).toBe(
    "  preserve formatting\n",
  );
});

test("caller identity never enters a write, and empty updates remain invalid", () => {
  expect(
    CreateMemoryInputSchema.parse({
      content: "A fact",
      workspaceId: "caller-workspace",
      ownerUserId: "caller-owner",
      id: "caller-id",
    }),
  ).toEqual({ content: "A fact" });
  expect(UpdateMemoryInputSchema.safeParse({}).success).toBe(false);
  expect(UpdateMemoryInputSchema.safeParse({ ownerUserId: "caller-owner" }).success).toBe(false);
  expect(UpdateMemoryInputSchema.parse({ metadata: {} })).toEqual({ metadata: {} });
  expect(UpdateMemoryInputSchema.safeParse({ scope: "public" }).success).toBe(false);
});

test("metadata validates JSON values and enforces serialized size", () => {
  const metadata = {
    category: "decision",
    tags: ["数据库", "😀"],
    detail: { score: 1, active: true, value: null },
  };
  expect(MemoryMetadataSchema.parse(metadata)).toEqual(metadata);
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 34; depth += 1) nested = { child: nested };
  expect(MemoryMetadataSchema.parse(nested)).toEqual(nested);
  for (const invalid of [
    [],
    null,
    { text: "x".repeat(100_001) },
    { values: new Array(10_001) },
    { value: undefined },
    { value: Number.NaN },
    { value: Infinity },
    { value: 1n },
    { value: new Date() },
    { value: () => true },
  ]) {
    expect(MemoryMetadataSchema.safeParse(invalid).success).toBe(false);
  }
});

test("OpenAPI retains portable bounds and does not introduce document-local references", () => {
  const schemas = memoryOpenApiSchemas();
  expect(schemas.CreateMemoryInput.properties?.content).toMatchObject({
    minLength: 1,
    maxLength: 32_000,
  });
  expect(schemas.CreateMemoryInput.required).toEqual(["content"]);
  expect(schemas.CreateMemoryInput.properties?.scope).toMatchObject({ default: "shared" });
  expect(schemas.UpdateMemoryInput.minProperties).toBe(1);
  expect(schemas.UpdateMemoryInput.required ?? []).toEqual([]);
  expect(schemas.Memory.required).toContain("ownerUserId");
  expect(schemas.Memory.properties?.metadata).toMatchObject({
    additionalProperties: { $ref: "#/components/schemas/JsonValue" },
  });
  expect(schemas.JsonValue).toEqual({});
  expect(JSON.stringify(schemas)).not.toContain("#/$defs/");
  expect(JSON.stringify(schemas)).not.toContain('"$id"');
});
