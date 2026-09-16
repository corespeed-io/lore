"use client";

import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { listWorkspaces } from "./client";

export function useLoreWorkspaces() {
  return useSWR(loreKeys.workspaces, () => listWorkspaces());
}
