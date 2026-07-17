from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .._models import ApiKey, ApiKeyCreateResponse

if TYPE_CHECKING:
    from .._client import AsyncMikeClient, MikeClient


class ApiKeysResource:
    """Manage programmatic API keys.

    Note: these endpoints require an interactive user session (a Supabase JWT).
    You cannot mint a key using another API key.
    """

    def __init__(self, client: "MikeClient") -> None:
        self._client = client

    def list(self) -> list[ApiKey]:
        response = self._client._request("GET", "/v1/api-keys")
        return [ApiKey.model_validate(item) for item in response.json()]

    def create(
        self, *, name: str, scopes: list[str] | None = None
    ) -> ApiKeyCreateResponse:
        body: dict[str, Any] = {"name": name}
        if scopes is not None:
            body["scopes"] = scopes
        response = self._client._request("POST", "/v1/api-keys", json=body)
        return ApiKeyCreateResponse.model_validate(response.json())

    def revoke(self, key_id: str) -> None:
        self._client._request("DELETE", f"/v1/api-keys/{key_id}")


class AsyncApiKeysResource:
    def __init__(self, client: "AsyncMikeClient") -> None:
        self._client = client

    async def list(self) -> list[ApiKey]:
        response = await self._client._request("GET", "/v1/api-keys")
        return [ApiKey.model_validate(item) for item in response.json()]

    async def create(
        self, *, name: str, scopes: list[str] | None = None
    ) -> ApiKeyCreateResponse:
        body: dict[str, Any] = {"name": name}
        if scopes is not None:
            body["scopes"] = scopes
        response = await self._client._request("POST", "/v1/api-keys", json=body)
        return ApiKeyCreateResponse.model_validate(response.json())

    async def revoke(self, key_id: str) -> None:
        await self._client._request("DELETE", f"/v1/api-keys/{key_id}")
