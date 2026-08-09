import json
import unittest
from typing import List, Tuple
from urllib.request import Request

from corespeed_lore import LoreApiError, LoreClient


WORKSPACE_ID = "10000000-0000-4000-8000-000000000001"
MEMORY_ID = "20000000-0000-4000-8000-000000000001"
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

    def test_authenticated_http_and_reserved_custom_headers_are_rejected(self):
        with self.assertRaisesRegex(TypeError, "require HTTPS"):
            LoreClient("http://lore.example.test", agent_token=AGENT_TOKEN)
        with self.assertRaisesRegex(TypeError, "typed Lore client options"):
            LoreClient(
                "https://lore.example.test",
                headers={"Authorization": "Bearer bypass"},
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
