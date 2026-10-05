import { expect, test } from "vitest";
import { LORE_SCHEMA_REVISION, schemaCompatibility } from "@/modules/operations/service";

test("a schema without compatibleFrom serves only its own revision", () => {
  expect(schemaCompatibility({ schemaRevision: 9 }, 9)).toBe("ok");
  expect(schemaCompatibility({ schemaRevision: 10 }, 9)).toBe("incompatible");
  expect(schemaCompatibility({ schemaRevision: 8 }, 9)).toBe("incompatible");
  expect(schemaCompatibility({ schemaRevision: LORE_SCHEMA_REVISION })).toBe("ok");
});

test("a newer schema serves every application revision from compatibleFrom on", () => {
  expect(schemaCompatibility({ schemaRevision: 11, compatibleFrom: 9 }, 9)).toBe("ok");
  expect(schemaCompatibility({ schemaRevision: 11, compatibleFrom: 9 }, 10)).toBe("ok");
  expect(schemaCompatibility({ schemaRevision: 11, compatibleFrom: 9 }, 11)).toBe("ok");
  expect(schemaCompatibility({ schemaRevision: 11, compatibleFrom: 10 }, 9)).toBe("incompatible");
  expect(schemaCompatibility({ schemaRevision: 11, compatibleFrom: 11 }, 10)).toBe("incompatible");
});

test("a schema older than the application is never compatible", () => {
  expect(schemaCompatibility({ schemaRevision: 8, compatibleFrom: 1 }, 9)).toBe("incompatible");
  expect(schemaCompatibility({ schemaRevision: 8, compatibleFrom: 8 }, 9)).toBe("incompatible");
});

test("malformed revisions fail closed", () => {
  for (const compatibleFrom of [null, "9", 8.5, 0, -1, Number.NaN, 2 ** 53, 12, true, {}]) {
    expect(
      schemaCompatibility({ schemaRevision: 11, compatibleFrom }, 9),
      String(compatibleFrom),
    ).toBe("incompatible");
    // Even at the application's own revision a malformed declaration is refused,
    // rather than read as absent.
    expect(
      schemaCompatibility({ schemaRevision: 9, compatibleFrom }, 9),
      String(compatibleFrom),
    ).toBe("incompatible");
  }
  for (const schemaRevision of [undefined, null, "9", 9.5, 0, Number.POSITIVE_INFINITY]) {
    expect(schemaCompatibility({ schemaRevision }, 9), String(schemaRevision)).toBe("incompatible");
    expect(schemaCompatibility({ schemaRevision, compatibleFrom: 9 }, 9)).toBe("incompatible");
  }
  expect(schemaCompatibility({}, 9)).toBe("incompatible");
});
