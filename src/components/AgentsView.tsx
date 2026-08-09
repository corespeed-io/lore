"use client";

import { useEffect, useRef, useState } from "react";
import { useLoreAgentCredentials, useLoreAgentMutations, useLoreAgents } from "@/lib/lore-swr";
import type {
  AgentCredential,
  AgentGrantPermission,
  IssuedAgentCredential,
  WorkspaceAgent,
} from "@/lib/types";

interface IssuedCredentialState extends IssuedAgentCredential {
  agentName: string;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function displayDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export function AgentsView({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const { data: agents = [], error, isLoading, mutate } = useLoreAgents(workspaceId);
  const mutations = useLoreAgentMutations(workspaceId);
  const [name, setName] = useState("");
  const [permission, setPermission] = useState<AgentGrantPermission>("read");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [dismissedListError, setDismissedListError] = useState<unknown>(null);
  const [issuedCredential, setIssuedCredential] = useState<IssuedCredentialState | null>(null);
  const [managedAgentId, setManagedAgentId] = useState<string | null>(null);
  const listError = error && error !== dismissedListError ? errorMessage(error) : null;
  const managedAgent = agents.find((agent) => agent.id === managedAgentId) ?? null;

  function updateAgentInList(updated: WorkspaceAgent) {
    return mutate(
      (current = []) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      { revalidate: false },
    );
  }

  async function createNewAgent() {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    setMutationError(null);
    try {
      const created = await mutations.createAgent.trigger({
        name: normalizedName,
        permission,
      });
      await mutate((current = []) => [created, ...current], { revalidate: false });
      setName("");
      setPermission("read");
    } catch (cause) {
      setMutationError(errorMessage(cause));
    }
  }

  return (
    <section className="page-wrap agents-page">
      <header className="agents-hero">
        <div>
          <p className="agents-kicker">{workspaceName}</p>
          <h1>Agents</h1>
          <p>
            Create user-owned Agents, choose their Workspace permission, and rotate their
            credentials without exposing secrets to other members.
          </p>
        </div>
        <span className="agents-count">{agents.length} total</span>
      </header>

      <form
        className="agents-create"
        onSubmit={(event) => {
          event.preventDefault();
          void createNewAgent();
        }}
      >
        <div className="agents-create-copy">
          <strong>New Agent</strong>
          <span>Access stays within this Workspace and this Agent&apos;s owner.</span>
        </div>
        <label>
          <span>Name</span>
          <input
            value={name}
            maxLength={120}
            placeholder="Research assistant"
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>Permission</span>
          <select
            value={permission}
            onChange={(event) => setPermission(event.target.value as AgentGrantPermission)}
          >
            <option value="read">Read</option>
            <option value="write">Read + write</option>
          </select>
        </label>
        <button type="submit" disabled={!name.trim() || mutations.createAgent.isMutating}>
          {mutations.createAgent.isMutating ? "Creating…" : "Create Agent"}
        </button>
      </form>

      {(mutationError || listError) && (
        <InlineError
          message={mutationError ?? listError ?? "Agent request failed"}
          onDismiss={() => {
            if (mutationError) setMutationError(null);
            else setDismissedListError(error);
          }}
        />
      )}

      {isLoading ? (
        <div className="view-placeholder">Loading Agents…</div>
      ) : agents.length === 0 ? (
        <div className="agents-empty">
          <strong>No Agents yet</strong>
          <p>Create one above, then issue its first credential when you are ready to connect it.</p>
        </div>
      ) : (
        <div className="agents-list">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              workspaceId={workspaceId}
              onAgentChange={updateAgentInList}
              onManage={() => setManagedAgentId(agent.id)}
              onIssued={(credential) =>
                setIssuedCredential({ ...credential, agentName: agent.name })
              }
            />
          ))}
        </div>
      )}

      {issuedCredential && (
        <CredentialReveal credential={issuedCredential} onClose={() => setIssuedCredential(null)} />
      )}

      {managedAgent && (
        <AgentLifecycleDialog
          agent={managedAgent}
          workspaceId={workspaceId}
          onAgentChange={updateAgentInList}
          onClose={() => setManagedAgentId(null)}
          onDeleted={async () => {
            await mutate(
              (current = []) => current.filter((candidate) => candidate.id !== managedAgent.id),
              { revalidate: false },
            );
            setManagedAgentId(null);
          }}
        />
      )}
    </section>
  );
}

function AgentCard({
  agent,
  workspaceId,
  onAgentChange,
  onManage,
  onIssued,
}: {
  agent: WorkspaceAgent;
  workspaceId: string;
  onAgentChange: (agent: WorkspaceAgent) => Promise<unknown> | unknown;
  onManage: () => void;
  onIssued: (credential: IssuedAgentCredential) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const credentials = useLoreAgentCredentials(workspaceId, agent.id, expanded);
  const mutations = useLoreAgentMutations(workspaceId);
  const unrevokedCredentialCount = (credentials.data ?? []).filter(
    (credential) => !credential.revokedAt,
  ).length;
  const agentDisabled = agent.status === "disabled";
  const displayedStatus = agentDisabled ? "disabled" : agent.grantStatus;
  const credentialsPanelId = `agent-${agent.id}-credentials`;

  async function setGrant(permission: AgentGrantPermission) {
    setMutationError(null);
    try {
      const grant = await mutations.setGrant.trigger({ agentId: agent.id, permission });
      await onAgentChange({
        ...agent,
        permission: grant.permission,
        grantStatus: grant.status,
        updatedAt: grant.updatedAt,
      });
    } catch (cause) {
      setMutationError(errorMessage(cause));
    }
  }

  async function revokeGrant() {
    if (!window.confirm(`Revoke ${agent.name}'s access to this Workspace?`)) return;
    setMutationError(null);
    try {
      await mutations.revokeGrant.trigger({ agentId: agent.id });
      await onAgentChange({
        ...agent,
        grantStatus: "revoked",
        updatedAt: new Date().toISOString(),
      });
    } catch (cause) {
      setMutationError(errorMessage(cause));
    }
  }

  async function restoreGrant() {
    const credentialEffect = agentDisabled
      ? "This Agent remains disabled, so its credentials cannot authenticate until the Agent is re-enabled."
      : "Every unrevoked credential for this Agent will be able to authenticate here again.";
    if (!window.confirm(`Restore ${agent.name}'s access to this Workspace? ${credentialEffect}`)) {
      return;
    }
    await setGrant(agent.permission);
  }

  async function issueCredential() {
    setMutationError(null);
    try {
      const issued = await mutations.issueCredential.trigger({ agentId: agent.id });
      onIssued(issued);
      await credentials.mutate();
    } catch (cause) {
      setMutationError(errorMessage(cause));
    }
  }

  async function revokeCredential(credential: AgentCredential) {
    if (!window.confirm(`Revoke credential lore_agent_${credential.prefix}…?`)) return;
    setMutationError(null);
    try {
      await mutations.revokeCredential.trigger({ credentialId: credential.id });
      await credentials.mutate(
        (current = []) =>
          current.map((candidate) =>
            candidate.id === credential.id
              ? { ...candidate, revokedAt: new Date().toISOString() }
              : candidate,
          ),
        { revalidate: false },
      );
    } catch (cause) {
      setMutationError(errorMessage(cause));
    }
  }

  const busy = mutations.isMutating;

  return (
    <article className={`agent-card${displayedStatus !== "active" ? " agent-revoked" : ""}`}>
      <div className="agent-card-main">
        <div className="agent-avatar" aria-hidden="true">
          {agent.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="agent-identity">
          <div className="agent-name-row">
            <h2>{agent.name}</h2>
            <span className={`agent-status agent-status-${displayedStatus}`}>
              {displayedStatus}
            </span>
          </div>
          <code>{agent.id}</code>
          <span>Created {displayDate(agent.createdAt)}</span>
          {agentDisabled && (
            <span>Disabled Agents cannot authenticate or receive credentials.</span>
          )}
        </div>
        <div className="agent-controls">
          <label>
            <span>Workspace permission</span>
            <select
              value={agent.permission}
              disabled={busy || agent.grantStatus === "revoked"}
              onChange={(event) => void setGrant(event.target.value as AgentGrantPermission)}
            >
              <option value="read">Read</option>
              <option value="write">Read + write</option>
            </select>
          </label>
          {agent.grantStatus === "active" ? (
            <button type="button" className="agent-danger" disabled={busy} onClick={revokeGrant}>
              Revoke access
            </button>
          ) : (
            <button
              type="button"
              className="agent-primary"
              disabled={busy}
              onClick={() => void restoreGrant()}
            >
              Restore access
            </button>
          )}
          <button type="button" className="agent-manage" disabled={busy} onClick={onManage}>
            Manage
          </button>
        </div>
      </div>

      {mutationError && (
        <InlineError message={mutationError} onDismiss={() => setMutationError(null)} />
      )}

      <div className="agent-credentials-toggle">
        <button
          type="button"
          aria-controls={credentialsPanelId}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          Credentials
          {expanded && !credentials.isLoading && (
            <small>{unrevokedCredentialCount} unrevoked</small>
          )}
        </button>
      </div>

      {expanded && (
        <section
          id={credentialsPanelId}
          className="agent-credentials"
          aria-label={`${agent.name} credentials`}
        >
          <div className="agent-credentials-head">
            <div>
              <strong>Credentials</strong>
              <p>Secrets are shown once. Stored records contain only a prefix and hash.</p>
              {agent.grantStatus === "revoked" && unrevokedCredentialCount > 0 && (
                <p className="agent-credential-warning">
                  {agentDisabled
                    ? "Restoring this grant preserves Workspace access, but credentials stay blocked while the Agent is disabled."
                    : "Restoring access will let every unrevoked credential authenticate in this Workspace again."}
                </p>
              )}
            </div>
            <button
              type="button"
              className="agent-primary"
              disabled={busy || agent.grantStatus !== "active" || agentDisabled}
              onClick={() => void issueCredential()}
            >
              {mutations.issueCredential.isMutating ? "Issuing…" : "Issue credential"}
            </button>
          </div>

          {credentials.error ? (
            <InlineError
              message={errorMessage(credentials.error)}
              onDismiss={() => setExpanded(false)}
            />
          ) : credentials.isLoading ? (
            <p className="agent-credential-empty">Loading credentials…</p>
          ) : credentials.data?.length ? (
            <div className="agent-credential-list">
              {credentials.data.map((credential) => (
                <div className="agent-credential-row" key={credential.id}>
                  <div>
                    <code>lore_agent_{credential.prefix}…</code>
                    <span>
                      Created {displayDate(credential.createdAt)} · Last used{" "}
                      {displayDate(credential.lastUsedAt)}
                    </span>
                  </div>
                  {credential.revokedAt ? (
                    <span className="agent-status agent-status-revoked">revoked</span>
                  ) : (
                    <button
                      type="button"
                      className="agent-danger"
                      disabled={busy}
                      onClick={() => void revokeCredential(credential)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="agent-credential-empty">No credentials issued yet.</p>
          )}
        </section>
      )}
    </article>
  );
}

function AgentLifecycleDialog({
  agent,
  workspaceId,
  onAgentChange,
  onDeleted,
  onClose,
}: {
  agent: WorkspaceAgent;
  workspaceId: string;
  onAgentChange: (agent: WorkspaceAgent) => Promise<unknown> | unknown;
  onDeleted: () => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [renameValue, setRenameValue] = useState(agent.name);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"delete" | "rename" | "status" | null>(null);
  const mutations = useLoreAgentMutations(workspaceId);
  const busy =
    pendingAction !== null || mutations.updateAgent.isMutating || mutations.deleteAgent.isMutating;
  const agentDisabled = agent.status === "disabled";
  const normalizedName = renameValue.trim();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    closeButtonRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    setRenameValue(agent.name);
    setDeleteConfirmation("");
  }, [agent.name]);

  async function saveRename() {
    if (!normalizedName || normalizedName === agent.name) return;
    setMutationError(null);
    setPendingAction("rename");
    try {
      const updated = await mutations.updateAgent.trigger({
        agentId: agent.id,
        name: normalizedName,
      });
      await onAgentChange(updated);
    } catch (cause) {
      setMutationError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function changeStatus(status: WorkspaceAgent["status"]) {
    setMutationError(null);
    setPendingAction("status");
    try {
      const updated = await mutations.updateAgent.trigger({ agentId: agent.id, status });
      await onAgentChange(updated);
    } catch (cause) {
      setMutationError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function permanentlyDelete() {
    if (!agentDisabled || deleteConfirmation !== agent.name) return;
    setMutationError(null);
    setPendingAction("delete");
    try {
      await mutations.deleteAgent.trigger({ agentId: agent.id });
      await onDeleted();
    } catch (cause) {
      setMutationError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="agent-lifecycle-dialog"
      aria-modal="true"
      aria-labelledby="agent-lifecycle-title"
      aria-describedby="agent-lifecycle-summary"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="agent-lifecycle-head">
        <div>
          <p className="memory-editor-kicker">Global Agent identity</p>
          <h2 id="agent-lifecycle-title">Manage {agent.name}</h2>
          <code>{agent.id}</code>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className="agent-lifecycle-close"
          disabled={busy}
          onClick={onClose}
        >
          Close
        </button>
      </header>

      <p id="agent-lifecycle-summary" className="agent-lifecycle-summary">
        This Agent belongs to you, not to one Workspace. Name and status changes apply everywhere it
        has a grant.
      </p>

      {mutationError && (
        <InlineError message={mutationError} onDismiss={() => setMutationError(null)} />
      )}

      <section className="agent-lifecycle-section" aria-labelledby="agent-rename-title">
        <div>
          <h3 id="agent-rename-title">Name</h3>
          <p>Rename this Agent across every Workspace where it appears.</p>
        </div>
        <form
          className="agent-rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
        >
          <label>
            <span>Agent name</span>
            <input
              value={renameValue}
              maxLength={120}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="agent-lifecycle-primary"
            disabled={!normalizedName || normalizedName === agent.name || busy}
          >
            {pendingAction === "rename" ? "Saving…" : "Save name"}
          </button>
        </form>
      </section>

      <section className="agent-lifecycle-section" aria-labelledby="agent-status-title">
        <div>
          <div className="agent-lifecycle-title-row">
            <h3 id="agent-status-title">Authentication status</h3>
            <span className={`agent-status agent-status-${agent.status}`}>{agent.status}</span>
          </div>
          {agentDisabled ? (
            <p>
              Re-enabling lets unrevoked credentials authenticate wherever you remain an active
              Workspace member and this Agent has an active grant. Revoked grants and credentials
              stay revoked.
            </p>
          ) : (
            <p>
              Disabling immediately blocks every credential in every Workspace. Grants and
              credential metadata remain available for diagnosis and recovery.
            </p>
          )}
        </div>
        <button
          type="button"
          className={agentDisabled ? "agent-lifecycle-primary" : "agent-lifecycle-secondary"}
          disabled={busy}
          onClick={() => void changeStatus(agentDisabled ? "active" : "disabled")}
        >
          {pendingAction === "status"
            ? "Updating…"
            : agentDisabled
              ? "Re-enable Agent"
              : "Disable Agent"}
        </button>
      </section>

      <section
        className="agent-lifecycle-section agent-lifecycle-danger-zone"
        aria-labelledby="agent-delete-title"
      >
        <div>
          <h3 id="agent-delete-title">Delete Agent</h3>
          <p>
            Permanently removes all Workspace grants and credentials. Memories remain, but their
            creating-Agent reference is cleared. The Agent must be disabled first.
          </p>
        </div>
        {agentDisabled ? (
          <div className="agent-delete-confirmation">
            <label>
              <span>
                Type <strong>{agent.name}</strong> to confirm
              </span>
              <input
                value={deleteConfirmation}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="agent-lifecycle-delete"
              disabled={deleteConfirmation !== agent.name || busy}
              onClick={() => void permanentlyDelete()}
            >
              {pendingAction === "delete" ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        ) : (
          <p className="agent-delete-gate">Disable this Agent before permanent deletion.</p>
        )}
      </section>
    </dialog>
  );
}

function CredentialReveal({
  credential,
  onClose,
}: {
  credential: IssuedCredentialState;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    copyButtonRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(credential.token);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="credential-reveal"
      aria-modal="true"
      aria-labelledby="credential-title"
      onCancel={(event) => event.preventDefault()}
    >
      <p className="memory-editor-kicker">One-time secret</p>
      <h2 id="credential-title">Credential for {credential.agentName}</h2>
      <p>Copy this token now. Lore stores only its hash and cannot show it again.</p>
      <code>{credential.token}</code>
      <p className="credential-copy-status" role="status" aria-live="polite">
        {copyState === "copied"
          ? "Copied to clipboard."
          : copyState === "failed"
            ? "Clipboard access failed. Select the token and copy it manually."
            : "Keep this dialog open until the token is stored safely."}
      </p>
      <div className="credential-reveal-actions">
        <button ref={copyButtonRef} type="button" onClick={() => void copyToken()}>
          {copyState === "copied" ? "Copied" : "Copy token"}
        </button>
        <button type="button" className="agent-primary" onClick={onClose}>
          I saved it
        </button>
      </div>
    </dialog>
  );
}

function InlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="agents-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
