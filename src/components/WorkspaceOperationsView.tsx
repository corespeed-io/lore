"use client";

import { useMemo, useState } from "react";
import {
  useLoreCurrentHumanActor,
  useLoreDeploymentCapabilities,
  useLoreReadiness,
  useLoreWorkspaceOperationMutations,
} from "@/lib/lore-swr";
import type { ReadinessReport } from "@/lib/operations";
import type { WorkspaceArchive, WorkspaceImportResult } from "@/lib/portability";
import {
  isUuid,
  MAX_WORKSPACE_ARCHIVE_FILE_BYTES,
  parseWorkspaceArchiveText,
  type WorkspaceImportConflictPolicy,
  workspaceArchiveFilename,
  workspaceArchiveSourceOwners,
  workspaceImportFingerprint,
  workspaceOwnerMap,
} from "@/lib/workspace-operations";

const FEATURE_LABELS = {
  idempotency: "Replay-safe mutations",
  optimisticConcurrency: "Optimistic concurrency",
  transactionalOutbox: "Transactional outbox",
  workspacePortability: "Workspace portability",
  embeddingGenerations: "Embedding generations",
  cursorPagination: "Cursor pagination",
} as const;

const COMPONENT_LABELS: Record<keyof ReadinessReport["components"], string> = {
  database: "Database",
  rlsRole: "RLS role",
  schema: "Schema",
  vector: "pgvector",
  embedding: "Embedding",
};

interface SelectedArchive {
  archive: WorkspaceArchive;
  fileName: string;
  fileSize: number;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function displayUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function displayFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readinessSummary(status: ReadinessReport["status"]): string {
  if (status === "ready") return "The request path and portable core are ready.";
  if (status === "degraded") {
    return "Lexical retrieval and Memory writes remain available while embedding is degraded.";
  }
  return "Lore is not ready to serve requests. Inspect the failing components before traffic.";
}

function StatusBadge({ value }: { value: string }) {
  const normalized = value === "ok" ? "ready" : value;
  const tone = ["ready", "disabled", "loaded"].includes(normalized)
    ? "ok"
    : ["degraded", "unknown", "incompatible"].includes(normalized)
      ? "degraded"
      : "unready";
  return <span className={`operations-status operations-status-${tone}`}>{value}</span>;
}

function InlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="operations-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export function WorkspaceOperationsView({
  workspaceId,
  workspaceName,
  onImportComplete,
}: {
  workspaceId: string;
  workspaceName: string;
  onImportComplete: () => Promise<unknown> | unknown;
}) {
  const capabilities = useLoreDeploymentCapabilities(workspaceId);
  const currentActor = useLoreCurrentHumanActor(workspaceId);
  const readiness = useLoreReadiness();
  const mutations = useLoreWorkspaceOperationMutations(workspaceId);
  const [selectedArchive, setSelectedArchive] = useState<SelectedArchive | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState<WorkspaceImportConflictPolicy>("remap");
  const [validatedFingerprint, setValidatedFingerprint] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<WorkspaceImportResult | null>(null);
  const [importResult, setImportResult] = useState<WorkspaceImportResult | null>(null);
  const [exportReceipt, setExportReceipt] = useState<WorkspaceArchive["manifest"] | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dismissedReadinessError, setDismissedReadinessError] = useState<unknown>(null);
  const [dismissedCapabilitiesError, setDismissedCapabilitiesError] = useState<unknown>(null);
  const [dismissedActorError, setDismissedActorError] = useState<unknown>(null);

  const sourceOwners = useMemo(
    () => (selectedArchive ? workspaceArchiveSourceOwners(selectedArchive.archive) : []),
    [selectedArchive],
  );
  const targetOwnerUserId = currentActor.data?.userId ?? "";
  const inputFingerprint = selectedArchive
    ? workspaceImportFingerprint(selectedArchive.archive, targetOwnerUserId, conflictPolicy)
    : null;
  const dryRunIsCurrent = Boolean(
    dryRunResult && inputFingerprint && validatedFingerprint === inputFingerprint,
  );
  const ownerIdValid = isUuid(targetOwnerUserId);
  const busy = mutations.isMutating;
  const readinessReport = readiness.data;
  const deploymentCapabilities = capabilities.data;
  const readinessError =
    readiness.error && readiness.error !== dismissedReadinessError
      ? errorMessage(readiness.error)
      : null;
  const capabilitiesError =
    capabilities.error && capabilities.error !== dismissedCapabilitiesError
      ? errorMessage(capabilities.error)
      : null;
  const actorError =
    currentActor.error && currentActor.error !== dismissedActorError
      ? errorMessage(currentActor.error)
      : null;

  function resetValidation() {
    setValidatedFingerprint(null);
    setDryRunResult(null);
    setImportResult(null);
    setImportError(null);
  }

  async function selectArchive(file: File | undefined) {
    if (!file) return;
    setImportError(null);
    setImportResult(null);
    setValidatedFingerprint(null);
    setDryRunResult(null);
    if (file.size > MAX_WORKSPACE_ARCHIVE_FILE_BYTES) {
      setSelectedArchive(null);
      setImportError("Archive exceeds Lore's 50 MB import limit.");
      return;
    }
    try {
      const archive = parseWorkspaceArchiveText(await file.text());
      setSelectedArchive({ archive, fileName: file.name, fileSize: file.size });
      setConflictPolicy("remap");
    } catch (cause) {
      setSelectedArchive(null);
      setImportError(errorMessage(cause));
    }
  }

  async function refreshStatus() {
    setDismissedReadinessError(null);
    setDismissedCapabilitiesError(null);
    setDismissedActorError(null);
    await Promise.all([capabilities.mutate(), currentActor.mutate(), readiness.mutate()]);
  }

  async function downloadArchive() {
    setExportError(null);
    try {
      const archive = await mutations.exportArchive.trigger();
      const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = workspaceArchiveFilename(workspaceId, archive.manifest.exportedAt);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setExportReceipt(archive.manifest);
    } catch (cause) {
      setExportError(errorMessage(cause));
    } finally {
      mutations.exportArchive.reset();
    }
  }

  function importInput() {
    if (!selectedArchive || !ownerIdValid) return null;
    return {
      archive: selectedArchive.archive,
      ownerMap: workspaceOwnerMap(selectedArchive.archive, targetOwnerUserId),
      conflictPolicy,
    };
  }

  async function validateImport() {
    const input = importInput();
    if (!input || !inputFingerprint) return;
    setImportError(null);
    setImportResult(null);
    try {
      const result = await mutations.validateImport.trigger(input);
      setDryRunResult(result);
      setValidatedFingerprint(inputFingerprint);
    } catch (cause) {
      setValidatedFingerprint(null);
      setDryRunResult(null);
      setImportError(errorMessage(cause));
    }
  }

  async function commitImport() {
    const input = importInput();
    if (!input || !dryRunResult || !dryRunIsCurrent) return;
    if (
      !window.confirm(
        `Import ${dryRunResult.importedMemories} Memories and ${dryRunResult.importedLinks} Links into ${workspaceName}? Lore will create fresh Memory ids.`,
      )
    ) {
      return;
    }
    setImportError(null);
    try {
      const result = await mutations.importArchive.trigger(input);
      setImportResult(result);
      await onImportComplete();
    } catch (cause) {
      setImportError(errorMessage(cause));
    }
  }

  return (
    <section className="page-wrap operations-page">
      <header className="operations-hero">
        <div>
          <p className="operations-kicker">{workspaceName}</p>
          <h1>Workspace operations</h1>
          <p className="operations-hero-copy">
            Move actor-visible Memory safely and inspect the deployment contract that protects this
            Workspace.
          </p>
        </div>
        <button
          type="button"
          className="operations-refresh"
          disabled={
            capabilities.isValidating || currentActor.isValidating || readiness.isValidating
          }
          onClick={() => void refreshStatus()}
        >
          {capabilities.isValidating || currentActor.isValidating || readiness.isValidating
            ? "Refreshing…"
            : "Refresh status"}
        </button>
      </header>

      <div className="operations-health-grid">
        <section
          className="operations-panel operations-readiness"
          aria-labelledby="readiness-title"
        >
          <div className="operations-panel-head">
            <div>
              <p className="operations-eyebrow">Runtime</p>
              <h2 id="readiness-title">Readiness</h2>
            </div>
            {readinessReport && <StatusBadge value={readinessReport.status} />}
          </div>
          {readinessError ? (
            <InlineError
              message={readinessError}
              onDismiss={() => setDismissedReadinessError(readiness.error)}
            />
          ) : !readinessReport ? (
            <p className="operations-loading">Checking the request path…</p>
          ) : (
            <>
              <p className="operations-summary">{readinessSummary(readinessReport.status)}</p>
              <dl className="operations-component-list">
                {(Object.keys(COMPONENT_LABELS) as Array<keyof ReadinessReport["components"]>).map(
                  (component) => (
                    <div key={component}>
                      <dt>{COMPONENT_LABELS[component]}</dt>
                      <dd>
                        <StatusBadge value={readinessReport.components[component]} />
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            </>
          )}
        </section>

        <section className="operations-panel" aria-labelledby="deployment-title">
          <div className="operations-panel-head">
            <div>
              <p className="operations-eyebrow">Portable core</p>
              <h2 id="deployment-title">Deployment contract</h2>
            </div>
            <span className="operations-level">Deployment-level</span>
          </div>
          {capabilitiesError ? (
            <InlineError
              message={capabilitiesError}
              onDismiss={() => setDismissedCapabilitiesError(capabilities.error)}
            />
          ) : !deploymentCapabilities ? (
            <p className="operations-loading">Loading capabilities…</p>
          ) : (
            <>
              <div className="operations-deployment-meta">
                <span>API {deploymentCapabilities.apiVersion}</span>
                <span>Schema {deploymentCapabilities.schemaRevision}</span>
                <code>{deploymentCapabilities.deploymentId}</code>
              </div>
              <ul className="operations-feature-list">
                {(Object.keys(FEATURE_LABELS) as Array<keyof typeof FEATURE_LABELS>).map(
                  (feature) => {
                    const available = deploymentCapabilities.features[feature];
                    return (
                      <li
                        key={feature}
                        aria-label={`${FEATURE_LABELS[feature]}: ${available ? "available" : "unavailable"}`}
                      >
                        <span aria-hidden="true">{available ? "✓" : "—"}</span>
                        {FEATURE_LABELS[feature]}
                      </li>
                    );
                  },
                )}
              </ul>
              <div className="operations-embedding">
                <p>Active embedding generation</p>
                {deploymentCapabilities.activeEmbeddingGeneration ? (
                  <>
                    <strong>
                      {deploymentCapabilities.activeEmbeddingGeneration.provider} /{" "}
                      {deploymentCapabilities.activeEmbeddingGeneration.model}
                    </strong>
                    <code>
                      {deploymentCapabilities.activeEmbeddingGeneration.dimensions} dimensions ·{" "}
                      {deploymentCapabilities.activeEmbeddingGeneration.revision}
                    </code>
                  </>
                ) : (
                  <span>No active generation. Lexical retrieval remains available.</span>
                )}
                <small>Configured once per deployment, never per Workspace or Agent.</small>
              </div>
            </>
          )}
        </section>
      </div>

      <section className="operations-transfer" aria-labelledby="portability-title">
        <div className="operations-section-head">
          <div>
            <p className="operations-eyebrow">Actor-visible archive</p>
            <h2 id="portability-title">Workspace portability</h2>
          </div>
          {deploymentCapabilities && (
            <span>
              Up to {deploymentCapabilities.limits.workspaceArchiveMemories.toLocaleString()}{" "}
              Memories · {deploymentCapabilities.limits.workspaceArchiveLinks.toLocaleString()}{" "}
              Links
            </span>
          )}
        </div>

        <div className="operations-transfer-grid">
          <section className="operations-export" aria-labelledby="export-title">
            <span className="operations-step">01</span>
            <h3 id="export-title">Download a logical archive</h3>
            <p>
              Includes shared Memories you can see, your private Memories, and Links whose endpoints
              are both visible. Credentials, Agents, embeddings, jobs, and events stay out.
            </p>
            <button
              type="button"
              className="operations-primary"
              disabled={mutations.exportArchive.isMutating}
              onClick={() => void downloadArchive()}
            >
              {mutations.exportArchive.isMutating ? "Preparing archive…" : "Download archive"}
            </button>
            {exportError && (
              <InlineError message={exportError} onDismiss={() => setExportError(null)} />
            )}
            {exportReceipt && (
              <div className="operations-receipt" role="status">
                <strong>Archive downloaded</strong>
                <span>
                  {exportReceipt.memoryCount} Memories · {exportReceipt.linkCount} Links ·{" "}
                  {displayUtc(exportReceipt.exportedAt)}
                </span>
                <code>{exportReceipt.checksum}</code>
              </div>
            )}
          </section>

          <section className="operations-import" aria-labelledby="import-title">
            <span className="operations-step">02</span>
            <h3 id="import-title">Validate, then import</h3>
            <p>
              Lore verifies format, checksum, counts, field limits, Links, ownership, and collisions
              before any write. A successful dry run is required here before Import unlocks.
            </p>

            <label className="operations-file-picker">
              <span>{selectedArchive ? "Choose a different archive" : "Choose Lore archive"}</span>
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void selectArchive(file);
                }}
              />
            </label>

            {selectedArchive && (
              <div className="operations-import-form">
                <div className="operations-archive-summary">
                  <div>
                    <strong>{selectedArchive.fileName}</strong>
                    <span>
                      {displayFileSize(selectedArchive.fileSize)} ·{" "}
                      {selectedArchive.archive.manifest.memoryCount} Memories ·{" "}
                      {selectedArchive.archive.manifest.linkCount} Links
                    </span>
                  </div>
                  <StatusBadge value="loaded" />
                  <code>{selectedArchive.archive.manifest.checksum}</code>
                </div>

                <div className="operations-field">
                  <span>Target owner User ID</span>
                  {actorError ? (
                    <InlineError
                      message={actorError}
                      onDismiss={() => setDismissedActorError(currentActor.error)}
                    />
                  ) : currentActor.data ? (
                    <div className="operations-owner-target">
                      <strong>You</strong>
                      <code>{currentActor.data.userId}</code>
                    </div>
                  ) : (
                    <span className="operations-loading">Resolving the importing human…</span>
                  )}
                  <small>
                    Every source owner is explicitly remapped to the verified importing human.
                    Archive-provided identities are never trusted as the target.
                  </small>
                </div>

                <fieldset className="operations-policy">
                  <legend>Visible ID collisions</legend>
                  {(["remap", "skip", "error"] as const).map((policy) => (
                    <label key={policy}>
                      <input
                        type="radio"
                        name="workspace-import-policy"
                        value={policy}
                        checked={conflictPolicy === policy}
                        onChange={() => {
                          setConflictPolicy(policy);
                          resetValidation();
                        }}
                      />
                      <span>
                        <strong>{policy}</strong>
                        <small>
                          {policy === "remap"
                            ? "Create fresh IDs for every imported Memory."
                            : policy === "skip"
                              ? "Skip source IDs that visibly collide."
                              : "Reject the archive if a visible source ID collides."}
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>

                <details className="operations-owner-map">
                  <summary>
                    Owner remap · {sourceOwners.length} source owner
                    {sourceOwners.length === 1 ? "" : "s"}
                  </summary>
                  <div>
                    {sourceOwners.slice(0, 5).map((owner) => (
                      <code key={owner}>
                        {owner} →{" "}
                        {ownerIdValid ? targetOwnerUserId.trim().toLowerCase() : "required"}
                      </code>
                    ))}
                    {sourceOwners.length > 5 && (
                      <span>+ {sourceOwners.length - 5} more owners</span>
                    )}
                  </div>
                </details>

                <div className="operations-import-actions">
                  <button
                    type="button"
                    disabled={!ownerIdValid || busy}
                    onClick={() => void validateImport()}
                  >
                    {mutations.validateImport.isMutating ? "Validating…" : "Run dry check"}
                  </button>
                  <button
                    type="button"
                    className="operations-primary"
                    disabled={!dryRunIsCurrent || busy || Boolean(importResult)}
                    onClick={() => void commitImport()}
                  >
                    {mutations.importArchive.isMutating ? "Importing…" : "Import archive"}
                  </button>
                </div>

                {dryRunIsCurrent && dryRunResult && (
                  <div className="operations-dry-run" role="status">
                    <span aria-hidden="true">✓</span>
                    <div>
                      <strong>Dry check passed</strong>
                      <p>
                        Ready to import {dryRunResult.importedMemories} Memories and{" "}
                        {dryRunResult.importedLinks} Links. {dryRunResult.skippedMemories} visible
                        collisions will be skipped.
                      </p>
                    </div>
                  </div>
                )}

                {importResult && (
                  <div className="operations-receipt operations-import-receipt" role="status">
                    <strong>
                      {importResult.replayed ? "Archive already imported" : "Import complete"}
                    </strong>
                    <span>
                      {importResult.importedMemories} Memories · {importResult.importedLinks} Links
                      {" · "}
                      {importResult.skippedMemories} skipped
                    </span>
                    <code>{importResult.archiveChecksum}</code>
                  </div>
                )}
              </div>
            )}

            {importError && (
              <InlineError message={importError} onDismiss={() => setImportError(null)} />
            )}
          </section>
        </div>
      </section>
    </section>
  );
}
