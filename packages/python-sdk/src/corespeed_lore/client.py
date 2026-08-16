from __future__ import annotations

import base64
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping, MutableMapping, Optional, Protocol, Sequence, Union, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, OpenerDirector, Request, build_opener

from .generated_contract import (
    Capabilities,
    CodeArtifact,
    CodeDependencyQueryResult,
    CodeIndexJob,
    CreateMemoryProposalInput,
    Episode,
    EpisodeSummary,
    Memory,
    MemoryCodeEvidence,
    MemoryGraph,
    MemoryProposal,
    MemoryProposalReviewResult,
    MemorySearchResult,
    Observation,
    ReadinessReport,
    RecordEpisodeInput,
    RetrievedContext,
    Workspace,
    WorkspaceSummary,
    LORE_ERROR_CODES,
)

MAX_SUCCESS_RESPONSE_BYTES = 128 * 1024 * 1024
MAX_ERROR_RESPONSE_BYTES = 64 * 1024
AGENT_TOKEN_PATTERN = re.compile(r"^lore_agent_[0-9a-f]{64}$")
RESERVED_CUSTOM_HEADERS = frozenset(
    {
        "authorization",
        "cookie",
        "cf-access-jwt-assertion",
        "cf-access-token",
        "cf-access-client-id",
        "cf-access-client-secret",
        "proxy-authorization",
    }
)


class LoreApiError(RuntimeError):
    def __init__(self, message: str, status: int, code: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class ResponseLike(Protocol):
    headers: Mapping[str, str]
    status: int

    def close(self) -> None: ...

    def read(self, amount: int = -1) -> bytes: ...


Transport = Callable[[Request, float], ResponseLike]


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Mapping[str, str],
        newurl: str,
    ) -> None:
        return None


def _opener_transport(opener: OpenerDirector) -> Transport:
    return lambda request, timeout: cast(ResponseLike, opener.open(request, timeout=timeout))


def _normalized_uuid(value: str, name: str) -> str:
    try:
        parsed = uuid.UUID(value.strip())
    except (AttributeError, ValueError) as error:
        raise TypeError(f"{name} must be a UUID") from error
    return str(parsed)


def _normalized_base_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise TypeError("Lore base_url must use http or https")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise TypeError("Lore base_url cannot contain credentials, a query, or a fragment")
    path = parsed.path if parsed.path.endswith("/") else f"{parsed.path}/"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _is_loopback(base_url: str) -> bool:
    hostname = (urlsplit(base_url).hostname or "").lower()
    return (
        hostname == "localhost"
        or hostname.endswith(".localhost")
        or hostname in {"127.0.0.1", "::1"}
    )


def _idempotency_key(value: Optional[str]) -> str:
    if value is None:
        return str(uuid.uuid4())
    if not value or len(value) > 128 or value.strip() != value:
        raise TypeError(
            "idempotency_key must contain 1 to 128 characters without outer whitespace"
        )
    return value


def _limit(value: Optional[int], fallback: int, maximum: int = 100) -> int:
    selected = fallback if value is None else value
    if not isinstance(selected, int) or isinstance(selected, bool) or selected < 1 or selected > maximum:
        raise TypeError(f"limit must be an integer from 1 to {maximum}")
    return selected


def _scope(value: Optional[str]) -> Optional[str]:
    if value is not None and value not in {"shared", "private"}:
        raise TypeError("scope must be shared or private")
    return value


def _code_text(value: str, name: str, maximum_length: int) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > maximum_length:
        raise TypeError(f"{name} must contain 1 to {maximum_length} characters")
    return normalized


def _commit_oid(value: str) -> str:
    normalized = value.strip().lower()
    if re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", normalized) is None:
        raise TypeError("commit_oid must be a full 40- or 64-character Git OID")
    return normalized


@dataclass(frozen=True)
class MemoryPage:
    memories: Sequence[Memory]
    next_cursor: Optional[str]


@dataclass(frozen=True)
class EpisodePage:
    episodes: Sequence[EpisodeSummary]
    next_cursor: Optional[str]


class LoreClient:
    def __init__(
        self,
        base_url: str,
        *,
        agent_token: Optional[str] = None,
        basic_password: Optional[str] = None,
        basic_username: str = "lore",
        access_token: Optional[str] = None,
        access_client_id: Optional[str] = None,
        access_client_secret: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        allow_insecure: bool = False,
        timeout: float = 30.0,
        transport: Optional[Transport] = None,
    ) -> None:
        self.base_url = _normalized_base_url(base_url)
        if timeout <= 0 or timeout > 300:
            raise TypeError("timeout must be greater than 0 and at most 300 seconds")
        self.timeout = timeout
        self.headers: MutableMapping[str, str] = {
            str(name): str(value) for name, value in (headers or {}).items()
        }
        for name in self.headers:
            if name.lower() in RESERVED_CUSTOM_HEADERS:
                raise TypeError(f"{name} must be configured through typed Lore client options")

        service_token_configured = access_client_id is not None or access_client_secret is not None
        actor_mechanisms = sum(configured is not None for configured in (agent_token, basic_password))
        gateway_mechanisms = int(access_token is not None) + int(service_token_configured)
        if actor_mechanisms > 1:
            raise TypeError("Configure only one Lore Actor authentication mechanism")
        if gateway_mechanisms > 1:
            raise TypeError("Configure only one Lore gateway authentication mechanism")
        if agent_token is not None:
            if not AGENT_TOKEN_PATTERN.fullmatch(agent_token):
                raise TypeError("Lore Agent token is invalid")
            self.headers["authorization"] = f"Bearer {agent_token}"
        elif basic_password is not None:
            if not basic_password or len(basic_password) > 4096:
                raise TypeError("Lore Basic password must contain 1 to 4096 characters")
            credential = f"{basic_username}:{basic_password}".encode("utf-8")
            self.headers["authorization"] = f"Basic {base64.b64encode(credential).decode('ascii')}"
        if access_token is not None:
            if not access_token.strip() or len(access_token) > 16384:
                raise TypeError("Cloudflare Access token is invalid")
            self.headers["cf-access-token"] = access_token
        elif service_token_configured:
            if not access_client_id or len(access_client_id) > 4096:
                raise TypeError("Cloudflare Access client id is invalid")
            if not access_client_secret or len(access_client_secret) > 4096:
                raise TypeError("Cloudflare Access client secret is invalid")
            self.headers["cf-access-client-id"] = access_client_id
            self.headers["cf-access-client-secret"] = access_client_secret

        if (
            self.headers
            and urlsplit(self.base_url).scheme != "https"
            and not _is_loopback(self.base_url)
            and not allow_insecure
        ):
            raise TypeError(
                "Lore authentication or custom headers require HTTPS outside loopback"
            )
        self._transport = transport or _opener_transport(build_opener(_NoRedirect()))

    def list_workspaces(self) -> Sequence[WorkspaceSummary]:
        return cast(Sequence[WorkspaceSummary], self._request("api/v1/workspaces"))

    def create_workspace(self, name: str) -> Workspace:
        normalized = name.strip()
        if not normalized or len(normalized) > 120:
            raise TypeError("Workspace name must contain 1 to 120 characters")
        return cast(
            Workspace,
            self._request("api/v1/workspaces", method="POST", body={"name": normalized}),
        )

    def readiness(self) -> ReadinessReport:
        return cast(
            ReadinessReport,
            self._request("readyz", accepted_statuses=(503,)),
        )

    def workspace(self, workspace_id: str) -> "LoreWorkspaceClient":
        return LoreWorkspaceClient(self, _normalized_uuid(workspace_id, "workspace_id"))

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        workspace_id: Optional[str] = None,
        body: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        accepted_statuses: Sequence[int] = (),
        return_response_headers: bool = False,
    ) -> Any:
        request_headers = dict(self.headers)
        request_headers["accept"] = "application/json"
        if workspace_id is not None:
            request_headers["x-lore-workspace-id"] = workspace_id
        if body is not None:
            request_headers["content-type"] = "application/json"
        request_headers.update(headers or {})
        request = Request(
            urljoin(self.base_url, path),
            data=None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8"),
            headers=request_headers,
            method=method,
        )
        try:
            response = self._transport(request, self.timeout)
        except HTTPError as error:
            response = cast(ResponseLike, error)
        except URLError as error:
            raise LoreApiError("Lore request failed", 0, "transport_error") from error
        try:
            status = response.status
            if 300 <= status < 400:
                raise LoreApiError("Lore redirects are refused", status, "redirect_refused")
            if status == 204:
                return None
            accepted = 200 <= status < 300 or status in accepted_statuses
            maximum = MAX_SUCCESS_RESPONSE_BYTES if accepted else MAX_ERROR_RESPONSE_BYTES
            declared = response.headers.get("content-length")
            if declared is not None:
                try:
                    if int(declared) > maximum:
                        raise LoreApiError(
                            f"Lore response exceeds {maximum} bytes",
                            status,
                            "invalid_response",
                        )
                except ValueError:
                    pass
            payload = response.read(maximum + 1)
            if len(payload) > maximum:
                raise LoreApiError(
                    f"Lore response exceeds {maximum} bytes", status, "invalid_response"
                )
            try:
                parsed = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise LoreApiError(
                    "Lore returned invalid JSON", status, "invalid_response"
                ) from error
            if not accepted:
                error_code = (
                    parsed.get("code")
                    if isinstance(parsed, dict) and parsed.get("code") in LORE_ERROR_CODES
                    else "http_error"
                )
                message = (
                    parsed.get("error")
                    if isinstance(parsed, dict) and isinstance(parsed.get("error"), str)
                    else f"Lore request failed ({status})"
                )
                raise LoreApiError(message, status, cast(str, error_code))
            if return_response_headers:
                response_headers = {
                    str(name).lower(): str(value) for name, value in response.headers.items()
                }
                return parsed, response_headers
            return parsed
        finally:
            response.close()

    def _request_with_response(
        self, path: str, *, workspace_id: str
    ) -> tuple[Any, Mapping[str, str]]:
        return cast(
            tuple[Any, Mapping[str, str]],
            self._request(
                path,
                workspace_id=workspace_id,
                return_response_headers=True,
            ),
        )


class LoreWorkspaceClient:
    def __init__(self, client: LoreClient, workspace_id: str) -> None:
        self.client = client
        self.workspace_id = workspace_id

    def capabilities(self) -> Capabilities:
        return cast(
            Capabilities,
            self.client._request("api/v1/capabilities", workspace_id=self.workspace_id),
        )

    def graph(self, limit: int = 5000) -> MemoryGraph:
        if isinstance(limit, bool) or limit < 1 or limit > 5000:
            raise TypeError("Graph limit must be an integer from 1 to 5000")
        return cast(
            MemoryGraph,
            self.client._request(
                f"api/v1/graph?{urlencode({'limit': limit})}",
                workspace_id=self.workspace_id,
            ),
        )

    def list_memories(
        self,
        *,
        cursor: Optional[str] = None,
        limit: int = 50,
        offset: Optional[int] = None,
        scope: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        updated_after: Optional[str] = None,
        updated_before: Optional[str] = None,
    ) -> MemoryPage:
        if cursor is not None and offset is not None:
            raise TypeError("cursor and offset cannot be combined")
        params: MutableMapping[str, Union[str, int]] = {"limit": _limit(limit, 50)}
        if cursor is not None:
            params["cursor"] = cursor
        if offset is not None:
            if isinstance(offset, bool) or offset < 0 or offset > 1_000_000:
                raise TypeError("offset must be an integer from 0 to 1000000")
            params["offset"] = offset
        self._filters(params, scope, metadata, updated_after, updated_before)
        response = self.client._request_with_response(
            f"api/v1/memories?{urlencode(params)}", workspace_id=self.workspace_id
        )
        return MemoryPage(
            memories=cast(Sequence[Memory], response[0]),
            next_cursor=response[1].get("x-lore-next-cursor"),
        )

    def search_memories(
        self,
        query: str,
        *,
        limit: int = 10,
        scope: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        updated_after: Optional[str] = None,
        updated_before: Optional[str] = None,
    ) -> Sequence[MemorySearchResult]:
        normalized = query.strip()
        if not normalized or len(normalized) > 10000:
            raise TypeError("query must contain 1 to 10000 characters")
        params: MutableMapping[str, Union[str, int]] = {
            "q": normalized,
            "limit": _limit(limit, 10),
        }
        self._filters(params, scope, metadata, updated_after, updated_before)
        return cast(
            Sequence[MemorySearchResult],
            self.client._request(
                f"api/v1/memories?{urlencode(params)}", workspace_id=self.workspace_id
            ),
        )

    def search_code(
        self,
        repository_key: str,
        commit_oid: str,
        query: str,
        *,
        limit: int = 10,
        path_prefix: Optional[str] = None,
    ) -> Sequence[CodeArtifact]:
        params: MutableMapping[str, Union[str, int]] = {
            "repository_key": _code_text(repository_key, "repository_key", 512),
            "commit_oid": _commit_oid(commit_oid),
            "q": _code_text(query, "query", 2_000),
            "limit": _limit(limit, 10),
        }
        if path_prefix is not None:
            params["path_prefix"] = _code_text(path_prefix, "path_prefix", 1_024)
        return cast(
            Sequence[CodeArtifact],
            self.client._request(
                f"api/v1/code/search?{urlencode(params)}", workspace_id=self.workspace_id
            ),
        )

    def retrieve_context(
        self,
        query: str,
        *,
        memory_query: Optional[str] = None,
        code_query: Optional[str] = None,
        repository_key: Optional[str] = None,
        commit_oid: Optional[str] = None,
        route: str = "auto",
        memory_limit: int = 5,
        code_limit: int = 10,
        scope: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        path_prefix: Optional[str] = None,
    ) -> RetrievedContext:
        normalized_query = query.strip()
        if not normalized_query or len(normalized_query) > 10_000:
            raise TypeError("query must contain 1 to 10000 characters")
        if (repository_key is None) != (commit_oid is None):
            raise TypeError("repository_key and commit_oid must be provided together")
        if route not in {"auto", "both", "code-only", "memory-only"}:
            raise TypeError("route is invalid")
        if route in {"both", "code-only"} and repository_key is None:
            raise TypeError(f"{route} requires repository_key and commit_oid")
        if path_prefix is not None and repository_key is None:
            raise TypeError("path_prefix requires repository_key and commit_oid")
        if code_query is not None and repository_key is None:
            raise TypeError("code_query requires repository_key and commit_oid")
        body: MutableMapping[str, Any] = {
            "query": normalized_query,
            "route": route,
            "memoryLimit": _limit(memory_limit, 5, 10),
            "codeLimit": _limit(code_limit, 10, 20),
        }
        if memory_query is not None:
            body["memoryQuery"] = _code_text(memory_query, "memory_query", 10_000)
        if code_query is not None:
            body["codeQuery"] = _code_text(code_query, "code_query", 2_000)
        if repository_key is not None and commit_oid is not None:
            body["repositoryKey"] = _code_text(repository_key, "repository_key", 512)
            body["commitOid"] = _commit_oid(commit_oid)
        if scope is not None:
            body["scope"] = _scope(scope)
        if metadata is not None:
            body["metadata"] = dict(metadata)
        if path_prefix is not None:
            body["pathPrefix"] = _code_text(path_prefix, "path_prefix", 1_024)
        return cast(
            RetrievedContext,
            self.client._request(
                "api/v1/context/retrieve",
                method="POST",
                workspace_id=self.workspace_id,
                body=body,
            ),
        )

    def query_code_dependencies(
        self,
        repository_key: str,
        commit_oid: str,
        direction: str,
        *,
        symbol: Optional[str] = None,
        path: Optional[str] = None,
        limit: int = 50,
    ) -> CodeDependencyQueryResult:
        if direction not in {"callers", "callees"}:
            raise TypeError("direction must be callers or callees")
        if (symbol is None) == (path is None):
            raise TypeError("Provide exactly one of symbol or path")
        params: MutableMapping[str, Union[str, int]] = {
            "repository_key": _code_text(repository_key, "repository_key", 512),
            "commit_oid": _commit_oid(commit_oid),
            "direction": direction,
        }
        if symbol is not None:
            params["symbol"] = _code_text(symbol, "symbol", 1_600)
        else:
            selected_path = path or ""
            if (
                not selected_path
                or selected_path != selected_path.strip()
                or len(selected_path) > 1_024
                or selected_path.startswith("/")
                or "\\" in selected_path
                or any(part in {"", ".", ".."} for part in selected_path.split("/"))
            ):
                raise TypeError("path is invalid")
            params["path"] = selected_path
        params["limit"] = _limit(limit, 50, 200)
        return cast(
            CodeDependencyQueryResult,
            self.client._request(
                f"api/v1/code/dependencies?{urlencode(params)}",
                workspace_id=self.workspace_id,
            ),
        )

    def enqueue_code_index(
        self,
        repository_key: str,
        commit_oid: str,
        *,
        source_ref: Optional[str] = None,
    ) -> CodeIndexJob:
        body: MutableMapping[str, str] = {
            "repositoryKey": _code_text(repository_key, "repository_key", 512),
            "commitOid": _commit_oid(commit_oid),
        }
        if source_ref is not None:
            body["sourceRef"] = _code_text(source_ref, "source_ref", 512)
        return cast(
            CodeIndexJob,
            self.client._request(
                "api/v1/code/index-jobs",
                method="POST",
                workspace_id=self.workspace_id,
                body=body,
            ),
        )

    def get_code_index_job(self, job_id: str) -> CodeIndexJob:
        return cast(
            CodeIndexJob,
            self.client._request(
                f"api/v1/code/index-jobs/{_normalized_uuid(job_id, 'job_id')}",
                workspace_id=self.workspace_id,
            ),
        )

    def list_memory_code_evidence(self, memory_id: str) -> Sequence[MemoryCodeEvidence]:
        return cast(
            Sequence[MemoryCodeEvidence],
            self.client._request(
                f"api/v1/memories/{_normalized_uuid(memory_id, 'memory_id')}/code-evidence",
                workspace_id=self.workspace_id,
            ),
        )

    def cite_memory_code_evidence(
        self, memory_id: str, artifact_id: str, relationship: str
    ) -> MemoryCodeEvidence:
        if relationship not in {"supports", "contradicts", "implements", "rationale"}:
            raise TypeError("relationship must be supports, contradicts, implements, or rationale")
        return cast(
            MemoryCodeEvidence,
            self.client._request(
                f"api/v1/memories/{_normalized_uuid(memory_id, 'memory_id')}/code-evidence",
                method="POST",
                workspace_id=self.workspace_id,
                body={
                    "artifactId": _normalized_uuid(artifact_id, "artifact_id"),
                    "relationship": relationship,
                },
            ),
        )

    def revalidate_memory_code_evidence(
        self, evidence_id: str, repository_key: str, commit_oid: str
    ) -> MemoryCodeEvidence:
        return cast(
            MemoryCodeEvidence,
            self.client._request(
                f"api/v1/code-evidence/{_normalized_uuid(evidence_id, 'evidence_id')}/revalidate",
                method="POST",
                workspace_id=self.workspace_id,
                body={
                    "repositoryKey": _code_text(repository_key, "repository_key", 512),
                    "commitOid": _commit_oid(commit_oid),
                },
            ),
        )

    def remember(
        self,
        content: str,
        *,
        scope: str = "shared",
        metadata: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Memory:
        self._content(content)
        return cast(
            Memory,
            self.client._request(
                "api/v1/memories",
                method="POST",
                workspace_id=self.workspace_id,
                body={"content": content, "scope": _scope(scope), "metadata": dict(metadata or {})},
                headers={"idempotency-key": _idempotency_key(idempotency_key)},
            ),
        )

    def list_episodes(
        self,
        *,
        cursor: Optional[str] = None,
        kind: Optional[str] = None,
        limit: int = 50,
        scope: Optional[str] = None,
    ) -> EpisodePage:
        if kind is not None and kind not in {"conversation", "workflow", "document", "event"}:
            raise TypeError("kind must be conversation, workflow, document, or event")
        params: MutableMapping[str, Union[str, int]] = {"limit": _limit(limit, 50)}
        if cursor:
            params["cursor"] = cursor
        if kind:
            params["kind"] = kind
        if scope is not None:
            params["scope"] = cast(str, _scope(scope))
        response = self.client._request_with_response(
            f"api/v1/episodes?{urlencode(params)}", workspace_id=self.workspace_id
        )
        return EpisodePage(
            episodes=cast(Sequence[EpisodeSummary], response[0]),
            next_cursor=response[1].get("x-lore-next-cursor"),
        )

    def record_episode(
        self,
        episode: RecordEpisodeInput,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Episode:
        return cast(
            Episode,
            self.client._request(
                "api/v1/episodes",
                method="POST",
                workspace_id=self.workspace_id,
                body=episode,
                headers={"idempotency-key": _idempotency_key(idempotency_key)},
            ),
        )

    def get_episode(self, episode_id: str) -> Episode:
        identifier = _normalized_uuid(episode_id, "episode_id")
        return cast(
            Episode,
            self.client._request(
                f"api/v1/episodes/{identifier}", workspace_id=self.workspace_id
            ),
        )

    def get_observations(self, observation_ids: Sequence[str]) -> Sequence[Observation]:
        identifiers = list(
            dict.fromkeys(
                _normalized_uuid(identifier, "observation_id")
                for identifier in observation_ids
            )
        )
        if not identifiers or len(identifiers) > 50:
            raise TypeError("observation_ids must contain 1 to 50 UUIDs")
        return cast(
            Sequence[Observation],
            self.client._request(
                f"api/v1/observations?{urlencode([('id', identifier) for identifier in identifiers])}",
                workspace_id=self.workspace_id,
            ),
        )

    def forget_episode(
        self,
        episode_id: str,
        *,
        idempotency_key: Optional[str] = None,
    ) -> None:
        identifier = _normalized_uuid(episode_id, "episode_id")
        self.client._request(
            f"api/v1/episodes/{identifier}",
            method="DELETE",
            workspace_id=self.workspace_id,
            headers={"idempotency-key": _idempotency_key(idempotency_key)},
        )

    def list_memory_proposals(
        self,
        *,
        status: Optional[str] = None,
        limit: int = 50,
    ) -> Sequence[MemoryProposal]:
        if status is not None and status not in {"pending", "accepted", "rejected"}:
            raise TypeError("status must be pending, accepted, or rejected")
        params: MutableMapping[str, Union[str, int]] = {"limit": _limit(limit, 50)}
        if status is not None:
            params["status"] = status
        return cast(
            Sequence[MemoryProposal],
            self.client._request(
                f"api/v1/memory-proposals?{urlencode(params)}",
                workspace_id=self.workspace_id,
            ),
        )

    def propose_memory(
        self,
        proposal: CreateMemoryProposalInput,
        *,
        idempotency_key: Optional[str] = None,
    ) -> MemoryProposal:
        return cast(
            MemoryProposal,
            self.client._request(
                "api/v1/memory-proposals",
                method="POST",
                workspace_id=self.workspace_id,
                body=proposal,
                headers={"idempotency-key": _idempotency_key(idempotency_key)},
            ),
        )

    def review_memory_proposal(
        self,
        proposal_id: str,
        decision: str,
    ) -> MemoryProposalReviewResult:
        if decision not in {"accept", "reject"}:
            raise TypeError("decision must be accept or reject")
        identifier = _normalized_uuid(proposal_id, "proposal_id")
        return cast(
            MemoryProposalReviewResult,
            self.client._request(
                f"api/v1/memory-proposals/{identifier}/review",
                method="POST",
                workspace_id=self.workspace_id,
                body={"decision": decision},
            ),
        )

    def get_memory(self, memory_id: str) -> Memory:
        identifier = _normalized_uuid(memory_id, "memory_id")
        return cast(
            Memory,
            self.client._request(
                f"api/v1/memories/{identifier}", workspace_id=self.workspace_id
            ),
        )

    def update_memory(
        self,
        memory_id: str,
        *,
        expected_version: int,
        content: Optional[str] = None,
        scope: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Memory:
        if content is None and scope is None and metadata is None:
            raise TypeError("content, scope, or metadata is required")
        if content is not None:
            self._content(content)
        version = self._version(expected_version)
        body: MutableMapping[str, Any] = {}
        if content is not None:
            body["content"] = content
        if scope is not None:
            body["scope"] = _scope(scope)
        if metadata is not None:
            body["metadata"] = dict(metadata)
        return cast(
            Memory,
            self.client._request(
                f"api/v1/memories/{_normalized_uuid(memory_id, 'memory_id')}",
                method="PATCH",
                workspace_id=self.workspace_id,
                body=body,
                headers={
                    "if-match": f'"memory-v{version}"',
                    "idempotency-key": _idempotency_key(idempotency_key),
                },
            ),
        )

    def forget_memory(
        self,
        memory_id: str,
        *,
        expected_version: int,
        idempotency_key: Optional[str] = None,
    ) -> None:
        version = self._version(expected_version)
        self.client._request(
            f"api/v1/memories/{_normalized_uuid(memory_id, 'memory_id')}",
            method="DELETE",
            workspace_id=self.workspace_id,
            headers={
                "if-match": f'"memory-v{version}"',
                "idempotency-key": _idempotency_key(idempotency_key),
            },
        )

    @staticmethod
    def _content(content: str) -> None:
        if not isinstance(content, str) or not content.strip():
            raise TypeError("Memory content is required")
        if len(content) > 32_000:
            raise TypeError("Memory content may contain at most 32000 Unicode characters")

    @staticmethod
    def _version(value: int) -> int:
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise TypeError("expected_version must be a positive integer")
        return value

    @staticmethod
    def _filters(
        params: MutableMapping[str, Union[str, int]],
        scope: Optional[str],
        metadata: Optional[Mapping[str, Any]],
        updated_after: Optional[str],
        updated_before: Optional[str],
    ) -> None:
        selected_scope = _scope(scope)
        if selected_scope is not None:
            params["scope"] = selected_scope
        if metadata is not None:
            params["metadata"] = json.dumps(metadata, separators=(",", ":"), sort_keys=True)
        if updated_after is not None:
            params["updated_after"] = updated_after
        if updated_before is not None:
            params["updated_before"] = updated_before
