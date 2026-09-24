import { expect, test } from "vitest";
import { readLocalPreference, writeLocalPreference } from "@/shared/browser/local-preference";

function blocked(): Storage {
  throw new DOMException("The operation is insecure.", "SecurityError");
}

test("blocked storage reads as no preference instead of throwing", () => {
  expect(readLocalPreference("lore.workspace", blocked)).toBeNull();
  expect(
    readLocalPreference("lore.workspace", () => ({
      getItem: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
    })),
  ).toBeNull();
});

test("blocked storage drops a write instead of throwing", () => {
  expect(() => writeLocalPreference("lore.workspace", "w1", blocked)).not.toThrow();
  expect(() =>
    writeLocalPreference("lore.workspace", "w1", () => ({
      setItem: () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
    })),
  ).not.toThrow();
});

test("available storage round-trips the preference", () => {
  const values = new Map<string, string>();
  const storage = () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });

  expect(readLocalPreference("lore.workspace", storage)).toBeNull();
  writeLocalPreference("lore.workspace", "w1", storage);
  expect(readLocalPreference("lore.workspace", storage)).toBe("w1");
});

test("the default storage accessor is guarded where no window exists", () => {
  expect(readLocalPreference("lore.workspace")).toBeNull();
  expect(() => writeLocalPreference("lore.workspace", "w1")).not.toThrow();
});
