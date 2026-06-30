# Developer Platform

Build on Mike programmatically: mint a long-lived API key, call the REST API
from the SDKs, explore the machine-readable contract, and receive signed
webhook events.

> Design rationale lives in [ADR 0001](./adr/0001-developer-platform.md).

## 1. Create an API key

Go to **Settings → Developer** in the web app, give the key a name, and click
**Create**. The full secret (`mike_sk_…`) is shown **once** — copy it
immediately. Mike stores only a SHA-256 hash, so it can never show it again.

A key looks like:

```
mike_sk_Ab3xK9p2Qw7r...   ← full secret (shown once)
mike_sk_Ab3xK9            ← prefix shown in the UI afterwards
```

Keys can be **revoked** at any time from the same page; a revoked key stops
working immediately.

### Scopes

| Scope   | Grants                                  |
| ------- | --------------------------------------- |
| `read`  | Safe `GET` / `HEAD` requests            |
| `write` | Everything that mutates (POST/PATCH/…) |

Keys default to both. The server maps the HTTP method to the required scope, so
a `read`-only key is rejected on a `POST` with `403`.

## 2. Authenticate

Send the key as a standard bearer token:

```http
Authorization: Bearer mike_sk_Ab3xK9p2Qw7r...
```

### TypeScript / JavaScript SDK

```ts
import { MikeClient } from "@mike/sdk-js";

const mike = new MikeClient({
  baseUrl: "https://api.example.com",
  apiKey: "mike_sk_Ab3xK9p2Qw7r...", // a Mike API key OR a Supabase JWT
});

const projects = await mike.projects.list();

// Manage keys & webhooks (requires a logged-in user session, not a key):
const key = await mike.apiKeys.create({ name: "CI", scopes: ["read"] });
console.log(key.key); // the one-time secret
```

### Python SDK

```python
from mike import MikeClient

mike = MikeClient(base_url="https://api.example.com", api_key="mike_sk_...")
projects = mike.projects.list()

created = mike.api_keys.create(name="CI")
print(created.key)  # one-time secret
```

### curl

```bash
curl https://api.example.com/projects \
  -H "Authorization: Bearer mike_sk_Ab3xK9p2Qw7r..."
```

> **Key management endpoints require a user session, not a key.** You cannot
> mint or revoke keys, or configure webhooks, using an API key — only a
> logged-in user (Supabase JWT) can. This prevents a leaked key from escalating
> its own privileges.

## 3. Explore the API contract

- **`GET /openapi.json`** — the OpenAPI 3.1 document (the source of truth).
- **`GET /docs`** — interactive Swagger UI rendered from that document.

Point Postman, an SDK generator, or your editor at `/openapi.json` to get typed
clients and request validation for free.

## 4. Webhooks

Register an endpoint on **Settings → Developer**, choose the events you care
about, and copy the **signing secret** (`whsec_…`) shown once at creation.

### Event catalogue

| Event                | Fires when…                                   |
| -------------------- | --------------------------------------------- |
| `document.uploaded`  | a document finishes uploading & processing    |
| `document.analysed`  | a document analysis completes *(reserved)*    |
| `chat.message`       | an assistant message is produced *(reserved)* |
| `workflow.completed` | a workflow run finishes *(reserved)*          |

`document.uploaded` is wired today; the others are catalogued and ready to wire.
Fetch the live list from `GET /v1/webhooks/events`.

### Delivery format

Each delivery is a `POST` with a JSON envelope:

```json
{
  "id": "8f3c…",
  "type": "document.uploaded",
  "created_at": "2026-06-29T12:00:00.000Z",
  "data": {
    "document_id": "…",
    "project_id": "…",
    "filename": "contract.pdf",
    "file_type": "pdf",
    "size_bytes": 12345,
    "page_count": 7
  }
}
```

Headers:

| Header               | Meaning                                      |
| -------------------- | -------------------------------------------- |
| `X-Mike-Event`       | the event type                               |
| `X-Mike-Delivery-Id` | unique id — use as an **idempotency key**    |
| `X-Mike-Signature`   | hex HMAC-SHA256 of the raw body              |

Failed deliveries are retried with exponential backoff (up to 5 attempts:
0s, 5s, 30s, 2m, 10m). Inspect attempts and responses under **Recent
deliveries** or via `GET /v1/webhooks/deliveries`.

### Verifying the signature

Always verify `X-Mike-Signature` before trusting a payload. Compute
`HMAC-SHA256(rawBody, yourEndpointSecret)` and compare in constant time.

**Node.js / Express:**

```ts
import crypto from "crypto";
import express from "express";

const app = express();

// IMPORTANT: verify against the RAW body bytes, not a re-serialized object.
app.post(
  "/webhooks/mike",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.header("X-Mike-Signature") ?? "";
    const expected = crypto
      .createHmac("sha256", process.env.MIKE_WEBHOOK_SECRET!)
      .update(req.body) // req.body is a Buffer here
      .digest("hex");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).send("bad signature");
    }

    const event = JSON.parse(req.body.toString("utf8"));
    // …handle event.type / event.data, ack fast, do work async…
    res.sendStatus(200);
  },
);
```

**Python:**

```python
import hashlib
import hmac

def verify(raw_body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

Respond `2xx` quickly (do heavy work asynchronously); any non-2xx or timeout
triggers a retry.
