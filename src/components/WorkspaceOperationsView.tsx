"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const tone = ["ready", "loaded"].includes(normalized)
    ? "ok"
    : normalized === "disabled"
      ? "neutral"
      : ["degraded", "unknown"].includes(normalized)
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
  const archiveSelection = useRef(0);
  const [selectedArchive, setSelectedArchive] = useState<SelectedArchive | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState<WorkspaceImportConflictPolicy>("remap");
  const [validatedFingerprint, setValidatedFingerprint] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<WorkspaceImportResult | null>(null);
  const [importResult, setImportResult] = useState<WorkspaceImportResult | null>(null);
  const [exportReceipt, setExportReceipt] = useState<WorkspaceArchive["manifest"] | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dismissedReadinessError, setDismissedReadinessError] = useState<string | null>(null);
  const [dismissedCapabilitiesError, setDismissedCapabilitiesError] = useState<string | null>(null);
  const [dismissedActorError, setDismissedActorError] = useState<string | null>(null);

  useEffect(() => {
    if (!readiness.error) setDismissedReadinessError(null);
  }, [readiness.error]);
  useEffect(() => {
    if (!capabilities.error) setDismissedCapabilitiesError(null);
  }, [capabilities.error]);
  useEffect(() => {
    if (!currentActor.error) setDismissedActorError(null);
  }, [currentActor.error]);

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
  const readinessErrorMessage = readiness.error ? errorMessage(readiness.error) : null;
  const readinessError =
    readinessErrorMessage !== dismissedReadinessError ? readinessErrorMessage : null;
  const capabilitiesErrorMessage = capabilities.error ? errorMessage(capabilities.error) : null;
  const capabilitiesError =
    capabilitiesErrorMessage !== dismissedCapabilitiesError ? capabilitiesErrorMessage : null;
  const actorErrorMessage = currentActor.error ? errorMessage(currentActor.error) : null;
  const actorError = actorErrorMessage !== dismissedActorError ? actorErrorMessage : null;

  function resetValidation() {
    setValidatedFingerprint(null);
    setDryRunResult(null);
    setImportResult(null);
    setImportError(null);
  }

  async function selectArchive(file: File | undefined) {
    if (!file) return;
    const selection = ++archiveSelection.current;
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
      const text = await file.text();
      if (selection !== archiveSelection.current) return;
      const archive = parseWorkspaceArchiveText(text);
      setSelectedArchive({ archive, fileName: file.name, fileSize: file.size });
      setConflictPolicy("remap");
    } catch (cause) {
      if (selection !== archiveSelection.current) return;
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
    if (busy || importResult || !input || !inputFingerprint) return;
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
    if (busy || importResult || !input || !dryRunResult || !dryRunIsCurrent) return;
    if (dryRunResult.replayed) return;
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
          {!readinessReport ? (
            readinessError ? (
              <InlineError
                message={readinessError}
                onDismiss={() => setDismissedReadinessError(readinessError)}
              />
            ) : (
              <p className="operations-loading">Checking the request path…</p>
            )
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
              {readinessError && (
                <InlineError
                  message={readinessError}
                  onDismiss={() => setDismissedReadinessError(readinessError)}
                />
              )}
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
          {!deploymentCapabilities ? (
            capabilitiesError ? (
              <InlineError
                message={capabilitiesError}
                onDismiss={() => setDismissedCapabilitiesError(capabilitiesError)}
              />
            ) : (
              <p className="operations-loading">Loading capabilities…</p>
            )
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
                        <span
                          className={
                            available
                              ? "operations-feature-available"
                              : "operations-feature-unavailable"
                          }
                          aria-hidden="true"
                        >
                          {available ? "✓" : "—"}
                        </span>
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
              {capabilitiesError && (
                <InlineError
                  message={capabilitiesError}
                  onDismiss={() => setDismissedCapabilitiesError(capabilitiesError)}
                />
              )}
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
                  {currentActor.data ? (
                    <div className="operations-owner-target">
                      <strong>You</strong>
                      <code>{currentActor.data.userId}</code>
                    </div>
                  ) : actorError ? (
                    <InlineError
                      message={actorError}
                      onDismiss={() => setDismissedActorError(actorError)}
                    />
                  ) : (
                    <span className="operations-loading">Resolving the importing human…</span>
                  )}
                  {currentActor.data && actorError && (
                    <InlineError
                      message={actorError}
                      onDismiss={() => setDismissedActorError(actorError)}
                    />
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
                        disabled={busy || Boolean(importResult)}
                        onChange={() => {
                          setConflictPolicy(policy);
                          resetValidation();
                        }}
                      />
                      <span>
                        <strong>{policy}</strong>
                        <small>
                          {policy === "remap"
                            ? "Import every Memory with a fresh ID, including visible source-ID collisions."
                            : policy === "skip"
                              ? "Skip visible source-ID collisions; imported Memories still receive fresh IDs."
                              : "Reject visible source-ID collisions; imported Memories still receive fresh IDs."}
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
                    disabled={!ownerIdValid || busy || Boolean(importResult)}
                    onClick={() => void validateImport()}
                  >
                    {mutations.validateImport.isMutating ? "Validating…" : "Run dry check"}
                  </button>
                  <button
                    type="button"
                    className="operations-primary"
                    disabled={
                      !dryRunIsCurrent ||
                      busy ||
                      Boolean(importResult) ||
                      Boolean(dryRunResult?.replayed)
                    }
                    onClick={() => void commitImport()}
                  >
                    {mutations.importArchive.isMutating ? "Importing…" : "Import archive"}
                  </button>
                </div>

                {dryRunIsCurrent && dryRunResult && (
                  <div className="operations-dry-run" role="status">
                    <span aria-hidden="true">✓</span>
                    <div>
                      <strong>
                        {dryRunResult.replayed ? "Archive already imported" : "Dry check passed"}
                      </strong>
                      {dryRunResult.replayed ? (
                        <p>
                          Lore already has a completed receipt for this checksum. Importing it again
                          would write no Memories or Links.
                        </p>
                      ) : (
                        <p>
                          Ready to import {dryRunResult.importedMemories} Memories and{" "}
                          {dryRunResult.importedLinks} Links.{" "}
                          {conflictPolicy === "skip"
                            ? `${dryRunResult.skippedMemories} visible collisions will be skipped.`
                            : conflictPolicy === "remap"
                              ? "Every imported Memory will receive a fresh ID."
                              : "No visible source-ID collisions were found."}
                        </p>
                      )}
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
