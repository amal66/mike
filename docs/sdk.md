# JavaScript SDK

The JavaScript SDK lives in `packages/sdk-js`. It wraps the lower-level
`@mike/api-client` package with a small class-based facade.

```ts
import { MikeClient } from "@mike/sdk-js";

const mike = new MikeClient({
  baseUrl: "https://api.example.com",
  // `apiKey` accepts a programmatic Mike API key (`mike_sk_...`) or a Supabase
  // session JWT. Either is sent as `Authorization: Bearer <apiKey>`.
  apiKey: "mike_sk_...",
});

const projects = await mike.projects.list();
```

## API-key authentication

Create a long-lived key under **Settings → Developer** (or `mike.apiKeys.create`)
and pass it as `apiKey`. Keys are revocable and carry `read`/`write` scopes. The
SDK also exposes `mike.apiKeys` and `mike.webhooks` for managing them — see the
[Developer Platform guide](./developer-platform.md). The Python SDK takes the
same credential via `MikeClient(base_url=..., api_key="mike_sk_...")`.

The machine-readable contract is published at `GET /openapi.json` (rendered at
`GET /docs`); SDK generation from it is planned.

The SDK should stay thin. Add shared types and stable contracts to
`packages/core`, low-level endpoint calls to `packages/api-client`, and ergonomic
workflows to `packages/sdk-js`.
