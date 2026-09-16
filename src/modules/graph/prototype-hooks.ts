"use client";

import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { readGraphScalePrototype } from "./prototype-client";

export function useGraphScalePrototype() {
  return useSWR(loreKeys.graphScalePrototype, () => readGraphScalePrototype(), {
    // Keep one dataset stable during a renderer comparison.
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });
}
