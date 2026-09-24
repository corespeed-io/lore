/**
 * Browser storage holds per-viewer conveniences only. Touching it can throw
 * (blocked site data, some private modes, sandboxed frames), so a failed read is
 * "no preference" and a failed write is dropped instead of unmounting the shell.
 */
export function readLocalPreference(
  key: string,
  storage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalPreference(
  key: string,
  value: string,
  storage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): void {
  try {
    storage().setItem(key, value);
  } catch {
    // The preference is a convenience; the next visit falls back to the default.
  }
}
