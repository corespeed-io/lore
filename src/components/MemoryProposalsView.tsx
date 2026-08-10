"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { memoryTitle } from "@/lib/lore-api";
import {
  loreKeys,
  useLoreAgents,
  useLoreMemory,
  useLoreMemoryProposalMutations,
  useLoreMemoryProposals,
} from "@/lib/lore-swr";
import type { MemoryProposal, MemoryProposalReviewResult, MemoryProposalStatus } from "@/lib/types";

interface MemoryProposalsViewProps {
  workspaceId: string;
  workspaceName: string;
  onOpenMemory: (memoryId: string) => void;
  onReviewed: (result: MemoryProposalReviewResult) => Promise<void>;
}

const FILTERS: Array<{ label: string; status: MemoryProposalStatus }> = [
  { label: "Pending", status: "pending" },
  { label: "Accepted", status: "accepted" },
  { label: "Rejected", status: "rejected" },
];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function compact(value: string, limit = 112): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized;
}

function utcDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function MemoryProposalsView({
  workspaceId,
  workspaceName,
  onOpenMemory,
  onReviewed,
}: MemoryProposalsViewProps) {
  const [status, setStatus] = useState<MemoryProposalStatus>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<MemoryProposalReviewResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedRequestError, setDismissedRequestError] = useState<string | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const {
    data: proposalData,
    error: requestError,
    isLoading,
    mutate: mutateProposals,
  } = useLoreMemoryProposals(workspaceId, status);
  const proposals = proposalData ?? [];
  const { data: agents = [] } = useLoreAgents(workspaceId);
  const mutations = useLoreMemoryProposalMutations(workspaceId);
  const selected =
    receipt?.proposal.id === selectedId
      ? receipt.proposal
      : (proposals.find((proposal) => proposal.id === selectedId) ?? null);
  const receiptMemoryId = receipt?.memory?.id ?? null;
  const targetId = selected?.kind === "update" ? selected.targetMemoryId : null;
  const {
    data: targetMemory,
    error: targetError,
    isLoading: targetLoading,
  } = useLoreMemory(workspaceId, targetId);
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const requestErrorMessage = requestError ? errorMessage(requestError) : null;
  const visibleRequestError =
    requestErrorMessage === dismissedRequestError ? null : requestErrorMessage;
  const targetChanged = Boolean(
    selected?.status === "pending" &&
      selected.kind === "update" &&
      (!targetMemory || targetMemory.version !== selected.baseMemoryVersion),
  );

  useEffect(() => {
    if (!selectedId && proposals[0]) setSelectedId(proposals[0].id);
    if (selectedId && !receipt && !proposals.some((proposal) => proposal.id === selectedId)) {
      setSelectedId(proposals[0]?.id ?? null);
    }
  }, [proposals, receipt, selectedId]);

  function submitter(proposal: MemoryProposal): string {
    if (proposal.proposedByActorKind === "human") return "Human submission";
    if (!proposal.proposedByAgentId) return "Removed Agent";
    return agentNames.get(proposal.proposedByAgentId) ?? "Agent";
  }

  function selectProposal(id: string) {
    setSelectedId(id);
    setReceipt(null);
    setActionError(null);
    window.requestAnimationFrame(() => reviewHeadingRef.current?.focus());
  }

  function selectStatus(nextStatus: MemoryProposalStatus) {
    setStatus(nextStatus);
    setSelectedId(null);
    setReceipt(null);
    setActionError(null);
    setDismissedRequestError(null);
  }

  async function review(decision: "accept" | "reject") {
    if (selected?.status !== "pending") return;
    if (
      decision === "reject" &&
      !window.confirm(
        "Reject this proposal? It will remain in recent history for up to 30 days and cannot be reopened.",
      )
    ) {
      return;
    }
    setActionError(null);
    let result: MemoryProposalReviewResult;
    try {
      result = await mutations.reviewProposal.trigger({
        proposalId: selected.id,
        decision,
      });
    } catch (cause) {
      setActionError(errorMessage(cause));
      if (selected.kind === "update" && selected.targetMemoryId) {
        await Promise.allSettled([
          mutateProposals(),
          mutations.mutateCache(loreKeys.memory(workspaceId, selected.targetMemoryId), undefined, {
            revalidate: true,
          }),
        ]);
      }
      return;
    }

    setReceipt(result);
    await Promise.allSettled([
      result.memory
        ? mutations.mutateCache(loreKeys.memory(workspaceId, result.memory.id), result.memory, {
            revalidate: false,
          })
        : Promise.resolve(undefined),
      mutateProposals(),
      mutations.mutateCache(loreKeys.memoryProposals(workspaceId, result.proposal.status)),
      onReviewed(result),
    ]);
  }

  return (
    <section className="page-wrap proposal-page" aria-labelledby="proposal-page-title">
      <header className="proposal-page-header">
        <div>
          <p className="proposal-page-kicker">Memory governance</p>
          <h1 id="proposal-page-title">Proposal inbox</h1>
          <p className="proposal-page-summary">
            Review suggestions for {workspaceName}. Nothing here becomes searchable Memory until you
            accept it.
          </p>
        </div>
        <div className="proposal-safety-note">
          <strong>Human approval required</strong>
          <span>Agents can submit; only you can make a proposal canonical.</span>
        </div>
      </header>

      <fieldset className="proposal-filters">
        <legend>Proposal status</legend>
        {FILTERS.map((filter) => (
          <button
            key={filter.status}
            type="button"
            aria-pressed={status === filter.status}
            onClick={() => selectStatus(filter.status)}
          >
            {filter.label}
          </button>
        ))}
      </fieldset>

      {visibleRequestError && (
        <div className="native-error proposal-error" role="alert">
          <span>{visibleRequestError}</span>
          <button type="button" onClick={() => setDismissedRequestError(visibleRequestError)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="proposal-workspace">
        <aside className="proposal-inbox" aria-label={`${status} Memory Proposals`}>
          <div className="proposal-inbox-heading">
            <span>{FILTERS.find((filter) => filter.status === status)?.label}</span>
            <span>{proposals.length}</span>
          </div>
          {isLoading ? (
            <p className="proposal-inbox-state">Loading proposals…</p>
          ) : requestError && proposalData === undefined ? (
            <div className="proposal-inbox-empty">
              <strong>Inbox unavailable</strong>
              <span>Lore could not verify this inbox. It will retry automatically.</span>
            </div>
          ) : proposals.length === 0 ? (
            <div className="proposal-inbox-empty">
              <strong>{status === "pending" ? "Inbox clear" : `No ${status} proposals`}</strong>
              <span>
                {status === "pending"
                  ? "Agent suggestions will wait here without changing canonical Memory."
                  : "The latest reviewed proposals will appear here as recent history."}
              </span>
            </div>
          ) : (
            <ul className="proposal-list">
              {proposals.map((proposal) => (
                <li key={proposal.id}>
                  <button
                    type="button"
                    aria-current={selected?.id === proposal.id ? "true" : undefined}
                    onClick={() => selectProposal(proposal.id)}
                  >
                    <span className="proposal-row-meta">
                      <span>{proposal.kind === "create" ? "New Memory" : "Update"}</span>
                      <time dateTime={proposal.createdAt}>{utcDate(proposal.createdAt)} UTC</time>
                    </span>
                    <strong>{compact(proposal.proposedContent)}</strong>
                    <span className="proposal-row-foot">
                      {submitter(proposal)} · {proposal.proposedScope}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <article className="proposal-review" aria-label="Proposal review">
          {!selected ? (
            <div className="proposal-review-empty">
              <span aria-hidden="true">↳</span>
              <strong>Select a proposal to inspect it</strong>
              <p>Complete content, evidence, metadata, and version safety appear here.</p>
            </div>
          ) : (
            <>
              <header className="proposal-review-header">
                <div>
                  <p className="proposal-page-kicker">
                    {selected.kind === "create" ? "Create suggestion" : "Update suggestion"}
                  </p>
                  <h2 id="proposal-review-title" ref={reviewHeadingRef} tabIndex={-1}>
                    {selected.kind === "create" ? "Review a new Memory" : "Review a Memory change"}
                  </h2>
                </div>
                <span className="proposal-review-status">{selected.status}</span>
              </header>

              <dl className="proposal-facts">
                <div>
                  <dt>Submitted by</dt>
                  <dd>{submitter(selected)}</dd>
                </div>
                <div>
                  <dt>Visibility</dt>
                  <dd>{selected.proposedScope}</dd>
                </div>
                <div>
                  <dt>Submitted</dt>
                  <dd>{utcDate(selected.createdAt)} UTC</dd>
                </div>
                {selected.kind === "update" && (
                  <div>
                    <dt>Base version</dt>
                    <dd>v{selected.baseMemoryVersion}</dd>
                  </div>
                )}
                {selected.reviewedAt && (
                  <div>
                    <dt>Reviewed</dt>
                    <dd>{utcDate(selected.reviewedAt)} UTC</dd>
                  </div>
                )}
                {selected.status === "accepted" && selected.acceptedMemoryId && (
                  <div>
                    <dt>Canonical Memory</dt>
                    <dd>
                      <button
                        type="button"
                        className="proposal-memory-link"
                        onClick={() => {
                          if (selected.acceptedMemoryId) onOpenMemory(selected.acceptedMemoryId);
                        }}
                      >
                        Open accepted Memory
                      </button>
                    </dd>
                  </div>
                )}
              </dl>

              {selected.kind === "update" && (
                <section className="proposal-target" aria-labelledby="proposal-target-title">
                  <div>
                    <p className="proposal-section-label">Current canonical Memory</p>
                    <h3 id="proposal-target-title">
                      {targetMemory ? memoryTitle(targetMemory) : "Target Memory"}
                    </h3>
                    <span>
                      {targetLoading
                        ? "Loading current version…"
                        : targetMemory
                          ? `Current v${targetMemory.version} · proposal based on v${selected.baseMemoryVersion}`
                          : "The target is no longer available."}
                    </span>
                  </div>
                  {targetMemory && (
                    <button type="button" onClick={() => onOpenMemory(targetMemory.id)}>
                      Open Memory
                    </button>
                  )}
                </section>
              )}

              {selected.kind === "update" && targetMemory && (
                <section className="proposal-content-block proposal-current-content">
                  <h3>Current content</h3>
                  <div>{targetMemory.content}</div>
                </section>
              )}

              <section className="proposal-content-block">
                <h3>Proposed content</h3>
                <div>{selected.proposedContent}</div>
              </section>

              <details className="proposal-metadata">
                <summary>Proposed metadata</summary>
                <pre>{JSON.stringify(selected.proposedMetadata, null, 2)}</pre>
              </details>

              <section className="proposal-evidence" aria-labelledby="proposal-evidence-title">
                <h3 id="proposal-evidence-title">Evidence Memories</h3>
                {selected.evidenceMemoryIds.length ? (
                  <ul>
                    {selected.evidenceMemoryIds.map((memoryId, index) => (
                      <li key={memoryId}>
                        <button type="button" onClick={() => onOpenMemory(memoryId)}>
                          Evidence {index + 1}
                          <span>{memoryId}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No evidence Memories were attached to this proposal.</p>
                )}
              </section>

              {selected.kind === "update" && targetChanged && !targetLoading && (
                <div className="proposal-conflict" role="alert">
                  <strong>Review required on a fresh proposal</strong>
                  <span>
                    {targetError || !targetMemory
                      ? "The target Memory is unavailable, so this proposal cannot be accepted."
                      : `The target is now v${targetMemory.version}; this proposal was based on v${selected.baseMemoryVersion}. Lore will not silently rebase it.`}
                  </span>
                </div>
              )}

              {receipt && receipt.proposal.id === selected.id && (
                <div className="proposal-receipt" role="status">
                  <strong>
                    {receipt.proposal.status === "accepted"
                      ? receipt.proposal.kind === "create"
                        ? "Canonical Memory created"
                        : "Canonical Memory updated"
                      : "Proposal rejected"}
                  </strong>
                  <span>
                    {receipt.proposal.status === "accepted"
                      ? "The accepted content is now available through ordinary Memory authorization and retrieval."
                      : "Canonical Memory was not changed."}
                  </span>
                  {receiptMemoryId && (
                    <button type="button" onClick={() => onOpenMemory(receiptMemoryId)}>
                      Open accepted Memory
                    </button>
                  )}
                </div>
              )}

              {actionError && (
                <div className="native-error proposal-error" role="alert">
                  <span>{actionError}</span>
                  <button type="button" onClick={() => setActionError(null)}>
                    Dismiss
                  </button>
                </div>
              )}

              {selected.status === "pending" && !receipt && (
                <footer className="proposal-actions">
                  <button
                    type="button"
                    className="proposal-reject"
                    disabled={mutations.isMutating}
                    onClick={() => void review("reject")}
                  >
                    {mutations.isMutating ? "Reviewing…" : "Reject proposal"}
                  </button>
                  <button
                    type="button"
                    className="proposal-accept"
                    disabled={mutations.isMutating || targetChanged || targetLoading}
                    onClick={() => void review("accept")}
                  >
                    {mutations.isMutating ? "Reviewing…" : "Accept into Memory"}
                  </button>
                </footer>
              )}
            </>
          )}
        </article>
      </div>
    </section>
  );
}
