# ADR 0001 — Developer Platform: programmatic API keys, OpenAPI spec & webhooks

- **Status:** Accepted
- **Date:** 2026-06-29
- **Deciders:** Mike maintainers
- **Related docs:** [Developer Platform guide](../developer-platform.md), [API](../api.md), [SDK](../sdk.md)

## Context

Mike ships TypeScript and Python SDKs, but both authenticate with a short-lived
**Supabase session JWT** — the credential a browser obtains after login. That is
fine for a logged-in web user and useless for the things developers actually
want to do:

- call the API from a **script, cron job, or CI pipeline** where there is no
  interactive login and no token-refresh loop;
- receive **push notifications** when something happens to their data, instead
  of polling;
- discover the API from a **machine-readable contract** rather than reading
  source.

The fork ecosystem points the same direction: many forks add BYOK / provider
integrations, MCP connectors, and developer onboarding tours. The natural
platform layer underneath all of that — the thing that turns "an app with an
API" into "a platform you can build on" (the Dub-inspired brainstorm) — is a
first-class **programmatic credential + event delivery + published contract**.

This ADR records the decisions made while building that layer.

## Decision

Add three cohesive capabilities, plus the SDK and UI surface to use them.

### 1. Opaque, hashed API keys (not JWTs, not stored secrets)

A Mike API key is an **opaque bearer token** formatted `mike_sk_<base62>`
(~238 bits of entropy). The auth middleware accepts **either** a Supabase JWT
(unchanged) **or** an API key, branching on the `mike_sk_` prefix.

- We store **only a SHA-256 hash** of the key plus a short non-secret
  **prefix** (e.g. `mike_sk_Ab3xK9`) for display and fast lookup. The full
  secret is returned **exactly once**, at creation.
- Verification is **constant-time** (`crypto.timingSafeEqual`).
- Keys carry **scopes** (`read`, `write`); the middleware maps HTTP method →
  required scope.
- Management routes (`/v1/api-keys`) require a **real user session** — you
  cannot mint a key with a key.

### 2. OpenAPI 3.1 as a published contract

A 3.1 document describes the public surface (API-key + webhook routes plus the
existing projects / documents / chat endpoints the SDKs already call). It is
served at `GET /openapi.json` and rendered at `GET /docs` (Swagger UI).

### 3. Webhooks with HMAC signatures and in-process retries

`webhook_endpoints` (url, secret, enabled, event types) and
`webhook_deliveries` (event, payload, status, attempts, response). A delivery
service signs each payload with **HMAC-SHA256** (`X-Mike-Signature`), retries
with **exponential backoff**, and records every attempt. At least one real emit
point is wired (`document.uploaded`).

## Alternatives considered

### Credential: opaque hashed token vs long-lived JWT vs stored secret

| Option | Verdict |
| --- | --- |
| **Long-lived JWT** | Rejected. JWTs can't be revoked without a denylist (they're valid until expiry), and a long expiry is exactly what you don't want for a credential that lives in CI logs. |
| **Store the key as-is / reversibly encrypted** | Rejected. A DB leak would expose live credentials. We never need the original, so we don't keep it. |
| **Opaque token, store only a SHA-256 hash** | **Chosen.** Instantly revocable (flip `revoked_at`), unusable if the DB leaks, and cheap to verify. |

Why **SHA-256, not bcrypt/argon2**: slow password hashes defend *low-entropy*
human passwords against brute force. A 40-char random base62 secret is not
brute-forceable, so a fast hash is the correct, cheaper choice — the same
reasoning Stripe/GitHub use for their `sk_`-style keys.

### Contract: hand-authored vs generated from Zod

The repo runs **Zod v4**. The popular `@asteasolutions/zod-to-openapi`
generator targets Zod v3's API, so integrating it cleanly would mean pinning an
older Zod or shimming every schema — more moving parts than a curated spec for a
handful of public endpoints. We **hand-authored** a typed OpenAPI 3.1 document
(`apps/api/src/lib/openapi.ts`) and treat keeping it in sync as part of "done".
**Generating SDKs *from* this spec** is listed as future work — the inverse of
generating the spec from code, and the higher-leverage direction.

### Webhook delivery: in-process vs durable queue (Redis/BullMQ)

We deliberately keep delivery **in-process** (`setTimeout` retries). Mike is
self-hostable as a single service; bolting on Redis/BullMQ would raise the
operational bar for every self-hoster to serve a feature most won't use on day
one. We mitigate the main downside — deliveries scheduled but unsent are lost on
restart — by **persisting every delivery row up front**, so history and
(future) replay are always available. Moving to a durable queue is documented as
future work.

## Consequences

**Positive**

- Scripts, CI, and third-party tools get a real, revocable credential.
- Existing JWT auth, MFA, and every current route are **unchanged** — the new
  branch is purely additive.
- One published contract drives docs today and SDK generation tomorrow.
- Webhooks turn integrations from polling into push.

**Negative / trade-offs**

- The OpenAPI document is maintained by hand (mitigated: small surface, typed,
  part of review).
- In-process delivery is not durable across restarts (mitigated: rows persisted;
  queue is future work).
- API keys bypass interactive MFA (see below) — an intentional trade-off.

## Security considerations

- **Why hash, not store:** a leaked database must not yield usable credentials.
  We persist only `sha256(token)`; the API only ever compares hashes.
- **Why constant-time compare:** a byte-by-byte `===` leaks, via timing, how
  many leading bytes of a guess were right — enough to forge a secret
  incrementally. `crypto.timingSafeEqual` removes that signal.
- **Prefix lookup:** we index and look keys up by the **non-secret** prefix, then
  constant-time compare the full hash — avoiding both a table scan and a
  timing-unsafe SQL equality on the secret.
- **Scope model:** `read` for `GET`/`HEAD`, `write` for everything else. Keys
  default to both (session parity); a narrower key is a least-privilege upgrade.
- **MFA and API keys:** keys **bypass** the interactive MFA-on-login gate by
  design. MFA protects browser sessions; a programmatic key is a distinct factor
  (possession) that the user explicitly minted and can revoke instantly. Forcing
  `aal2` on a headless key would make it unusable. Management routes still run
  inside a full MFA-enforced session.
- **Webhook HMAC:** receivers verify `X-Mike-Signature` (HMAC-SHA256 over the
  exact body) with their per-endpoint secret — proving authenticity + integrity.
  HTTPS is required for endpoints in production.
- **RLS:** all three tables get RLS enabled + a deny-all policy and have direct
  privileges revoked from `anon`/`authenticated`, consistent with the repo's
  default-deny posture. All access flows through the backend service role.

## Future work

- Durable, queued delivery (BullMQ) with dead-letter handling and manual replay.
- OAuth 2.1 for third-party apps acting on behalf of users.
- Usage analytics per key (rate, error rate, top endpoints).
- **SDK auto-generation from the OpenAPI spec** (TS + Python), closing the loop.
- Per-route scope granularity beyond read/write.
