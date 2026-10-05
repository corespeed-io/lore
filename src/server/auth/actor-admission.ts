import {
  type PostgresDatabase,
  type PostgresQueryResult,
  type PostgresStatement,
  type PostgresTransaction,
  type PostgresTransactionOptions,
  statement,
} from "@corespeed/lore-core";
import {
  type ActorContext,
  installActorContext,
  installUserContext,
  type UserContext,
} from "./actor-context";
import { type AuthPrincipal, WorkspaceAccessError } from "./auth";

interface AdmittedRow {
  user_id: string;
  agent_id: string | null;
}

/**
 * An Actor the request names but has not admitted yet. Admission is a prefix of
 * the request's first database transaction: its statements go out ahead of that
 * transaction's own, without a network wait of their own, and bind the RLS
 * settings inside PostgreSQL from what they find. A refused Actor binds nothing,
 * so RLS shows the statements behind it nothing and refuses their writes, and the
 * transaction then answers WorkspaceAccessError (403).
 *
 * A human is resolved, never registered: Membership needs a registered User, so an
 * unregistered Identity is refused either way, and the prefix stays read-only and
 * fits the engine's read-only snapshots. An Agent's credential check may record its
 * use, so an Agent is admitted in a transaction of its own before a read-only or
 * repeatable-read one, where that write would fail or could not serialize.
 */
export class PendingActor {
  readonly workspaceId: string;
  readonly kind: "human" | "agent";
  readonly #statements: readonly PostgresStatement<unknown>[];
  #admission: Promise<ActorContext> | undefined;
  #actor: ActorContext | undefined;

  private constructor(
    workspaceId: string,
    kind: "human" | "agent",
    statements: readonly PostgresStatement<unknown>[],
  ) {
    this.workspaceId = workspaceId;
    this.kind = kind;
    this.#statements = statements;
  }

  static human(principal: AuthPrincipal, workspaceId: string): PendingActor {
    return new PendingActor(workspaceId, "human", [
      statement<AdmittedRow>(
        `SELECT set_config('lore.workspace_id', $3, true),
                set_config('lore.user_id', identity.id::text, true),
                set_config('lore.agent_id', '', true),
                identity.id AS user_id,
                NULL::uuid AS agent_id
         FROM lore.resolve_identity($1, $2) AS identity`,
        [principal.provider, principal.subject, workspaceId],
      ),
      statement<{ active: boolean }>("SELECT lore.is_active_member($1) AS active", [workspaceId]),
    ]);
  }

  static agent(secretHash: string, workspaceId: string): PendingActor {
    return new PendingActor(workspaceId, "agent", [
      statement<AdmittedRow>(
        // One parameter cannot be both the setting's text and the function's uuid.
        `SELECT set_config('lore.workspace_id', $3, true),
                set_config('lore.user_id', credential.user_id::text, true),
                set_config('lore.agent_id', credential.agent_id::text, true),
                credential.user_id,
                credential.agent_id
         FROM lore.authenticate_agent_credential($1, $2) AS credential`,
        [secretHash, workspaceId, workspaceId],
      ),
    ]);
  }

  /** The admitted Actor, once its admission has returned. */
  get actor(): ActorContext | undefined {
    return this.#actor;
  }

  /** The admission sent so far, if any. */
  get admission(): Promise<ActorContext> | undefined {
    return this.#admission;
  }

  /**
   * Send the admission statements on `transaction` now, ahead of whatever it sends
   * next, as the request's one admission. A transaction that finds an admission
   * already sent binds its outcome instead (`actorTransaction`), so this refuses a
   * second one rather than leave that transaction with no Actor bound.
   */
  admitIn(transaction: PostgresTransaction): Promise<ActorContext> {
    if (this.#admission) throw new Error("This Actor's admission was already sent");
    this.#admission = transaction.batch(this.#statements).then((results) => this.#verdict(results));
    return this.#admission;
  }

  /** Admit in a transaction of its own (one round trip), unless already admitted. */
  resolve(database: PostgresDatabase): Promise<ActorContext> {
    this.#admission ??= database.transaction((transaction) =>
      transaction
        .batch(this.#statements, { commit: true })
        .then((results) => this.#verdict(results)),
    );
    return this.#admission;
  }

  #verdict(results: PostgresQueryResult<unknown>[]): ActorContext {
    const [bound, membership] = results as [
      PostgresQueryResult<AdmittedRow>,
      PostgresQueryResult<{ active: boolean }> | undefined,
    ];
    const row = bound.rows[0];
    if (!row) {
      throw new WorkspaceAccessError(
        this.kind === "agent"
          ? "Agent is not granted to this Workspace"
          : "User is not an active Workspace member",
      );
    }
    if (this.kind === "human" && membership?.rows[0]?.active !== true) {
      throw new WorkspaceAccessError("User is not an active Workspace member");
    }
    this.#actor = {
      workspaceId: this.workspaceId,
      userId: row.user_id,
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
    };
    return this.#actor;
  }
}

/** The Actor a request acts as: admitted already, or admitted by its first transaction. */
export type RequestActor = ActorContext | PendingActor;

/** The Actor once admitted, admitting it in a transaction of its own if it is pending. */
export async function admittedActor(
  database: PostgresDatabase,
  actor: RequestActor,
): Promise<ActorContext> {
  return actor instanceof PendingActor ? (actor.actor ?? actor.resolve(database)) : actor;
}

/**
 * Run `use` in a transaction bound to `actor`. A pending Actor's admission is the
 * transaction's prefix: `use` may send its first statements without awaiting
 * `admitted`, and needs it only before a statement that takes the Actor's ids as
 * parameters. A refused admission outranks whatever `use` returned or threw.
 */
export async function actorTransaction<Result>(
  database: PostgresDatabase,
  actor: RequestActor,
  use: (transaction: PostgresTransaction, admitted: Promise<ActorContext>) => Promise<Result>,
  options?: PostgresTransactionOptions,
): Promise<Result> {
  if (
    actor instanceof PendingActor &&
    !actor.admission &&
    actor.kind === "agent" &&
    (options?.readOnly || options?.isolation)
  ) {
    await actor.resolve(database);
  }
  return database.transaction(async (transaction) => {
    // Decided only once this transaction runs: of a request's concurrent
    // transactions, the first to get here sends the admission, and the others wait
    // for its outcome and bind it, before sending anything of their own.
    if (!(actor instanceof PendingActor) || actor.admission) {
      const bound = actor instanceof PendingActor ? await admittedActor(database, actor) : actor;
      installActorContext(transaction, bound);
      return use(transaction, Promise.resolve(bound));
    }
    const admitted = actor.admitIn(transaction);
    // Observed now, so a refusal that settles while `use` runs is never unhandled.
    admitted.catch(() => undefined);
    let result: Result;
    try {
      result = await use(transaction, admitted);
    } catch (error) {
      await admitted;
      throw error;
    }
    await admitted;
    return result;
  }, options);
}

interface RegisteredRow {
  user_id: string;
}

/**
 * A verified human whose Identity the request has not registered yet. Registering
 * it is the prefix of the request's first transaction, and binds the User's RLS
 * setting from the row it returns, like a pending Actor's admission.
 */
export class PendingUser {
  readonly #statement: PostgresStatement<RegisteredRow>;
  #registration: Promise<UserContext> | undefined;

  constructor(principal: AuthPrincipal) {
    this.#statement = statement<RegisteredRow>(
      `SELECT set_config('lore.workspace_id', '', true),
              set_config('lore.user_id', identity.id::text, true),
              set_config('lore.agent_id', '', true),
              identity.id AS user_id
       FROM lore.register_identity($1, $2, $3, $4, $5, $6) AS identity`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        principal.provider,
        principal.subject,
        principal.displayName,
        principal.email ?? "",
      ],
    );
  }

  /** The registration sent so far, if any. */
  get registration(): Promise<UserContext> | undefined {
    return this.#registration;
  }

  /**
   * Send the registration on `transaction` now, as the request's one registration;
   * like `PendingActor.admitIn`, it refuses a second.
   */
  registerIn(transaction: PostgresTransaction): Promise<UserContext> {
    if (this.#registration) throw new Error("This User's registration was already sent");
    this.#registration = this.#send(transaction, {});
    return this.#registration;
  }

  /** Register in a transaction of its own (one round trip), unless already registered. */
  resolve(database: PostgresDatabase): Promise<UserContext> {
    this.#registration ??= database.transaction((transaction) =>
      this.#send(transaction, { commit: true }),
    );
    return this.#registration;
  }

  async #send(
    transaction: PostgresTransaction,
    options: { commit?: boolean },
  ): Promise<UserContext> {
    const [registered] = await transaction.batch([this.#statement], options);
    const row = registered.rows[0];
    if (!row) throw new Error("Identity registration returned no User");
    return { userId: row.user_id };
  }
}

/** The human a User-scoped request acts as: registered already, or by its first transaction. */
export type RequestUser = UserContext | PendingUser;

/** Run `use` in a transaction bound to `user`, registering a pending one as its prefix. */
export async function userTransaction<Result>(
  database: PostgresDatabase,
  user: RequestUser,
  use: (transaction: PostgresTransaction, registered: Promise<UserContext>) => Promise<Result>,
): Promise<Result> {
  return database.transaction(async (transaction) => {
    // As in actorTransaction: only the first transaction to run sends it.
    if (!(user instanceof PendingUser) || user.registration) {
      const bound = user instanceof PendingUser ? await user.resolve(database) : user;
      installUserContext(transaction, bound);
      return use(transaction, Promise.resolve(bound));
    }
    const registered = user.registerIn(transaction);
    registered.catch(() => undefined);
    let result: Result;
    try {
      result = await use(transaction, registered);
    } catch (error) {
      await registered;
      throw error;
    }
    await registered;
    return result;
  });
}
