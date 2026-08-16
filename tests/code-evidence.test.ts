import { expect, test } from "vitest";
import { installActorContext } from "@/lib/actor-context";
import { CodeEvidenceAccessDeniedError, createCodeEvidenceModule } from "@/lib/code-evidence";
import { createCodeIndexModule } from "@/lib/code-index";
import { createMemoryModule } from "@/lib/memory";
import { createMemoryTestContext } from "./support/memory-context";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const COMMIT_D = "d".repeat(40);
const COMMIT_E = "e".repeat(40);
const COMMIT_F = "f".repeat(40);
const COMMIT_G = "1".repeat(40);
const COMMIT_H = "2".repeat(40);
const COMMIT_I = "3".repeat(40);
const COMMIT_J = "4".repeat(40);
const COMMIT_K = "5".repeat(40);
const COMMIT_L = "6".repeat(40);
const COMMIT_M = "7".repeat(40);
const COMMIT_N = "8".repeat(40);

function largeFunction(name: string, result: string): string {
  return `export function ${name}() {\n  const padding = "${"x".repeat(3_200)}";\n  return "${result}" + padding.length;\n}\n`;
}

function splitDeclaration(marker: string, insertBeforeTarget = false): string {
  const statement = (name: string, value: string) => `  const ${name} = "${value}";`;
  const targetValue = `${marker.padEnd(32, "_")}${"t".repeat(3_168)}`;
  return [
    "export function splitProposalPolicy() {",
    statement("alpha", "a".repeat(3_200)),
    statement("beta", "b".repeat(3_200)),
    ...(insertBeforeTarget ? [statement("inserted", "i".repeat(3_200))] : []),
    statement("target", targetValue),
    statement("omega", "z".repeat(3_200)),
    "  return alpha.length + beta.length + target.length + omega.length;",
    "}",
    "",
  ].join("\n");
}

function reorderedSplitDeclaration(marker: string, targetBeforeBeta: boolean): string {
  const statement = (name: string, value: string) => `  const ${name} = "${value}";`;
  const beta = statement("beta", "b".repeat(3_200));
  const target = statement("target", `${marker.padEnd(32, "_")}${"t".repeat(3_168)}`);
  return [
    "export function reorderedProposalPolicy() {",
    statement("alpha", "a".repeat(3_200)),
    ...(targetBeforeBeta ? [target, beta] : [beta, target]),
    statement("omega", "z".repeat(3_200)),
    "  return alpha.length + beta.length + target.length + omega.length;",
    "}",
    "",
  ].join("\n");
}

test("RLS rejects a forged declaration-context fingerprint", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const repositoryKey = "corespeed/evidence-context-rls";
  const memory = await memories.remember(context.alice, {
    content: "The proposal guard is cited with server-resolved structural context.",
    scope: "private",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Evidence context RLS",
    commitOid: COMMIT_M,
    files: [
      {
        path: "src/context-guard.ts",
        content: "export function contextGuard() { return 'safe'; }\n",
      },
    ],
  });
  const [artifact] = await code.search(context.alice, {
    repositoryKey,
    commitOid: COMMIT_M,
    query: "contextGuard",
  });
  if (!artifact) throw new Error("Expected contextGuard Artifact");
  const citation = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: artifact.id,
    relationship: "supports",
  });

  await expect(
    context.database.transaction(async (transaction) => {
      await installActorContext(transaction, context.alice);
      await transaction.query(
        `INSERT INTO memory_code_evidence (
           id, workspace_id, memory_id, repository_id,
           cited_revision_id, cited_generation_id, cited_artifact_id,
           cited_commit_oid, relationship, cited_path, cited_symbol_key,
           cited_declaration_key, cited_declaration_chunk_ordinal,
           cited_declaration_context_sha256, cited_content_sha256, validation_state,
           validated_revision_id, validated_generation_id, validated_artifact_id,
           validated_commit_oid, validated_path, created_by_user_id, created_by_agent_id
         )
         SELECT gen_random_uuid(), workspace_id, memory_id, repository_id,
           cited_revision_id, cited_generation_id, cited_artifact_id,
           cited_commit_oid, 'rationale', cited_path, cited_symbol_key,
           cited_declaration_key, cited_declaration_chunk_ordinal,
           repeat('f', 64), cited_content_sha256, 'current',
           cited_revision_id, cited_generation_id, cited_artifact_id,
           cited_commit_oid, cited_path, $2, NULL
         FROM memory_code_evidence
         WHERE workspace_id = $1 AND id = $3`,
        [context.alice.workspaceId, context.alice.userId, citation.id],
      );
    }),
  ).rejects.toThrow();
});

test("assessment previews revalidation without mutating stored Code Evidence", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const repositoryKey = "corespeed/evidence-assessment";
  const path = "src/assessment-guard.ts";
  const memory = await memories.remember(context.alice, {
    content: "The assessment guard historically returned safe.",
    scope: "private",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Evidence assessment",
    commitOid: COMMIT_A,
    files: [{ path, content: "export function assessmentGuard() { return 'safe'; }\n" }],
  });
  const [citedArtifact] = await code.search(context.alice, {
    repositoryKey,
    commitOid: COMMIT_A,
    query: "assessmentGuard",
  });
  if (!citedArtifact) throw new Error("Expected the cited assessmentGuard Artifact");
  const citation = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: citedArtifact.id,
    relationship: "supports",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Evidence assessment",
    commitOid: COMMIT_B,
    files: [{ path, content: "export function assessmentGuard() { return 'unsafe'; }\n" }],
  });
  const [targetArtifact] = await code.search(context.alice, {
    repositoryKey,
    commitOid: COMMIT_B,
    query: "assessmentGuard",
  });
  if (!targetArtifact) throw new Error("Expected the target assessmentGuard Artifact");

  const assessment = await evidence.assess(context.alice, {
    evidenceId: citation.id,
    repositoryKey,
    commitOid: COMMIT_B,
  });
  expect(assessment).toMatchObject({
    evidenceId: citation.id,
    validationState: "changed",
    validatedArtifactId: targetArtifact.id,
    validatedCommitOid: COMMIT_B,
    validatedPath: path,
  });
  await expect(evidence.list(context.alice, { memoryId: memory.id })).resolves.toMatchObject([
    {
      id: citation.id,
      validationState: "current",
      validatedArtifactId: citedArtifact.id,
      validatedCommitOid: COMMIT_A,
      validatedPath: path,
    },
  ]);
  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: citation.id,
      repositoryKey,
      commitOid: COMMIT_B,
    }),
  ).resolves.toMatchObject({
    validationState: assessment.validationState,
    validatedRevisionId: assessment.validatedRevisionId,
    validatedGenerationId: assessment.validatedGenerationId,
    validatedArtifactId: assessment.validatedArtifactId,
    validatedCommitOid: assessment.validatedCommitOid,
    validatedPath: assessment.validatedPath,
  });
});

test("a visible non-owner can assess but cannot persist Code Evidence revalidation", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const repositoryKey = "corespeed/evidence-assessment-authority";
  const path = "src/shared-guard.ts";
  const memory = await memories.remember(context.alice, {
    content: "The shared guard historically returned safe.",
    scope: "shared",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Evidence assessment authority",
    commitOid: COMMIT_C,
    files: [{ path, content: "export function sharedGuard() { return 'safe'; }\n" }],
  });
  const [artifact] = await code.search(context.alice, {
    repositoryKey,
    commitOid: COMMIT_C,
    query: "sharedGuard",
  });
  if (!artifact) throw new Error("Expected the sharedGuard Artifact");
  const citation = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: artifact.id,
    relationship: "supports",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Evidence assessment authority",
    commitOid: COMMIT_D,
    files: [{ path, content: "export function sharedGuard() { return 'unsafe'; }\n" }],
  });

  await expect(
    evidence.assess(context.bob, {
      evidenceId: citation.id,
      repositoryKey,
      commitOid: COMMIT_D,
    }),
  ).resolves.toMatchObject({
    validationState: "changed",
    validatedCommitOid: COMMIT_D,
    validatedPath: path,
  });
  await expect(
    evidence.revalidate(context.bob, {
      evidenceId: citation.id,
      repositoryKey,
      commitOid: COMMIT_D,
    }),
  ).rejects.toBeInstanceOf(CodeEvidenceAccessDeniedError);
});

test("revalidation abstains when equal-count reordering changes a split chunk's meaning", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const repositoryKey = "corespeed/evidence-split-declaration-reorder";
  const path = "src/reordered-proposals.ts";
  const memory = await memories.remember(context.alice, {
    content: "The historical target block had an exact declaration-sequence context.",
    scope: "private",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Reordered split declaration evidence",
    commitOid: COMMIT_M,
    files: [{ path, content: reorderedSplitDeclaration("HISTORICAL_TARGET", false) }],
  });
  const citedArtifact = (
    await code.search(context.alice, {
      repositoryKey,
      commitOid: COMMIT_M,
      query: "HISTORICAL_TARGET",
      limit: 20,
    })
  )[0];
  if (!citedArtifact) throw new Error("Expected the historical reordered Artifact");
  const citation = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: citedArtifact.id,
    relationship: "supports",
  });
  expect(citation.citedDeclarationContextSha256).toMatch(/^[0-9a-f]{64}$/);

  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Reordered split declaration evidence",
    commitOid: COMMIT_N,
    files: [{ path, content: reorderedSplitDeclaration("CURRENT_TARGET", true) }],
  });
  const targetArtifact = (
    await code.search(context.alice, {
      repositoryKey,
      commitOid: COMMIT_N,
      query: "CURRENT_TARGET",
      limit: 20,
    })
  )[0];
  if (!targetArtifact) throw new Error("Expected the current reordered Artifact");
  expect(targetArtifact.declarationChunkOrdinal).not.toBe(citedArtifact.declarationChunkOrdinal);

  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: citation.id,
      repositoryKey,
      commitOid: COMMIT_N,
    }),
  ).resolves.toMatchObject({
    validationState: "ambiguous",
    validatedArtifactId: null,
    validatedPath: null,
  });
});

test("revalidation abstains when insertion shifts a split declaration ordinal", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const repositoryKey = "corespeed/evidence-split-declaration-shift";
  const path = "src/shifted-proposals.ts";
  const memory = await memories.remember(context.alice, {
    content: "The historical target block had an exact split-declaration locator.",
    scope: "private",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Shifted split declaration evidence",
    commitOid: COMMIT_K,
    files: [{ path, content: splitDeclaration("HISTORICAL_TARGET") }],
  });
  const citedArtifact = (
    await code.search(context.alice, {
      repositoryKey,
      commitOid: COMMIT_K,
      query: "HISTORICAL_TARGET",
      limit: 20,
    })
  )[0];
  if (!citedArtifact) throw new Error("Expected the historical shifted Artifact");
  const citation = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: citedArtifact.id,
    relationship: "supports",
  });

  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Shifted split declaration evidence",
    commitOid: COMMIT_L,
    files: [{ path, content: splitDeclaration("CURRENT_TARGET", true) }],
  });
  const targetArtifact = (
    await code.search(context.alice, {
      repositoryKey,
      commitOid: COMMIT_L,
      query: "CURRENT_TARGET",
      limit: 20,
    })
  )[0];
  if (!targetArtifact) throw new Error("Expected the current shifted Artifact");
  expect(targetArtifact.declarationChunkOrdinal).toBeGreaterThan(
    citedArtifact.declarationChunkOrdinal ?? -1,
  );

  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: citation.id,
      repositoryKey,
      commitOid: COMMIT_L,
    }),
  ).resolves.toMatchObject({
    validationState: "ambiguous",
    validatedArtifactId: null,
    validatedPath: null,
  });
});

test("revalidation identifies one changed chunk within a split declaration", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const repositoryKey = "corespeed/evidence-split-declaration";
  const path = "src/split-proposals.ts";
  const memory = await memories.remember(context.alice, {
    content: "The split proposal policy used the historical target block.",
    scope: "private",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Split declaration evidence",
    commitOid: COMMIT_I,
    files: [{ path, content: splitDeclaration("HISTORICAL_TARGET") }],
  });
  const citedArtifact = (
    await code.search(context.alice, {
      repositoryKey,
      commitOid: COMMIT_I,
      query: "HISTORICAL_TARGET",
      limit: 20,
    })
  )[0];
  expect(citedArtifact?.declarationChunkOrdinal).toBeGreaterThan(0);
  if (!citedArtifact) throw new Error("Expected the historical split declaration Artifact");
  const citation = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: citedArtifact.id,
    relationship: "supports",
  });
  expect(citation.citedDeclarationChunkOrdinal).toBe(citedArtifact.declarationChunkOrdinal);

  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Split declaration evidence",
    commitOid: COMMIT_J,
    files: [{ path, content: splitDeclaration("CURRENT_TARGET") }],
  });
  const targetArtifact = (
    await code.search(context.alice, {
      repositoryKey,
      commitOid: COMMIT_J,
      query: "CURRENT_TARGET",
      limit: 20,
    })
  )[0];
  if (!targetArtifact) throw new Error("Expected the current split declaration Artifact");
  expect(targetArtifact.declarationKey).toBe(citedArtifact.declarationKey);
  expect(targetArtifact.declarationChunkOrdinal).toBe(citedArtifact.declarationChunkOrdinal);

  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: citation.id,
      repositoryKey,
      commitOid: COMMIT_J,
    }),
  ).resolves.toMatchObject({
    validationState: "changed",
    validatedArtifactId: targetArtifact.id,
    validatedPath: path,
  });
});

test("revalidation does not let early same-path Artifacts starve the cited symbol", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const repositoryKey = "corespeed/evidence-candidate-priority";
  const path = "src/proposals.ts";
  const leadingFunctions = ["alpha", "beta", "gamma", "delta"].map((name) =>
    largeFunction(name, name),
  );
  const baseSource = [
    ...leadingFunctions,
    largeFunction("proposalRetentionPolicy", "review state expires"),
  ].join("\n");
  const targetSource = [
    ...leadingFunctions,
    largeFunction("proposalRetentionPolicy", "review state expires after 30 days"),
  ].join("\n");

  const memory = await memories.remember(context.alice, {
    content: "Proposal review state expires after 30 days.",
    scope: "private",
  });
  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Evidence candidate priority",
    commitOid: COMMIT_G,
    files: [{ path, content: baseSource }],
  });
  const citedArtifact = (
    await code.search(context.alice, {
      repositoryKey,
      commitOid: COMMIT_G,
      query: "proposalRetentionPolicy",
      limit: 20,
    })
  ).find((artifact) => artifact.symbol === "proposalRetentionPolicy");
  expect(citedArtifact?.ordinal).toBeGreaterThanOrEqual(3);
  if (!citedArtifact) throw new Error("Expected the cited proposalRetentionPolicy Artifact");
  const citation = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: citedArtifact.id,
    relationship: "supports",
  });

  await code.indexRevision(context.alice, {
    repositoryKey,
    displayName: "Evidence candidate priority",
    commitOid: COMMIT_H,
    files: [{ path, content: targetSource }],
  });
  const targetArtifact = (
    await code.search(context.alice, {
      repositoryKey,
      commitOid: COMMIT_H,
      query: "proposalRetentionPolicy",
      limit: 20,
    })
  ).find((artifact) => artifact.symbol === "proposalRetentionPolicy");
  if (!targetArtifact) throw new Error("Expected the target proposalRetentionPolicy Artifact");

  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: citation.id,
      repositoryKey,
      commitOid: COMMIT_H,
    }),
  ).resolves.toMatchObject({
    validationState: "changed",
    validatedArtifactId: targetArtifact.id,
    validatedPath: path,
  });
});

test("typed Memory code evidence survives rebuildable artifacts and exposes every stale state", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const code = createCodeIndexModule(context.database);
  const evidence = createCodeEvidenceModule(context.database);
  const memory = await memories.remember(context.alice, {
    content: "The deployment guard is implemented by deploymentGuard.",
    scope: "private",
  });
  const source = "export function deploymentGuard() { return 'safe'; }\n";
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/evidence",
    displayName: "Evidence",
    commitOid: COMMIT_A,
    files: [{ path: "src/guard.ts", content: source }],
  });
  const [artifact] = await code.search(context.alice, {
    repositoryKey: "corespeed/evidence",
    commitOid: COMMIT_A,
    query: "deploymentGuard",
  });
  expect(artifact).toBeDefined();
  if (!artifact) throw new Error("Expected deploymentGuard Code Artifact");

  const cited = await evidence.cite(context.alice, {
    memoryId: memory.id,
    artifactId: artifact.id,
    relationship: "supports",
  });
  expect(cited).toMatchObject({
    memoryId: memory.id,
    citedCommitOid: COMMIT_A,
    citedPath: "src/guard.ts",
    relationship: "supports",
    validationState: "current",
    validatedCommitOid: COMMIT_A,
  });
  await expect(evidence.list(context.bob, { memoryId: memory.id })).rejects.toBeInstanceOf(
    CodeEvidenceAccessDeniedError,
  );
  await expect(evidence.list(context.carol, { memoryId: memory.id })).rejects.toBeInstanceOf(
    CodeEvidenceAccessDeniedError,
  );

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/evidence",
    displayName: "Evidence",
    commitOid: COMMIT_B,
    files: [{ path: "src/renamed-guard.ts", content: source }],
  });
  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: cited.id,
      repositoryKey: "corespeed/evidence",
      commitOid: COMMIT_B,
    }),
  ).resolves.toMatchObject({
    validationState: "moved",
    validatedCommitOid: COMMIT_B,
    validatedPath: "src/renamed-guard.ts",
  });

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/evidence",
    displayName: "Evidence",
    commitOid: COMMIT_C,
    files: [
      {
        path: "src/renamed-guard.ts",
        content: "export function deploymentGuard() { return 'unsafe'; }\n",
      },
    ],
  });
  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: cited.id,
      repositoryKey: "corespeed/evidence",
      commitOid: COMMIT_C,
    }),
  ).resolves.toMatchObject({
    validationState: "changed",
    validatedCommitOid: COMMIT_C,
    validatedPath: "src/renamed-guard.ts",
  });

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/evidence",
    displayName: "Evidence",
    commitOid: COMMIT_D,
    files: [],
  });
  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: cited.id,
      repositoryKey: "corespeed/evidence",
      commitOid: COMMIT_D,
    }),
  ).resolves.toMatchObject({
    validationState: "deleted",
    validatedCommitOid: COMMIT_D,
    validatedPath: null,
  });

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/evidence",
    displayName: "Evidence",
    commitOid: COMMIT_E,
    files: [
      { path: "src/copy-a.ts", content: source },
      { path: "src/copy-b.ts", content: source },
    ],
  });
  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: cited.id,
      repositoryKey: "corespeed/evidence",
      commitOid: COMMIT_E,
    }),
  ).resolves.toMatchObject({
    validationState: "ambiguous",
    validatedCommitOid: COMMIT_E,
    validatedPath: null,
  });

  await expect(
    evidence.revalidate(context.alice, {
      evidenceId: cited.id,
      repositoryKey: "corespeed/evidence",
      commitOid: COMMIT_F,
    }),
  ).resolves.toMatchObject({
    validationState: "unverifiable",
    validatedCommitOid: null,
    validatedPath: null,
  });

  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query("DELETE FROM code_index_generations WHERE id = $1", [
      cited.citedGenerationId,
    ]);
  });
  await expect(evidence.list(context.alice, { memoryId: memory.id })).resolves.toMatchObject([
    {
      id: cited.id,
      citedCommitOid: COMMIT_A,
      citedContentSha256: cited.citedContentSha256,
      validationState: "unverifiable",
    },
  ]);
});
