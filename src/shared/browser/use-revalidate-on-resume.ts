"use client";

import { useEffect, useRef } from "react";

/** Queue one refresh on reentry, after any in-flight SWR request finishes. */
export function useRevalidateOnResume(
  key: string,
  enabled: boolean,
  isValidating: boolean,
  revalidate: () => Promise<unknown>,
): boolean {
  const previous = useRef({ key, enabled, pending: false });
  const pending = Boolean(
    key &&
      enabled &&
      previous.current.key === key &&
      (!previous.current.enabled || previous.current.pending),
  );

  useEffect(() => {
    previous.current = { key, enabled, pending: pending && isValidating };
    if (pending && !isValidating) void revalidate();
  }, [enabled, isValidating, key, pending, revalidate]);

  // Auto-pagination must not start a new batch before the queued refresh.
  return pending;
}
