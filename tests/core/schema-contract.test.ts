import { CORE_SCHEMA_CONTRACT, missingSchemaContract } from "@corespeed/lore-core/testing";
import { expect, test } from "vitest";
import { createMemoryTestContext } from "../support/memory-context";

test("the lore oss schema provides every engine schema-contract group", async () => {
  const testContext = await createMemoryTestContext();
  const groups = Object.keys(CORE_SCHEMA_CONTRACT) as (keyof typeof CORE_SCHEMA_CONTRACT)[];
  await expect(
    testContext.adminDatabase.transaction((transaction) =>
      missingSchemaContract(transaction, groups),
    ),
  ).resolves.toEqual([]);
  await testContext.close();
});
