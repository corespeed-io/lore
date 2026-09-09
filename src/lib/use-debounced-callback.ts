import { useCallback, useEffect, useRef } from "react";

/**
 * A stable schedule/cancel pair around the latest callback. One timer exists at
 * a time; scheduling replaces any pending call, and unmount cancels it. `cancel`
 * is stable, so hosts may hand it to coordination refs (Sidebar search exposes
 * it to App through `searchCancelRef` so every query-context reset can drop a
 * pending search).
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delayMs: number,
): { schedule: (...args: Args) => void; cancel: () => void } {
  const latest = useRef(callback);
  // Assigned during render so a timer firing before the next effect flush still
  // sees the current closure.
  latest.current = callback;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const schedule = useCallback(
    (...args: Args) => {
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        latest.current(...args);
      }, delayMs);
    },
    [cancel, delayMs],
  );

  useEffect(() => cancel, [cancel]);

  return { schedule, cancel };
}
