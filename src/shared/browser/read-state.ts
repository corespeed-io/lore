/**
 * What a view may claim about one remote read. `ready` means data is present,
 * possibly stale behind a failed refresh. `loading` and `error` mean the view
 * has nothing to count, so it renders an unknown value and never a zero.
 */
export type ReadState = "loading" | "error" | "ready";

export function readState(input: { hasData: boolean; hasError: boolean }): ReadState {
  if (input.hasData) return "ready";
  return input.hasError ? "error" : "loading";
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export const UNKNOWN_COUNT = "—";

/**
 * A count a view can vouch for. An unknown read renders "—". A count taken from
 * a bounded read window (a browse fill still in progress, or the 5,000-Memory
 * browse or Graph cap) renders as a lower bound such as "5,000+".
 */
export function displayCount(count: number, state: ReadState, lowerBound = false): string {
  if (state !== "ready") return UNKNOWN_COUNT;
  return `${COUNT_FORMAT.format(count)}${lowerBound ? "+" : ""}`;
}
