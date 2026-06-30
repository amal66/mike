# feat: Stripe billing — subscription tiers, usage metering & customer portal

## Summary

Adds an optional, self-hostable Stripe billing layer that maps subscription
**tiers** to monthly **message-credit limits**, building directly on the credit
system from PR #157 rather than introducing a parallel meter. Includes Checkout,
the Customer Portal, a signature-verified + idempotent webhook, a
`GET /billing/subscription` usage endpoint, schema + migration, an account
**Billing** page, and full docs (an ADR and an operator guide).

**Billing is disabled by default.** With no `STRIPE_SECRET_KEY`, everything
degrades to the pre-billing behaviour: a generous default credit allowance and
inert billing routes. Self-hosters are unaffected.

## Motivation

Mike's roadmap calls for "Payments & Billing", and the fork ecosystem has
independently demanded it — several forks built their own versions without
coordination:

- **fpvetleseter/mike** — full Stripe Checkout / Portal / webhook / settings.
- **CaseMark** — usage-budget metering.
- **marklok** — a 30-message/month platform budget.
- **PR #157** — the per-user monthly credit-limit enforcement this PR builds on.

The lesson from that fragmentation: people want subscription tiers wired to
usage limits, and it must stay self-hostable. This PR delivers one cohesive,
upstreamable version.

## Architecture & data flow

```
                 (1) POST /billing/checkout {tier}
  Browser ───────────────────────────────────────────▶ API
     ▲                                                   │ priceIdForTier(tier)  ← server resolves price
     │                                                   │ getOrCreateCustomer()
     │            (2) redirect to Checkout URL           ▼
     └──────────────────────────────────────────  Stripe Checkout
                                                         │ user pays
                                                         ▼
                          (3) webhook events (signed, raw body)
  Stripe ──────────────────────────────────────────────▶ POST /billing/webhook
                                                         │ constructWebhookEvent() verifies signature
                                                         │ claimEvent() → idempotency (billing_events)
                                                         │ tierFromSubscription() → tier
                                                         ▼
                                              user_profiles.tier / status / period_end
                                                         │
                          (4) every chat request          ▼
  checkMessageCredits() ── creditLimitForTier(tier) ── allow / 429 CREDIT_LIMIT_EXCEEDED
```

- **Tier → limit** is the whole point: `creditLimitForTier()` is the single
  function the credits system calls. Billing only changes which tier a user is
  on; the existing meter does the rest.
- **Stripe is the source of truth**; we sync our DB from webhook events instead
  of polling.

## Design decisions

Full rationale (billing model, sync strategy, schema layout, security model,
alternatives, future work) is in
[`docs/adr/0002-stripe-billing.md`](docs/adr/0002-stripe-billing.md).
Highlights:

- **Tiers:** Free (50) / Pro (1,500) / Enterprise (10,000) messages per month,
  all env-overridable. Price IDs come from the environment.
- **Schema:** subscription columns on `user_profiles` (1:1 with a user, avoids a
  join on the hot credit-check path) + a `billing_events` idempotency ledger.
- **Self-host first:** `isBillingEnabled()` gates everything on
  `STRIPE_SECRET_KEY`.

## Security model

- **Server-side price resolution** — the client sends a *tier*, never a price;
  `priceIdForTier()` maps it server-side, so a tampered client can't pick the
  amount.
- **Webhook signature verification** — every webhook is verified against
  `STRIPE_WEBHOOK_SECRET`; unverified payloads get `400`.
- **Raw body** — the webhook route mounts `express.raw` *before* the global
  `express.json` parser, because Stripe's HMAC is over the exact bytes sent
  (re-serialising would break verification).
- **Idempotency** — Stripe delivers at-least-once; each event id is recorded in
  `billing_events` and duplicates are skipped, so a replayed `invoice.paid`
  can't reset credits twice.
- **Least privilege** — billing tables have RLS enabled and `anon`/
  `authenticated` grants revoked (deny-all convention); the API uses the
  service-role key.

## What's included

**Backend**
- `apps/api/src/lib/billing/plans.ts` — tier catalogue, `isBillingEnabled`,
  `creditLimitForTier`, `priceIdForTier`, `tierForPriceId`.
- `apps/api/src/lib/billing/stripe.ts` — lazy Stripe client (pinned API
  version), customer create/link, subscription → tier/snapshot mapping.
- `apps/api/src/lib/billing/webhook.ts` — signature verification, idempotency,
  event handling.
- `apps/api/src/modules/billing/billing.routes.ts` — checkout / portal /
  subscription routes + webhook handler; re-export in `src/routes/billing.ts`.
- Wired into `lib/credits.ts` (tier-derived limit) and `user.routes.ts`
  (profile usage), mounted in `app.ts` (raw webhook before `express.json`).
- Schema (`apps/api/schema.sql`) + migration
  (`supabase/migrations/20260629000001_billing_stripe.sql`).

**Frontend**
- `@mike/api-client`: `getSubscription`, `createCheckoutSession`,
  `createBillingPortalSession` + types.
- `apps/web/.../account/billing/page.tsx` — plan, usage bar, reset date,
  upgrade / manage buttons, and a graceful "billing disabled" state. New
  **Billing** tab in the account layout.

**Docs**
- ADR `0002`, operator/user guide `docs/billing.md`, `.env.example` block, and
  notes in `docs/api.md` / `docs/architecture.md`.

## Testing

New Vitest suites (33 tests) under `apps/api/src/lib/billing/__tests__/`:

- **plans.test.ts** — plan → credit-limit resolution, billing-disabled fallback,
  tier ↔ price-id mapping, env overrides.
- **stripe.test.ts** — tier mapping from a Stripe subscription (active /
  trialing / canceled / unknown price), snapshot projection.
- **webhook.test.ts** — signature verification (valid / missing header /
  tampered / unconfigured secret), idempotency (duplicate event skipped),
  `invoice.paid` credit reset, subscription upgrade/downgrade, checkout
  completion, unknown-event no-op. Stripe is mocked via a test seam; no network.

Commands run (all green):

- `npx tsc -p apps/api/tsconfig.json --noEmit` — clean.
- `npm run build --workspace apps/api` — clean.
- `npm test --workspace apps/api` — **184 passed, 1 skipped** (skip is the
  Supabase integration test that needs a live DB; pre-existing).
- `npm run typecheck --workspace packages/api-client` and `tsc --noEmit` in
  `apps/web` — clean.
- `npm run lint --workspace apps/api` — 0 errors (only pre-existing style
  warnings; the one new `detect-object-injection` warning is a known
  false-positive matching existing code that reads `process.env`).

## How to try it locally (Stripe test mode)

1. Create two test-mode Products + recurring monthly Prices in Stripe; copy the
   `price_…` IDs.
2. Set `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_PRICE_PRO=…`,
   `STRIPE_PRICE_ENTERPRISE=…`.
3. Forward webhooks and grab the signing secret:
   ```bash
   stripe listen --forward-to localhost:3001/billing/webhook
   # copy the printed whsec_… into STRIPE_WEBHOOK_SECRET, restart the API
   ```
4. Open **Settings → Billing**, click **Choose Pro**, complete Stripe Checkout
   with card `4242 4242 4242 4242`.
5. Watch the webhook upgrade your tier; the usage bar now reflects the Pro
   limit. Use **Manage subscription** to open the Customer Portal.
6. Trigger events directly if you prefer: `stripe trigger invoice.paid`.

Full guide: [`docs/billing.md`](docs/billing.md).

## Future work

- Usage-based **metered billing** (per-token), reported to Stripe.
- **Seat / organisation** billing (needs a schema change away from 1:1).
- In-app **proration** previews on plan change.
- **Dunning** emails for failed payments via the existing Resend integration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
