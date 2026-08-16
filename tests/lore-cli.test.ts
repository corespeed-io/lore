import { LORE_CLI_VERSION, type LoreCliIo, runLoreCli } from "@corespeed/lore-cli";
import { expect, test, vi } from "vitest";
import { readBoundedUtf8Stdin } from "../packages/cli/src/stdin.js";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_TOKEN = `lore_agent_${"a".repeat(64)}`;

function captureIo(input = ""): { io: LoreCliIo; stderr: string[]; stdout: string[] } {
  const stderr: string[] = [];
  const stdout: string[] = [];
  return {
    stderr,
    stdout,
    io: {
      stdin: async () => input,
      stderr: (value) => stderr.push(value),
      stdout: (value) => stdout.push(value),
    },
  };
}

test("CLI remembers through the SDK without accepting secret flags", async () => {
  const captured = captureIo();
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      id: "20000000-0000-4000-8000-000000000001",
      workspaceId: WORKSPACE_ID,
      ownerUserId: "30000000-0000-4000-8000-000000000001",
      createdByAgentId: "40000000-0000-4000-8000-000000000001",
      scope: "private",
      content: "Keep this",
      metadata: { source: "cli" },
      version: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }),
  );

  const exitCode = await runLoreCli(
    [
      "memory",
      "remember",
      "Keep this",
      "--scope",
      "private",
      "--metadata",
      '{"source":"cli"}',
      "--idempotency-key",
      "remember-1",
    ],
    {
      environment: {
        LORE_URL: "https://lore.example.test",
        LORE_WORKSPACE_ID: WORKSPACE_ID,
        LORE_AGENT_TOKEN: AGENT_TOKEN,
      },
      fetch: fetchMock,
      io: captured.io,
    },
  );

  expect(exitCode).toBe(0);
  expect(captured.stderr).toEqual([]);
  expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ content: "Keep this" });
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(url.pathname).toBe("/api/v1/memories");
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${AGENT_TOKEN}`);
  expect(new Headers(init.headers).get("idempotency-key")).toBe("remember-1");
  expect(JSON.parse(String(init.body))).toEqual({
    content: "Keep this",
    scope: "private",
    metadata: { source: "cli" },
  });
});

test("CLI queries bounded exact-revision Code Dependencies without accepting a local path", async () => {
  const captured = captureIo();
  const commitOid = "a".repeat(40);
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      status: "ok",
      repositoryKey: "corespeed/lore",
      commitOid,
      direction: "callers",
      subject: {
        artifactId: "80000000-0000-4000-8000-000000000001",
        path: "src/guard.ts",
        symbol: "guard",
        symbolKey: "src/guard.ts#function_declaration:guard",
      },
      edges: [],
      truncated: false,
    }),
  );

  const exitCode = await runLoreCli(
    [
      "code",
      "dependencies",
      "callers",
      "--repository",
      "corespeed/lore",
      "--commit",
      commitOid,
      "--symbol",
      "guard",
      "--limit",
      "25",
    ],
    {
      environment: {
        LORE_URL: "https://lore.example.test",
        LORE_WORKSPACE_ID: WORKSPACE_ID,
        LORE_AGENT_TOKEN: AGENT_TOKEN,
      },
      fetch: fetchMock,
      io: captured.io,
    },
  );

  expect(exitCode).toBe(0);
  expect(captured.stderr).toEqual([]);
  const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(url.pathname + url.search).toBe(
    `/api/v1/code/dependencies?repository_key=corespeed%2Flore&commit_oid=${commitOid}&direction=callers&symbol=guard&limit=25`,
  );
  expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
    status: "ok",
    direction: "callers",
    subject: { symbol: "guard" },
  });
});

test("CLI rejects document-sized Memory content before sending a request", async () => {
  const captured = captureIo(`${"😀".repeat(32_001)}\n`);
  const fetchMock = vi.fn();

  const exitCode = await runLoreCli(["memory", "remember", "--stdin"], {
    environment: { LORE_WORKSPACE_ID: WORKSPACE_ID },
    fetch: fetchMock,
    io: captured.io,
  });

  expect(exitCode).toBe(2);
  expect(captured.stderr.join("")).toMatch(/at most 32000 Unicode characters/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("CLI submits a non-canonical proposal with evidence and a stable retry key", async () => {
  const captured = captureIo("A safer suggested fact\n");
  const evidenceId = "20000000-0000-4000-8000-000000000002";
  const artifactId = "80000000-0000-4000-8000-000000000001";
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      id: "50000000-0000-4000-8000-000000000001",
      workspaceId: WORKSPACE_ID,
      ownerUserId: "30000000-0000-4000-8000-000000000001",
      proposedByActorKind: "agent",
      proposedByAgentId: "40000000-0000-4000-8000-000000000001",
      kind: "create",
      targetMemoryId: null,
      baseMemoryVersion: null,
      proposedContent: "A safer suggested fact",
      proposedScope: "private",
      proposedMetadata: {},
      evidenceMemoryIds: [evidenceId],
      evidenceObservationIds: [],
      codeEvidence: [
        {
          ordinal: 0,
          repositoryId: "80000000-0000-4000-8000-000000000002",
          citedRevisionId: "80000000-0000-4000-8000-000000000003",
          citedGenerationId: "80000000-0000-4000-8000-000000000004",
          citedArtifactId: artifactId,
          citedCommitOid: "a".repeat(40),
          citedPath: "src/guard.ts",
          citedSymbolKey: "src/guard.ts#function_declaration:guard",
          citedDeclarationKey: "src/guard.ts#function_declaration:guard",
          citedDeclarationChunkOrdinal: 0,
          citedDeclarationContextSha256: "c".repeat(64),
          citedContentSha256: "b".repeat(64),
          relationship: "implements",
        },
      ],
      status: "pending",
      reviewedByUserId: null,
      acceptedMemoryId: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      reviewedAt: null,
    }),
  );

  const exitCode = await runLoreCli(
    [
      "memory",
      "propose",
      "create",
      "--stdin",
      "--scope",
      "private",
      "--evidence",
      evidenceId,
      "--code-evidence",
      `${artifactId}:implements`,
      "--idempotency-key",
      "proposal-1",
    ],
    {
      environment: {
        LORE_URL: "https://lore.example.test",
        LORE_WORKSPACE_ID: WORKSPACE_ID,
        LORE_AGENT_TOKEN: AGENT_TOKEN,
      },
      fetch: fetchMock,
      io: captured.io,
    },
  );

  expect(exitCode).toBe(0);
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(url.pathname).toBe("/api/v1/memory-proposals");
  expect(new Headers(init.headers).get("idempotency-key")).toBe("proposal-1");
  expect(JSON.parse(String(init.body))).toEqual({
    kind: "create",
    content: "A safer suggested fact",
    scope: "private",
    evidenceMemoryIds: [evidenceId],
    codeEvidence: [{ artifactId, relationship: "implements" }],
  });
  expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ status: "pending" });
});

test("CLI submits versioned update proposals and rejects an empty patch", async () => {
  const targetMemoryId = "20000000-0000-4000-8000-000000000003";
  const evidenceId = "20000000-0000-4000-8000-000000000004";
  const captured = captureIo();
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      id: "50000000-0000-4000-8000-000000000002",
      workspaceId: WORKSPACE_ID,
      ownerUserId: "30000000-0000-4000-8000-000000000001",
      proposedByActorKind: "agent",
      proposedByAgentId: "40000000-0000-4000-8000-000000000001",
      kind: "update",
      targetMemoryId,
      baseMemoryVersion: 7,
      proposedContent: "Existing content",
      proposedScope: "shared",
      proposedMetadata: { state: "approved" },
      evidenceMemoryIds: [evidenceId],
      evidenceObservationIds: [],
      status: "pending",
      reviewedByUserId: null,
      acceptedMemoryId: null,
      createdAt: "2026-08-10T00:00:00.000Z",
      reviewedAt: null,
    }),
  );

  const exitCode = await runLoreCli(
    [
      "memory",
      "propose",
      "update",
      targetMemoryId,
      "--version",
      "7",
      "--metadata",
      '{"state":"approved"}',
      "--evidence",
      evidenceId,
      "--idempotency-key",
      "proposal-update-1",
    ],
    {
      environment: {
        LORE_URL: "https://lore.example.test",
        LORE_WORKSPACE_ID: WORKSPACE_ID,
        LORE_AGENT_TOKEN: AGENT_TOKEN,
      },
      fetch: fetchMock,
      io: captured.io,
    },
  );

  expect(exitCode).toBe(0);
  const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(new Headers(init.headers).get("idempotency-key")).toBe("proposal-update-1");
  expect(JSON.parse(String(init.body))).toEqual({
    kind: "update",
    targetMemoryId,
    expectedVersion: 7,
    metadata: { state: "approved" },
    evidenceMemoryIds: [evidenceId],
  });

  const invalid = captureIo();
  const invalidExitCode = await runLoreCli(
    ["memory", "propose", "update", targetMemoryId, "--version", "7"],
    {
      environment: {
        LORE_URL: "https://lore.example.test",
        LORE_WORKSPACE_ID: WORKSPACE_ID,
        LORE_AGENT_TOKEN: AGENT_TOKEN,
      },
      fetch: vi.fn(),
      io: invalid.io,
    },
  );
  expect(invalidExitCode).toBe(2);
  expect(invalid.stderr.join("")).toContain(
    "memory propose update requires --content, --scope, or --metadata",
  );
});

test("CLI records private Episode evidence from stdin without putting payloads in argv", async () => {
  const episodeId = "60000000-0000-4000-8000-000000000001";
  const input = {
    kind: "conversation",
    observations: [{ kind: "message", content: "Private observation" }],
  };
  const captured = captureIo(`${JSON.stringify(input)}\n`);
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      id: episodeId,
      workspaceId: WORKSPACE_ID,
      ownerUserId: "30000000-0000-4000-8000-000000000001",
      recordedByActorKind: "agent",
      recordedByAgentId: "40000000-0000-4000-8000-000000000001",
      kind: "conversation",
      scope: "private",
      startedAt: "2026-08-10T00:00:00.000Z",
      endedAt: "2026-08-10T00:00:00.000Z",
      observationCount: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      observations: [],
    }),
  );

  const exitCode = await runLoreCli(
    ["episode", "record", "--stdin", "--idempotency-key", "episode-1"],
    {
      environment: {
        LORE_URL: "https://lore.example.test",
        LORE_WORKSPACE_ID: WORKSPACE_ID,
        LORE_AGENT_TOKEN: AGENT_TOKEN,
      },
      fetch: fetchMock,
      io: captured.io,
    },
  );

  expect(exitCode).toBe(0);
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(url.pathname).toBe("/api/v1/episodes");
  expect(new Headers(init.headers).get("idempotency-key")).toBe("episode-1");
  expect(JSON.parse(String(init.body))).toEqual(input);
  expect(JSON.parse(captured.stdout.join(""))).toMatchObject({ id: episodeId });
});

test("CLI reports missing Workspace as a usage error", async () => {
  const captured = captureIo();
  const exitCode = await runLoreCli(["memory", "list"], {
    environment: {},
    fetch: vi.fn(),
    io: captured.io,
  });

  expect(exitCode).toBe(2);
  expect(captured.stderr.join("")).toMatch(/Workspace is required/);
});

test("CLI returns a safe API exit code without printing the credential", async () => {
  const captured = captureIo();
  const exitCode = await runLoreCli(["memory", "list"], {
    environment: {
      LORE_URL: "https://lore.example.test",
      LORE_WORKSPACE_ID: WORKSPACE_ID,
      LORE_AGENT_TOKEN: AGENT_TOKEN,
    },
    fetch: vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "access_denied", error: "Workspace access denied" }, { status: 403 }),
      ),
    io: captured.io,
  });

  expect(exitCode).toBe(1);
  expect(captured.stderr.join("")).toContain("access_denied (403)");
  expect(captured.stderr.join("")).not.toContain(AGENT_TOKEN);
});

test("CLI reports network and refused-redirect failures as runtime errors", async () => {
  const captured = captureIo();
  const exitCode = await runLoreCli(["memory", "list"], {
    environment: {
      LORE_URL: "https://lore.example.test",
      LORE_WORKSPACE_ID: WORKSPACE_ID,
      LORE_AGENT_TOKEN: AGENT_TOKEN,
    },
    fetch: vi.fn().mockRejectedValue(new TypeError(`redirect exposed ${AGENT_TOKEN}`)),
    io: captured.io,
  });

  expect(exitCode).toBe(1);
  expect(captured.stderr.join("")).toContain("transport_error (0)");
  expect(captured.stderr.join("")).not.toContain(AGENT_TOKEN);
});

test("CLI version does not require configuration or network access", async () => {
  const captured = captureIo();
  const fetchMock = vi.fn();
  await expect(
    runLoreCli(["--version"], { environment: {}, fetch: fetchMock, io: captured.io }),
  ).resolves.toBe(0);
  expect(captured.stdout).toEqual([`${LORE_CLI_VERSION}\n`]);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("CLI rejects mutation options that do not belong to the selected command", async () => {
  const captured = captureIo();
  const fetchMock = vi.fn();
  const exitCode = await runLoreCli(
    [
      "memory",
      "forget",
      "20000000-0000-4000-8000-000000000001",
      "--version",
      "2",
      "--content",
      "ignored",
    ],
    {
      environment: { LORE_WORKSPACE_ID: WORKSPACE_ID },
      fetch: fetchMock,
      io: captured.io,
    },
  );

  expect(exitCode).toBe(2);
  expect(captured.stderr.join("")).toMatch(/--content is not valid/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("CLI accepts private query text through stdin instead of argv", async () => {
  const captured = captureIo("private launch date\n");
  const fetchMock = vi.fn().mockResolvedValue(Response.json([]));
  const args = ["memory", "search", "--stdin"];

  const exitCode = await runLoreCli(args, {
    environment: { LORE_WORKSPACE_ID: WORKSPACE_ID },
    fetch: fetchMock,
    io: captured.io,
  });

  expect(exitCode).toBe(0);
  expect(args).not.toContain("private launch date");
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain("q=private+launch+date");
});

test("CLI stdin accepts valid multibyte content up to the character limit", async () => {
  const content = "界".repeat(400_000);
  const bytes = new TextEncoder().encode(content);
  async function* input() {
    yield bytes;
  }

  await expect(readBoundedUtf8Stdin(input())).resolves.toBe(content);
});

test("CLI stdin leaves envelope room around a maximal multibyte Episode payload", async () => {
  const episode = JSON.stringify({
    kind: "document",
    observations: Array.from({ length: 10 }, () => ({
      kind: "document_fragment",
      content: "界".repeat(100_000),
    })),
  });
  const bytes = new TextEncoder().encode(episode);
  async function* input() {
    yield bytes;
  }

  await expect(readBoundedUtf8Stdin(input())).resolves.toBe(episode);
});

test("CLI stdin rejects malformed UTF-8 instead of changing Memory content", async () => {
  async function* input() {
    yield new Uint8Array([0xc3, 0x28]);
  }

  await expect(readBoundedUtf8Stdin(input())).rejects.toThrow(/valid UTF-8/);
});
