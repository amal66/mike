"""Tests for the developer-platform resources and API-key authentication."""

from __future__ import annotations

import httpx
import respx

from mike import MikeClient
from mike._client import _build_headers

BASE_URL = "https://api.example.com"


# ---------------------------------------------------------------------------
# Authentication header construction
# ---------------------------------------------------------------------------

def test_api_key_sets_bearer_header():
    headers = _build_headers(access_token=None, api_key="mike_sk_abc123")
    assert headers["Authorization"] == "Bearer mike_sk_abc123"


def test_access_token_still_supported():
    headers = _build_headers(access_token="sess-1", api_key=None)
    assert headers["Authorization"] == "Bearer sess-1"


def test_api_key_takes_precedence_over_access_token():
    headers = _build_headers(access_token="sess-1", api_key="mike_sk_abc123")
    assert headers["Authorization"] == "Bearer mike_sk_abc123"


def test_client_uses_api_key_on_requests():
    client = MikeClient(base_url=BASE_URL, api_key="mike_sk_abc123")
    with respx.mock:
        route = respx.get(f"{BASE_URL}/v1/api-keys").mock(
            return_value=httpx.Response(200, json=[])
        )
        client.api_keys.list()
        assert route.calls.last.request.headers["Authorization"] == (
            "Bearer mike_sk_abc123"
        )


# ---------------------------------------------------------------------------
# API keys
# ---------------------------------------------------------------------------

@respx.mock
def test_create_api_key_returns_secret_once():
    client = MikeClient(base_url=BASE_URL, access_token="t")
    respx.post(f"{BASE_URL}/v1/api-keys").mock(
        return_value=httpx.Response(
            201,
            json={
                "id": "k1",
                "name": "CI",
                "key_prefix": "mike_sk_Ab3xK9",
                "scopes": ["read", "write"],
                "last_used_at": None,
                "created_at": "2026-06-29T00:00:00Z",
                "key": "mike_sk_thefullsecret",
            },
        )
    )
    created = client.api_keys.create(name="CI")
    assert created.key == "mike_sk_thefullsecret"
    assert created.key_prefix == "mike_sk_Ab3xK9"


@respx.mock
def test_list_api_keys():
    client = MikeClient(base_url=BASE_URL, access_token="t")
    respx.get(f"{BASE_URL}/v1/api-keys").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "k1",
                    "name": "CI",
                    "key_prefix": "mike_sk_Ab3xK9",
                    "scopes": ["read"],
                    "last_used_at": None,
                    "created_at": "2026-06-29T00:00:00Z",
                }
            ],
        )
    )
    keys = client.api_keys.list()
    assert keys[0].id == "k1"
    assert keys[0].scopes == ["read"]


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------

@respx.mock
def test_create_webhook_endpoint_returns_secret():
    client = MikeClient(base_url=BASE_URL, access_token="t")
    respx.post(f"{BASE_URL}/v1/webhooks/endpoints").mock(
        return_value=httpx.Response(
            201,
            json={
                "id": "wh1",
                "url": "https://example.com/hook",
                "enabled": True,
                "event_types": ["document.uploaded"],
                "created_at": "2026-06-29T00:00:00Z",
                "updated_at": "2026-06-29T00:00:00Z",
                "secret": "whsec_abc",
            },
        )
    )
    endpoint = client.webhooks.create_endpoint(
        url="https://example.com/hook", event_types=["document.uploaded"]
    )
    assert endpoint.secret == "whsec_abc"
    assert endpoint.event_types == ["document.uploaded"]


@respx.mock
def test_list_webhook_deliveries():
    client = MikeClient(base_url=BASE_URL, access_token="t")
    respx.get(f"{BASE_URL}/v1/webhooks/deliveries").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "d1",
                    "endpoint_id": "wh1",
                    "event_type": "document.uploaded",
                    "status": "succeeded",
                    "attempts": 1,
                    "response_status": 200,
                    "last_error": None,
                    "created_at": "2026-06-29T00:00:00Z",
                    "delivered_at": "2026-06-29T00:00:01Z",
                }
            ],
        )
    )
    deliveries = client.webhooks.list_deliveries()
    assert deliveries[0].status == "succeeded"
    assert deliveries[0].response_status == 200
