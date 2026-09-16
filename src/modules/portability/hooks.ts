"use client";

import type { ImportWorkspaceInput } from "@corespeed/lore-sdk";
import useSWRMutation from "swr/mutation";
import { loreKeys } from "@/shared/browser/cache-keys";
import { exportWorkspaceArchive, importWorkspaceArchive } from "./client";

export function useLoreWorkspaceOperationMutations(workspaceId: string) {
  const exportArchiveMutation = useSWRMutation(
    workspaceId ? loreKeys.exportWorkspace(workspaceId) : null,
    () => exportWorkspaceArchive(workspaceId),
  );
  const validateImportMutation = useSWRMutation(
    workspaceId ? loreKeys.validateWorkspaceImport(workspaceId) : null,
    (_key, { arg }: { arg: Omit<ImportWorkspaceInput, "dryRun"> }) =>
      importWorkspaceArchive(workspaceId, { ...arg, dryRun: true }),
  );
  const importArchiveMutation = useSWRMutation(
    workspaceId ? loreKeys.importWorkspace(workspaceId) : null,
    (_key, { arg }: { arg: Omit<ImportWorkspaceInput, "dryRun"> }) =>
      importWorkspaceArchive(workspaceId, { ...arg, dryRun: false }),
  );

  return {
    exportArchive: exportArchiveMutation,
    validateImport: validateImportMutation,
    importArchive: importArchiveMutation,
    isMutating:
      exportArchiveMutation.isMutating ||
      validateImportMutation.isMutating ||
      importArchiveMutation.isMutating,
  };
}
