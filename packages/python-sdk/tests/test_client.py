import json
import unittest
from typing import List, Tuple
from urllib.request import Request

from corespeed_lore import LoreApiError, LoreClient


WORKSPACE_ID = "10000000-0000-4000-8000-000000000001"
MEMORY_ID = "20000000-0000-4000-8000-000000000001"
AGENT_ID = "a0000000-0000-4000-8000-000000000002"
CREDENTIAL_ID = "b0000000-0000-4000-8000-000000000002"
JOB_ID = "80000000-0000-4000-8000-000000000001"
ARTIFACT_ID = "90000000-0000-4000-8000-000000000001"
EVIDENCE_ID = "a0000000-0000-4000-8000-000000000001"
COMMIT_OID = "e" * 40
AGENT_TOKEN = f"lore_agent_{'a' * 64}"


def memory(version=3):
    return {
        "id": MEMORY_ID,
        "workspaceId": WORKSPACE_ID,
        "ownerUserId": "30000000-0000-4000-8000-000000000001",
        "createdByAgentId": None,
        "scope": "shared",
        "content": "Lore remembers safely.",
        "metadata": {},
        "version": version,
        "createdAt": "2026-08-09T00:00:00.000Z",
        "updatedAt": "2026-08-09T00:00:00.000Z",
    }


class FakeResponse:
    def __init__(self, value, status=200, headers=None):
        self.status = status
        self.payload = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")
        self.headers = headers or {}
        self.closed = False

    def read(self, amount=-1):
        return self.payload if amount < 0 else self.payload[:amount]

    def close(self):
        self.closed = True


class QueueTransport:
    def __init__(self, *responses):
        self.responses: List[FakeResponse] = list(responses)
        self.requests: List[Tuple[Request, float]] = []

    def __call__(self, request, timeout):
        self.requests.append((request, timeout))
        return self.responses.pop(0)


class LorePythonSdkTests(unittest.TestCase):
    def test_human_actor_and_agent_lifecycle_preserve_workspace_auth_and_payloads(self):
        actor = {"kind": "human", "userId": "30000000-0000-4000-8000-000000000001"}
        agent = {
            "id": AGENT_ID,
            "ownerUserId": actor["userId"],
            "name": "Research assistant",
            "status": "active",
            "permission": "write",
            "grantStatus": "active",
            "createdAt": "2026-09-15T00:00:00.000Z",
            "updatedAt": "2026-09-15T00:00:00.000Z",
        }
        update = {"name": "Retired assistant", "status": "disabled"}
        updated = {**agent, **update}
        transport = QueueTransport(
            FakeResponse(actor),
            FakeResponse([agent]),
            FakeResponse(agent, status=201),
            FakeResponse(updated),
            FakeResponse(None, status=204),
        )
        workspace = LoreClient(
            "https://lore.example.test/base/", basic_password="secret", transport=transport
        ).workspace(WORKSPACE_ID)

        self.assertEqual(workspace.get_current_human_actor(), actor)
        self.assertEqual(workspace.list_agents(), [agent])
        self.assertEqual(workspace.create_agent(" Research assistant ", permission="write"), agent)
        self.assertEqual(workspace.update_agent(AGENT_ID.upper(), update), updated)
        self.assertIsNone(workspace.delete_agent(AGENT_ID))

        self.assertEqual(
            [(request.method, request.full_url) for request, _ in transport.requests],
            [
                ("GET", "https://lore.example.test/base/api/v1/actor"),
                ("GET", "https://lore.example.test/base/api/v1/agents"),
                ("POST", "https://lore.example.test/base/api/v1/agents"),
                ("PATCH", f"https://lore.example.test/base/api/v1/agents/{AGENT_ID}"),
                ("DELETE", f"https://lore.example.test/base/api/v1/agents/{AGENT_ID}"),
            ],
        )
        self.assertEqual(
            json.loads(transport.requests[2][0].data),
            {"name": " Research assistant ", "permission": "write"},
        )
        self.assertEqual(json.loads(transport.requests[3][0].data), update)
        for request, _ in transport.requests:
            self.assertEqual(request.get_header("X-lore-workspace-id"), WORKSPACE_ID)
            self.assertTrue(request.get_header("Authorization").startswith("Basic "))

    def test_agent_credentials_and_grants_use_canonical_paths_and_empty_mutation_bodies(self):
        credential = {"id": CREDENTIAL_ID, "agentId": AGENT_ID, "prefix": "lore_agent_test"}
        issued = {"id": CREDENTIAL_ID, "prefix": credential["prefix"], "token": AGENT_TOKEN}
        grant = {"workspaceId": WORKSPACE_ID, "agentId": AGENT_ID, "permission": "read"}
        transport = QueueTransport(
            FakeResponse([credential]),
            FakeResponse(issued, status=201),
            FakeResponse(None, status=204),
            FakeResponse(grant),
            FakeResponse(None, status=204),
        )
        workspace = LoreClient("http://localhost:3000", transport=transport).workspace(WORKSPACE_ID)

        self.assertEqual(workspace.list_agent_credentials(AGENT_ID), [credential])
        self.assertEqual(workspace.issue_agent_credential(AGENT_ID), issued)
        self.assertIsNone(workspace.revoke_agent_credential(CREDENTIAL_ID.upper()))
        self.assertEqual(workspace.set_agent_grant(AGENT_ID, "read"), grant)
        self.assertIsNone(workspace.revoke_agent_grant(AGENT_ID))

        self.assertEqual(
            [(request.method, request.full_url) for request, _ in transport.requests],
            [
                ("GET", f"http://localhost:3000/api/v1/agents/{AGENT_ID}/credentials"),
                ("POST", f"http://localhost:3000/api/v1/agents/{AGENT_ID}/credentials"),
                ("DELETE", f"http://localhost:3000/api/v1/agent-credentials/{CREDENTIAL_ID}"),
                ("PUT", f"http://localhost:3000/api/v1/agents/{AGENT_ID}/grant"),
                ("DELETE", f"http://localhost:3000/api/v1/agents/{AGENT_ID}/grant"),
            ],
        )
        self.assertEqual(json.loads(transport.requests[3][0].data), {"permission": "read"})
        for index, (request, _) in enumerate(transport.requests):
            self.assertEqual(request.get_header("X-lore-workspace-id"), WORKSPACE_ID)
            if index != 3:
                self.assertIsNone(request.data)

    def test_workspace_portability_preserves_archive_owner_map_and_explicit_dry_run(self):
        owner_id = memory()["ownerUserId"]
        archive = {
            "manifest": {
                "checksum": "a" * 64,
                "exportedAt": "2026-09-15T00:00:00.000Z",
                "format": "lore-workspace-v1",
                "memoryCount": 1,
                "linkCount": 0,
                "sourceDeploymentId": "40000000-0000-4000-8000-000000000001",
                "sourceWorkspaceId": WORKSPACE_ID,
                "visibility": "actor-visible",
            },
            "memories": [
                {
                    key: value
                    for key, value in memory().items()
                    if key not in {"workspaceId", "createdByAgentId"}
                }
            ],
            "links": [],
        }
        result = {
            "archiveChecksum": archive["manifest"]["checksum"],
            "dryRun": True,
            "importedLinks": 0,
            "importedMemories": 1,
            "memoryIdMap": {MEMORY_ID: MEMORY_ID},
            "replayed": False,
            "skippedMemories": 0,
        }
        transport = QueueTransport(FakeResponse(archive), FakeResponse(result))
        workspace = LoreClient("http://localhost:3000", transport=transport).workspace(WORKSPACE_ID)
        workspace_import = {
            "archive": archive,
            "ownerMap": {owner_id: owner_id},
            "dryRun": True,
            "conflictPolicy": "skip",
        }

        self.assertEqual(workspace.export_workspace(), archive)
        self.assertEqual(workspace.import_workspace(workspace_import), result)
        export, imported = [request for request, _ in transport.requests]
        self.assertEqual(
            (export.method, export.full_url),
            ("GET", "http://localhost:3000/api/v1/workspaces/export"),
        )
        self.assertEqual(
            (imported.method, imported.full_url),
            ("POST", "http://localhost:3000/api/v1/workspaces/import"),
        )
        self.assertEqual(json.loads(imported.data), workspace_import)
        for request in (export, imported):
            self.assertEqual(request.get_header("X-lore-workspace-id"), WORKSPACE_ID)

    def test_agent_path_identifiers_fail_before_transport(self):
        transport = QueueTransport()
        workspace = LoreClient("http://localhost:3000", transport=transport).workspace(WORKSPACE_ID)
        operations = [
            lambda: workspace.update_agent("../agents", {"status": "disabled"}),
            lambda: workspace.delete_agent("../agents"),
            lambda: workspace.list_agent_credentials("../agents"),
            lambda: workspace.issue_agent_credential("../agents"),
            lambda: workspace.revoke_agent_credential("../credentials"),
            lambda: workspace.set_agent_grant("../agents", "write"),
            lambda: workspace.revoke_agent_grant("../agents"),
        ]
        for operation in operations:
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(TypeError, "must be a UUID"):
                    operation()
        self.assertEqual(transport.requests, [])

    def test_only_successful_workspace_exports_opt_out_of_the_response_byte_cap(self):
        archive = {
            "manifest": {
                "checksum": "a" * 64,
                "exportedAt": "2026-09-15T00:00:00.000Z",
                "format": "lore-workspace-v1",
                "memoryCount": 0,
                "linkCount": 0,
                "sourceDeploymentId": "40000000-0000-4000-8000-000000000001",
                "sourceWorkspaceId": WORKSPACE_ID,
                "visibility": "actor-visible",
            },
            "memories": [],
            "links": [],
        }
        large_header = {"content-length": str(128 * 1024 * 1024 + 1)}
        export_response = FakeResponse(archive, headers=large_header)
        ordinary_response = FakeResponse([], headers=large_header)
        error_response = FakeResponse(
            {"error": "Export rejected", "code": "workspace_export_limit_exceeded"},
            status=409,
            headers={"content-length": str(64 * 1024 + 1)},
        )
        transport = QueueTransport(export_response, ordinary_response, error_response)
        workspace = LoreClient(
            "http://localhost:3000", timeout=45, transport=transport
        ).workspace(WORKSPACE_ID)

        self.assertEqual(workspace.export_workspace(), archive)
        with self.assertRaises(LoreApiError) as ordinary_error:
            workspace.list_agents()
        self.assertEqual(ordinary_error.exception.code, "invalid_response")
        self.assertIn(str(128 * 1024 * 1024), str(ordinary_error.exception))
        with self.assertRaises(LoreApiError) as export_error:
            workspace.export_workspace()
        self.assertEqual(export_error.exception.code, "invalid_response")
        self.assertIn(str(64 * 1024), str(export_error.exception))
        self.assertTrue(
            all(response.closed for response in (export_response, ordinary_response, error_response))
        )
        self.assertTrue(all(timeout == 45 for _, timeout in transport.requests))

    def test_workspace_export_keeps_strict_utf8_json_decoding(self):
        for invalid_body in (b'"\xff"', b'{"manifest":'):
            with self.subTest(body=invalid_body):
                response = FakeResponse(invalid_body)
                workspace = LoreClient(
                    "http://localhost:3000", transport=QueueTransport(response)
                ).workspace(WORKSPACE_ID)
                with self.assertRaises(LoreApiError) as error:
                    workspace.export_workspace()
                self.assertEqual(error.exception.code, "invalid_response")
                self.assertTrue(response.closed)

    def test_retrieve_context_uses_one_exact_revision_workspace_request(self):
        packet = {
            "revision": "joint-memory-code-v2",
            "query": "tenantGuard",
            "plan": {
                "intent": "unknown",
                "route": "both",
                "needsAnchorExpansion": True,
                "needsContextualImpact": False,
                "needsLocalAssessment": True,
                "reasons": ["explicit route"],
            },
            "deliveredRoute": "both",
            "memories": [],
            "code": [],
            "anchors": [],
            "conflicts": [],
            "receipt": {
                "memoryCandidates": 0,
                "codeCandidates": 0,
                "anchorCandidates": 0,
                "requestedCommitOid": COMMIT_OID,
                "memoryQuery": "guard decision",
                "codeQuery": "tenantGuard",
                "contextualImpact": None,
            },
        }
        transport = QueueTransport(FakeResponse(packet))
        workspace = LoreClient(
            "http://127.0.0.1:3000", transport=transport
        ).workspace(WORKSPACE_ID)

        self.assertEqual(
            workspace.retrieve_context(
                "tenantGuard",
                memory_query="guard decision",
                code_query="tenantGuard",
                repository_key="corespeed/lore",
                commit_oid=COMMIT_OID.upper(),
                route="both",
                memory_limit=4,
                code_limit=6,
            ),
            packet,
        )
        request = transport.requests[0][0]
        self.assertEqual(request.full_url, "http://127.0.0.1:3000/api/v1/context/retrieve")
        self.assertEqual(request.method, "POST")
        self.assertEqual(
            json.loads(request.data),
            {
                "query": "tenantGuard",
                "memoryQuery": "guard decision",
                "codeQuery": "tenantGuard",
                "repositoryKey": "corespeed/lore",
                "commitOid": COMMIT_OID,
                "route": "both",
                "memoryLimit": 4,
                "codeLimit": 6,
            },
        )

    def test_code_index_family_uses_exact_revision_and_never_accepts_a_repository_path(self):
        job = {
            "id": JOB_ID,
            "repositoryId": "b0000000-0000-4000-8000-000000000001",
            "repositoryKey": "corespeed/lore",
            "commitOid": COMMIT_OID,
            "sourceRef": "refs/heads/main",
            "indexerRevision": "test",
            "status": "pending",
            "attemptCount": 0,
            "maximumAttempts": 5,
            "availableAt": "2026-08-12T00:00:00.000Z",
            "completedAt": None,
            "lastError": None,
            "createdAt": "2026-08-12T00:00:00.000Z",
            "updatedAt": "2026-08-12T00:00:00.000Z",
        }
        dependencies = {
            "status": "ok",
            "repositoryKey": "corespeed/lore",
            "commitOid": COMMIT_OID,
            "direction": "callees",
            "subject": {
                "artifactId": ARTIFACT_ID,
                "path": "src/index.ts",
                "symbol": "run",
                "symbolKey": "src/index.ts#function_declaration:run",
            },
            "edges": [],
            "truncated": False,
        }
        transport = QueueTransport(
            FakeResponse(job, status=202),
            FakeResponse(job),
            FakeResponse([job]),
            FakeResponse([]),
            FakeResponse(dependencies),
        )
        workspace = LoreClient(
            "http://127.0.0.1:3000", transport=transport
        ).workspace(WORKSPACE_ID)

        workspace.enqueue_code_index(
            "corespeed/lore", COMMIT_OID, source_ref="refs/heads/main"
        )
        workspace.get_code_index_job(JOB_ID)
        self.assertEqual(workspace.list_code_index_jobs(limit=5), [job])
        workspace.search_code("corespeed/lore", COMMIT_OID, "fetch<User>", path_prefix="src/")
        self.assertEqual(
            workspace.query_code_dependencies(
                "corespeed/lore", COMMIT_OID.upper(), "callees", symbol="run", limit=25
            ),
            dependencies,
        )

        enqueue = transport.requests[0][0]
        self.assertEqual(enqueue.full_url, "http://127.0.0.1:3000/api/v1/code/index-jobs")
        self.assertEqual(
            json.loads(enqueue.data),
            {
                "repositoryKey": "corespeed/lore",
                "commitOid": COMMIT_OID,
                "sourceRef": "refs/heads/main",
            },
        )
        self.assertNotIn("repositoryPath", json.loads(enqueue.data))
        self.assertEqual(
            transport.requests[2][0].full_url,
            "http://127.0.0.1:3000/api/v1/code/index-jobs?limit=5",
        )
        self.assertEqual(
            transport.requests[3][0].full_url,
            "http://127.0.0.1:3000/api/v1/code/search?repository_key=corespeed%2Flore"
            f"&commit_oid={COMMIT_OID}&q=fetch%3CUser%3E&limit=10&path_prefix=src%2F",
        )
        self.assertEqual(
            transport.requests[4][0].full_url,
            "http://127.0.0.1:3000/api/v1/code/dependencies?repository_key=corespeed%2Flore"
            f"&commit_oid={COMMIT_OID}&direction=callees&symbol=run&limit=25",
        )

    def test_workspace_list_uses_v1_actor_and_cursor_contract(self):
        transport = QueueTransport(
            FakeResponse([memory()], headers={"x-lore-next-cursor": "next-page"})
        )
        client = LoreClient(
            "https://lore.example.test/base/",
            agent_token=AGENT_TOKEN,
            transport=transport,
        )

        page = client.workspace(WORKSPACE_ID).list_memories(limit=25)

        self.assertEqual(page.memories, [memory()])
        self.assertEqual(page.next_cursor, "next-page")
        request = transport.requests[0][0]
        self.assertEqual(
            request.full_url,
            "https://lore.example.test/base/api/v1/memories?limit=25",
        )
        self.assertEqual(request.get_header("Authorization"), f"Bearer {AGENT_TOKEN}")
        self.assertEqual(request.get_header("X-lore-workspace-id"), WORKSPACE_ID)

    def test_update_sends_strong_version_and_reusable_idempotency_key(self):
        transport = QueueTransport(FakeResponse(memory(version=4)))
        workspace = LoreClient(
            "http://127.0.0.1:3000", transport=transport
        ).workspace(WORKSPACE_ID)

        workspace.update_memory(
            MEMORY_ID,
            expected_version=3,
            content="Updated",
            idempotency_key="update-1",
        )

        request = transport.requests[0][0]
        self.assertEqual(request.method, "PATCH")
        self.assertEqual(request.get_header("If-match"), '"memory-v3"')
        self.assertEqual(request.get_header("Idempotency-key"), "update-1")
        self.assertEqual(json.loads(request.data), {"content": "Updated"})

    def test_memory_content_uses_the_public_unicode_character_limit(self):
        transport = QueueTransport(FakeResponse(memory()))
        workspace = LoreClient(
            "http://127.0.0.1:3000", transport=transport
        ).workspace(WORKSPACE_ID)

        workspace.update_memory(
            MEMORY_ID,
            expected_version=3,
            content="😀" * 32_000,
        )
        with self.assertRaisesRegex(TypeError, "at most 32000 Unicode characters"):
            workspace.update_memory(
                MEMORY_ID,
                expected_version=3,
                content="😀" * 32_001,
            )

        self.assertEqual(len(transport.requests), 1)

    def test_proposal_methods_use_v1_routes_and_reusable_idempotency(self):
        proposal_id = "50000000-0000-4000-8000-000000000001"
        pending = {
            "id": proposal_id,
            "workspaceId": WORKSPACE_ID,
            "ownerUserId": "30000000-0000-4000-8000-000000000001",
            "proposedByActorKind": "human",
            "proposedByAgentId": None,
            "kind": "create",
            "targetMemoryId": None,
            "baseMemoryVersion": None,
            "proposedContent": "Proposed fact",
            "proposedScope": "private",
            "proposedMetadata": {},
            "evidenceMemoryIds": [],
            "evidenceObservationIds": [],
            "status": "pending",
            "reviewedByUserId": None,
            "acceptedMemoryId": None,
            "createdAt": "2026-08-10T00:00:00.000Z",
            "reviewedAt": None,
        }
        transport = QueueTransport(
            FakeResponse(pending, status=201),
            FakeResponse([pending]),
            FakeResponse([pending]),
            FakeResponse({"proposal": {**pending, "status": "rejected"}, "memory": None}),
        )
        workspace = LoreClient(
            "http://127.0.0.1:3000", transport=transport
        ).workspace(WORKSPACE_ID)

        workspace.propose_memory(
            {"kind": "create", "content": "Proposed fact", "scope": "private"},
            idempotency_key="proposal-1",
        )
        workspace.list_memory_proposals()
        workspace.list_memory_proposals(status="pending", limit=25)
        workspace.review_memory_proposal(proposal_id, "reject")

        create_request = transport.requests[0][0]
        self.assertEqual(create_request.full_url, "http://127.0.0.1:3000/api/v1/memory-proposals")
        self.assertEqual(create_request.get_header("Idempotency-key"), "proposal-1")
        all_request = transport.requests[1][0]
        self.assertEqual(
            all_request.full_url,
            "http://127.0.0.1:3000/api/v1/memory-proposals?limit=50",
        )
        list_request = transport.requests[2][0]
        self.assertEqual(
            list_request.full_url,
            "http://127.0.0.1:3000/api/v1/memory-proposals?limit=25&status=pending",
        )
        review_request = transport.requests[3][0]
        self.assertEqual(
            review_request.full_url,
            f"http://127.0.0.1:3000/api/v1/memory-proposals/{proposal_id}/review",
        )
        self.assertEqual(json.loads(review_request.data), {"decision": "reject"})

    def test_authenticated_http_and_reserved_custom_headers_are_rejected(self):
        with self.assertRaisesRegex(TypeError, "require HTTPS"):
            LoreClient("http://lore.example.test", agent_token=AGENT_TOKEN)
        with self.assertRaisesRegex(TypeError, "typed Lore client options"):
            LoreClient(
                "https://lore.example.test",
                headers={"Authorization": "Bearer bypass"},
            )

    def test_episode_methods_use_stable_v1_routes_and_cursor(self):
        episode_id = "60000000-0000-4000-8000-000000000001"
        episode = {
            "id": episode_id,
            "workspaceId": WORKSPACE_ID,
            "ownerUserId": "30000000-0000-4000-8000-000000000001",
            "recordedByActorKind": "agent",
            "recordedByAgentId": "40000000-0000-4000-8000-000000000001",
            "kind": "conversation",
            "scope": "private",
            "startedAt": "2026-08-10T00:00:00.000Z",
            "endedAt": "2026-08-10T00:00:00.000Z",
            "observationCount": 1,
            "createdAt": "2026-08-10T00:00:01.000Z",
            "observations": [],
        }
        transport = QueueTransport(
            FakeResponse(episode, status=201),
            FakeResponse([episode], headers={"x-lore-next-cursor": "episode-next"}),
            FakeResponse(episode),
            FakeResponse([]),
            FakeResponse(b"", status=204),
        )
        workspace = LoreClient(
            "http://127.0.0.1:3000", transport=transport
        ).workspace(WORKSPACE_ID)
        input_episode = {
            "kind": "conversation",
            "observations": [{"kind": "message", "content": "Raw evidence"}],
        }

        workspace.record_episode(input_episode, idempotency_key="episode-1")
        page = workspace.list_episodes(kind="conversation", limit=25)
        workspace.get_episode(episode_id)
        workspace.get_observations(["70000000-0000-4000-8000-000000000001"])
        workspace.forget_episode(episode_id, idempotency_key="episode-forget-1")

        record_request = transport.requests[0][0]
        self.assertEqual(record_request.full_url, "http://127.0.0.1:3000/api/v1/episodes")
        self.assertEqual(record_request.get_header("Idempotency-key"), "episode-1")
        self.assertEqual(json.loads(record_request.data), input_episode)
        self.assertEqual(page.next_cursor, "episode-next")
        self.assertEqual(
            transport.requests[1][0].full_url,
            "http://127.0.0.1:3000/api/v1/episodes?limit=25&kind=conversation",
        )
        self.assertEqual(
            transport.requests[2][0].full_url,
            f"http://127.0.0.1:3000/api/v1/episodes/{episode_id}",
        )
        self.assertEqual(
            transport.requests[3][0].full_url,
            "http://127.0.0.1:3000/api/v1/observations?id=70000000-0000-4000-8000-000000000001",
        )
        self.assertEqual(transport.requests[4][0].method, "DELETE")
        self.assertEqual(
            transport.requests[4][0].get_header("Idempotency-key"),
            "episode-forget-1",
        )

    def test_cloudflare_service_token_uses_client_headers(self):
        transport = QueueTransport(FakeResponse([]))
        client = LoreClient(
            "https://lore.example.test",
            agent_token=AGENT_TOKEN,
            access_client_id="client-id.access",
            access_client_secret="client-secret",
            transport=transport,
        )
        client.list_workspaces()
        request = transport.requests[0][0]
        self.assertEqual(request.get_header("Authorization"), f"Bearer {AGENT_TOKEN}")
        self.assertEqual(request.get_header("Cf-access-client-id"), "client-id.access")
        self.assertEqual(request.get_header("Cf-access-client-secret"), "client-secret")
        self.assertIsNone(request.get_header("Cf-access-jwt-assertion"))

    def test_readiness_returns_the_typed_503_body(self):
        report = {
            "status": "unready",
            "components": {
                "database": "unavailable",
                "embedding": "unknown",
                "rlsRole": "unavailable",
                "schema": "unavailable",
                "vector": "unavailable",
            },
        }
        client = LoreClient(
            "http://127.0.0.1:3000",
            transport=QueueTransport(FakeResponse(report, status=503)),
        )
        self.assertEqual(client.readiness(), report)

    def test_declared_oversize_error_is_closed_and_bounded(self):
        response = FakeResponse(
            {"code": "internal_error", "error": "not read"},
            status=500,
            headers={"content-length": str(64 * 1024 + 1)},
        )
        client = LoreClient(
            "http://127.0.0.1:3000", transport=QueueTransport(response)
        )

        with self.assertRaises(LoreApiError) as captured:
            client.list_workspaces()

        self.assertEqual(captured.exception.code, "invalid_response")
        self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main()
