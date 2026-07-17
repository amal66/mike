from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .._models import (
    WebhookDelivery,
    WebhookEndpoint,
    WebhookEndpointCreateResponse,
)

if TYPE_CHECKING:
    from .._client import AsyncMikeClient, MikeClient


class WebhooksResource:
    """Register webhook endpoints and inspect deliveries."""

    def __init__(self, client: "MikeClient") -> None:
        self._client = client

    def list_event_types(self) -> list[str]:
        response = self._client._request("GET", "/v1/webhooks/events")
        return list(response.json().get("event_types", []))

    def list_endpoints(self) -> list[WebhookEndpoint]:
        response = self._client._request("GET", "/v1/webhooks/endpoints")
        return [WebhookEndpoint.model_validate(item) for item in response.json()]

    def create_endpoint(
        self, *, url: str, event_types: list[str]
    ) -> WebhookEndpointCreateResponse:
        body: dict[str, Any] = {"url": url, "event_types": event_types}
        response = self._client._request("POST", "/v1/webhooks/endpoints", json=body)
        return WebhookEndpointCreateResponse.model_validate(response.json())

    def delete_endpoint(self, endpoint_id: str) -> None:
        self._client._request("DELETE", f"/v1/webhooks/endpoints/{endpoint_id}")

    def list_deliveries(
        self, *, endpoint_id: str | None = None, limit: int | None = None
    ) -> list[WebhookDelivery]:
        params: dict[str, Any] = {}
        if endpoint_id is not None:
            params["endpoint_id"] = endpoint_id
        if limit is not None:
            params["limit"] = limit
        response = self._client._request(
            "GET", "/v1/webhooks/deliveries", params=params or None
        )
        return [WebhookDelivery.model_validate(item) for item in response.json()]


class AsyncWebhooksResource:
    def __init__(self, client: "AsyncMikeClient") -> None:
        self._client = client

    async def list_event_types(self) -> list[str]:
        response = await self._client._request("GET", "/v1/webhooks/events")
        return list(response.json().get("event_types", []))

    async def list_endpoints(self) -> list[WebhookEndpoint]:
        response = await self._client._request("GET", "/v1/webhooks/endpoints")
        return [WebhookEndpoint.model_validate(item) for item in response.json()]

    async def create_endpoint(
        self, *, url: str, event_types: list[str]
    ) -> WebhookEndpointCreateResponse:
        body: dict[str, Any] = {"url": url, "event_types": event_types}
        response = await self._client._request(
            "POST", "/v1/webhooks/endpoints", json=body
        )
        return WebhookEndpointCreateResponse.model_validate(response.json())

    async def delete_endpoint(self, endpoint_id: str) -> None:
        await self._client._request(
            "DELETE", f"/v1/webhooks/endpoints/{endpoint_id}"
        )

    async def list_deliveries(
        self, *, endpoint_id: str | None = None, limit: int | None = None
    ) -> list[WebhookDelivery]:
        params: dict[str, Any] = {}
        if endpoint_id is not None:
            params["endpoint_id"] = endpoint_id
        if limit is not None:
            params["limit"] = limit
        response = await self._client._request(
            "GET", "/v1/webhooks/deliveries", params=params or None
        )
        return [WebhookDelivery.model_validate(item) for item in response.json()]
