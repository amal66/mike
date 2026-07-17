# API

The Express API lives in `apps/api`. The typed client lives in
`packages/api-client` and is the preferred way for first-party TypeScript code
to call the API.

Configure the client with a base URL and an auth-header provider:

```ts
import { configureMikeApiClient, listProjects } from "@mike/api-client";

configureMikeApiClient({
  baseUrl: "http://localhost:3001",
  async getAuthHeaders() {
    return { Authorization: `Bearer ${token}` };
  },
});

const projects = await listProjects();
```

Public request and response shapes should be defined in `packages/core` before
they are consumed by API handlers, the web app, or SDKs.

## Authentication

Protected routes accept **either**:

- a **Supabase session JWT** (the web app's credential), or
- a **programmatic API key** — `Authorization: Bearer mike_sk_...` — created
  under **Settings → Developer**.

API keys are opaque, hashed at rest, revocable, and carry `read`/`write` scopes.
Key and webhook **management** routes (`/v1/api-keys`, `/v1/webhooks`) require a
session JWT, not a key. Full details in the
[Developer Platform guide](./developer-platform.md) and
[ADR 0001](./adr/0001-developer-platform.md).

## OpenAPI contract

The public surface is described by an OpenAPI 3.1 document:

- `GET /openapi.json` — the machine-readable spec (source of truth).
- `GET /docs` — interactive Swagger UI rendered from it.

## OpenAI-Compatible Gateways

The API can route OpenAI-model requests through an OpenAI-compatible gateway by
setting:

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
```

Use this for compatible gateways such as hosted OpenAI-compatible proxies. In
production, the URL must use HTTPS. Local HTTP endpoints are allowed only for
development unless `OPENAI_ALLOW_LOCAL_BASE_URL=true` is set deliberately.
