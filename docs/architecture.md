# Architecture

Mike is organized as a monorepo with deployable apps in `apps/` and reusable
libraries in `packages/`.

## Layers

- `packages/core` contains framework-free contracts, shared domain types, and
  portable utilities. It must not import from apps.
- `packages/api-client` contains the typed HTTP client used by the web app and
  SDKs.
- `packages/sdk-js` exposes the public JavaScript SDK facade.
- `packages/shared` is the design system consumed by both `apps/web` and the
  Word add-in.
- `apps/api` owns HTTP routing, authentication, persistence, document
  processing, and provider integrations.
- `apps/web` owns the Next.js user interface.
- `word-addin/` is the Office.js task pane (not an npm workspace; built via
  `npm run build:word-addin`).

Dependencies should point inward:

```text
apps/web   -> packages/api-client -> packages/core
apps/api   -> packages/core
sdk-js     -> packages/api-client -> packages/core
word-addin -> packages/shared (design system), packages/api-client
```

## API Modules

API route implementations live under `apps/api/src/modules/<feature>`, one
directory per feature (`auth`, `case-law`, `chat`, `documents`, `downloads`,
`project-chat`, `projects`, `tabular`, `user`, `workflows`), mounted directly
in `apps/api/src/app.ts`.

The convention inside a module:

- `<module>.routes.ts` — HTTP concerns only: auth extraction, zod request
  validation, status codes, headers.
- `<module>.service.ts` — business logic. Service functions take the database
  client and plain params (never `req`/`res`) and return typed results the
  routes map onto responses. Large services are decomposed into cohesive
  sibling files (e.g. `documents.versions.ts`, `tabular.extract.ts`) with
  `<module>.service.ts` as the stable facade, so importers never chase the
  internal layout.
- `__tests__/` — module tests.

Two modules are deliberately routes-only (`case-law`, `downloads`): their
logic lives in `lib/` and the route files are pure HTTP mapping.

Cross-cutting infrastructure lives in `apps/api/src/lib/`: access control
(`access.ts`), the LLM provider registry (`llm/`), the storage adapter
(`storage/`), the tool-call dispatcher (`tools/`), MCP connectors (`mcp/`),
jurisdiction law libraries (`lawLibraries/`), the BullMQ background job queues
(`queue/` + `workers/` — DOCX→PDF conversion and tabular-review extraction; see
[async-jobs.md](async-jobs.md)), and the air-gap posture (`airgap.ts`,
`secretGuard.ts`).

Compatibility exports remain under `apps/api/src/routes` so the server entry
point's import list stays small and stable (e.g. `routes/billing.ts` re-exports
the billing router from its module).

## Billing

Optional Stripe billing lives in `apps/api/src/lib/billing` (plan catalogue,
Stripe client, webhook handler) with routes in `apps/api/src/modules/billing`.
Subscription tiers map to the existing message-credit limits in `lib/credits.ts`
rather than introducing a separate metering system. Billing is disabled unless
`STRIPE_SECRET_KEY` is set, so self-hosted deployments are unaffected by
default. See [billing.md](./billing.md) and
[ADR 0002](./adr/0002-stripe-billing.md).
