# ADR 0002: Stripe billing & usage metering

- Status: Accepted
- Date: 2026-06-29
- Deciders: Mike maintainers
- Related: PR #157 (credit-limit enforcement), `apps/api/src/lib/credits.ts`

> Numbering note: this is `0002` rather than `0001` to avoid colliding with a
> concurrently developed Developer-Platform/SDK ADR that also takes `0001`.

## Context

Mike already meters usage. PR #157 added a per-user monthly message budget:
`user_profiles.message_credits_used`, `credits_reset_date`, and a single
`MONTHLY_CREDIT_LIMIT` constant enforced on every chat request
(`lib/credits.ts`). What it lacked was a way to *change* a user's limit by
charging them — i.e. subscription billing.

This is the single most-requested capability in the fork ecosystem. Multiple
independent forks built it without coordination:

- **fpvetleseter/mike** shipped a full Stripe integration: Checkout, Customer
  Portal, webhooks, and a settings page.
- **CaseMark** added usage-budget metering.
- **marklok** added a 30-message/month platform budget.

The strong signal is: people want subscription tiers that map to usage limits,
and they want it to be self-hostable. Two hard constraints follow:

1. **Self-hosting must stay first-class.** Mike is AGPL software that many
   people run for themselves with their own LLM API keys. They must never be
   forced to set up Stripe, and enabling this feature must not change their
   experience unless they opt in.
2. **We must build on the existing credits system, not a parallel one.** A
   second metering mechanism would be a correctness and maintenance hazard.

## Decision

Add a Stripe-backed subscription layer whose *only* job is to decide which
**tier** a user is on; the existing credits system then derives the monthly
limit from that tier.

### Tiers

A single source of truth in `apps/api/src/lib/billing/plans.ts` defines three
tiers. Each maps to a display name, a Stripe Price ID (from the environment),
and a monthly message-credit allowance:

| Tier       | Default credits/mo | Stripe price env        |
| ---------- | ------------------ | ----------------------- |
| Free       | 50                 | — (never purchased)     |
| Pro        | 1,500              | `STRIPE_PRICE_PRO`        |
| Enterprise | 10,000             | `STRIPE_PRICE_ENTERPRISE` |

Allowances are overridable per tier via env (`FREE_TIER_CREDITS`, etc.) so
operators can tune them without a code change.

### Billing disabled by default

`isBillingEnabled()` is true **only** when `STRIPE_SECRET_KEY` is set. When it
is unset:

- `creditLimitForTier()` returns the generous self-host default
  (`MONTHLY_CREDIT_LIMIT`, defaulting to 999,999) for *every* tier — identical
  to pre-billing behaviour.
- `/billing/checkout` and `/billing/portal` return `503 BILLING_DISABLED`.
- The web Billing page renders a "billing is not enabled" notice instead of
  upgrade buttons.

A self-hoster who never sets Stripe env vars sees exactly what they saw before.

### Webhook-driven state sync

Stripe is the source of truth for subscription state. We sync our database in
response to verified webhook events (`checkout.session.completed`,
`customer.subscription.created|updated|deleted`, `invoice.paid`) rather than
polling Stripe. `tierFromSubscription()` maps a live (`active`/`trialing`)
subscription's price to a tier; any other status maps to `Free`, so a
cancellation automatically demotes the user. `invoice.paid` resets the user's
monthly credits at renewal, reusing the existing credits columns.

### Schema: columns on `user_profiles`

Subscription fields (`stripe_customer_id`, `stripe_subscription_id`,
`subscription_status`, `subscription_current_period_end`) live directly on
`user_profiles`. A separate `billing_events` table records processed webhook
event ids for idempotency.

## Alternatives considered

**Billing model — tier subscriptions vs. usage-based metered billing vs.
prepaid credits.** Usage-based (report each message to Stripe as a metered
event) maps cleanly onto our per-message credits but adds latency/failure modes
to the hot chat path and a Stripe dependency on every message. Prepaid credit
packs are a worse UX for a recurring tool. **Chosen:** flat tier subscriptions —
simplest correct mapping onto the existing monthly budget, with metered billing
listed as future work.

**Sync strategy — webhooks vs. polling.** Polling Stripe on a timer is simpler
to reason about but is laggy and wastes API calls. **Chosen:** webhooks, the
Stripe-recommended approach, with idempotency to handle at-least-once delivery.

**Schema — columns on `user_profiles` vs. a dedicated `billing_customers`
table.** A dedicated table is "cleaner" relationally and better if a user could
have many subscriptions. But a Mike user has exactly one customer and one
subscription, the credit check already reads `user_profiles` on every chat
request, and `handle_new_user()` already provisions a profile row with the right
RLS. **Chosen:** columns on `user_profiles` (avoids a join on the hot path and
reuses existing provisioning); a separate `billing_events` ledger only for
idempotency, where a per-row lifecycle genuinely differs.

## Security model

- **Server-side price resolution.** The client may request a *tier*; it can
  never supply a price. `priceIdForTier()` resolves tier → price on the server,
  so a tampered client cannot check out at an attacker-chosen amount.
- **Webhook signature verification.** The webhook endpoint is public, so we
  verify Stripe's HMAC signature (`Stripe-Signature` header vs.
  `STRIPE_WEBHOOK_SECRET`) on every request and reject unverified payloads with
  `400`. Without this, anyone could POST a forged "you are now Enterprise"
  event.
- **Raw body.** The signature is computed over the exact bytes Stripe sent, so
  the webhook route is mounted with `express.raw` **before** the global
  `express.json` parser (see `app.ts`). Parsing then re-serialising the JSON
  would change the bytes and break verification.
- **Idempotency.** Stripe delivers events at-least-once and retries on timeout.
  Each event id is recorded in `billing_events`; duplicates are skipped, so a
  replayed `invoice.paid` can't reset credits twice.
- **Least privilege.** Billing tables are backend-only: RLS is enabled and
  `anon`/`authenticated` grants are revoked, matching the deny-all convention in
  `20260524000000_rls_deny_all.sql`. The API uses the service-role key, which
  bypasses RLS.

## Consequences

**Positive**

- Subscriptions change real usage limits through one well-tested function
  (`creditLimitForTier`), with no second metering system.
- Self-hosting is unaffected unless Stripe is explicitly configured.
- The webhook is signature-verified and idempotent; failures are safe to retry.

**Negative / trade-offs**

- Tier→credit mapping is monthly and flat; true usage-based billing (per-token)
  is not yet supported.
- Subscription state on `user_profiles` assumes one subscription per user; org
  / seat billing would need a schema change.

## Future work

Usage-based metered billing (per-token), seat/organisation billing, in-app
proration previews, and dunning emails for failed payments via the existing
Resend integration.
