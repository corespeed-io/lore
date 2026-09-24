import { expect, test } from "vitest";
import { codeRepositoriesForWorker } from "@/worker/code-repositories";

const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";

test("an invalid registry disables Code Indexing with a content-free warning instead of stopping the worker", () => {
  for (const encoded of [
    "{not json",
    "[]",
    JSON.stringify({
      "corespeed/secret-key": {
        displayName: "Secret",
        repositoryPath: "/srv/operator/secret-repository",
        workspaceIds: [],
      },
    }),
    JSON.stringify({
      "corespeed/secret-key": {
        displayName: "Secret",
        repositoryPath: "/srv/operator/secret-repository",
        workspaceIds: ["not-a-workspace-uuid"],
      },
    }),
    JSON.stringify({
      "corespeed/secret-key": { repositoryPath: "/srv/operator/secret-repository" },
    }),
  ]) {
    const warnings: string[] = [];
    expect(
      codeRepositoriesForWorker(
        { AUTH_MODE: "proxy", LORE_CODE_REPOSITORIES: encoded },
        (message) => warnings.push(message),
      ),
      encoded,
    ).toEqual({});
    expect(warnings, encoded).toEqual([
      "Lore disabled Code Indexing in this worker: LORE_CODE_REPOSITORIES is invalid (CodeIndexValidationError)",
    ]);
    for (const secret of ["secret-key", "/srv/operator", "not-a-workspace-uuid", "{not json"]) {
      expect(warnings.join("\n")).not.toContain(secret);
    }
  }
});

test("a valid registry reaches the worker unchanged, with the parser's own warnings", () => {
  const warnings: string[] = [];
  expect(
    codeRepositoriesForWorker(
      {
        AUTH_MODE: "proxy",
        LORE_CODE_REPOSITORIES: JSON.stringify({
          "corespeed/bound": {
            displayName: "Bound",
            repositoryPath: "/srv/bound",
            workspaceIds: [WORKSPACE_ID],
          },
          "corespeed/unbound": { displayName: "Unbound", repositoryPath: "/srv/unbound" },
        }),
      },
      (message) => warnings.push(message),
    ),
  ).toEqual({
    "corespeed/bound": {
      displayName: "Bound",
      repositoryPath: "/srv/bound",
      workspaceIds: [WORKSPACE_ID],
    },
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("corespeed/unbound");
  expect(codeRepositoriesForWorker({}, () => undefined)).toEqual({});
});
