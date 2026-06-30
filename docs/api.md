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

## Billing

When Stripe is configured, the API exposes a billing surface under `/billing`
(`GET /billing/subscription`, `POST /billing/checkout`, `POST /billing/portal`,
and the Stripe event sink `POST /billing/webhook`). Subscription tiers map to
the existing message-credit limits. The webhook is mounted with a raw-body
parser ahead of `express.json` so Stripe signatures can be verified. When Stripe
is not configured the feature is disabled and these routes are inert. See
[billing.md](./billing.md) and [ADR 0002](./adr/0002-stripe-billing.md).

## OpenAI-Compatible Gateways

The API can route OpenAI-model requests through an OpenAI-compatible gateway by
setting:

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
```

Use this for compatible gateways such as hosted OpenAI-compatible proxies. In
production, the URL must use HTTPS. Local HTTP endpoints are allowed only for
development unless `OPENAI_ALLOW_LOCAL_BASE_URL=true` is set deliberately.
