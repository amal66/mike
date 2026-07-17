# Billing & usage metering

Mike supports optional Stripe-backed subscription billing. Subscription tiers
map to monthly message-credit limits that drive the existing credits system
(`apps/api/src/lib/credits.ts`). The design rationale is in
[ADR 0002](./adr/0002-stripe-billing.md).

> **Self-hosting:** billing is **disabled** unless you set `STRIPE_SECRET_KEY`.
> When disabled, every user gets a generous default allowance and the billing
> routes are inert. You can ignore this entire document.

## Tiers

| Tier       | Default credits / month | Purchasable |
| ---------- | ----------------------- | ----------- |
| Free       | 50                      | No          |
| Pro        | 1,500                   | Yes         |
| Enterprise | 10,000                  | Yes         |

The catalogue lives in `apps/api/src/lib/billing/plans.ts`. When billing is
disabled, all tiers resolve to the self-host default (`MONTHLY_CREDIT_LIMIT`,
default 999,999).

## Environment variables

| Variable                   | Required for billing | Purpose                                                            |
| -------------------------- | -------------------- | ------------------------------------------------------------------ |
| `STRIPE_SECRET_KEY`        | Yes                  | Stripe API key. Its presence is what *enables* billing.            |
| `STRIPE_WEBHOOK_SECRET`    | Yes                  | Signing secret used to verify webhook payloads.                    |
| `STRIPE_PRICE_PRO`         | Yes (for Pro)        | Stripe Price ID for the Pro subscription.                          |
| `STRIPE_PRICE_ENTERPRISE`  | Yes (for Enterprise) | Stripe Price ID for the Enterprise subscription.                   |
| `MONTHLY_CREDIT_LIMIT`     | No                   | Self-host default limit when billing is disabled (default 999999). |
| `FREE_TIER_CREDITS`        | No                   | Override the Free tier allowance (default 50).                     |
| `PRO_TIER_CREDITS`         | No                   | Override the Pro tier allowance (default 1500).                    |
| `ENTERPRISE_TIER_CREDITS`  | No                   | Override the Enterprise tier allowance (default 10000).            |

All Stripe keys should be **test-mode** keys (`sk_test_…`) until you go live.

## Setting up products and prices in Stripe

1. In the [Stripe Dashboard](https://dashboard.stripe.com/test/products) create
   a **Product** for each paid tier (e.g. "Mike Pro", "Mike Enterprise").
2. Add a **recurring monthly Price** to each product.
3. Copy each Price's ID (`price_…`) into `STRIPE_PRICE_PRO` /
   `STRIPE_PRICE_ENTERPRISE`.
4. Copy your secret key (`sk_test_…`) into `STRIPE_SECRET_KEY`.
5. (Production) Configure the **Customer Portal** under
   Settings → Billing → Customer portal so users can self-serve plan changes,
   invoices, and cancellation.

## Running the webhook locally with the Stripe CLI

The webhook keeps Mike's database in sync with Stripe. To test it locally:

```bash
# 1. Log in once.
stripe login

# 2. Forward Stripe events to your local API. This prints a webhook signing
#    secret (whsec_…) — put it in STRIPE_WEBHOOK_SECRET and restart the API.
stripe listen --forward-to localhost:3001/billing/webhook

# 3. In another terminal, trigger test events:
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger invoice.paid
```

The endpoint verifies the signature against `STRIPE_WEBHOOK_SECRET` and rejects
anything unsigned or tampered with a `400`.

## How tiers map to credit limits

On each chat request, `checkMessageCredits()` reads the user's `tier` and calls
`creditLimitForTier(tier)`:

- **Billing enabled** → the per-tier allowance from `plans.ts`.
- **Billing disabled** → the self-host default for every tier.

Webhook events keep `tier` accurate:

- `checkout.session.completed` / `customer.subscription.*` → set the tier from
  the subscription's price (a non-active subscription maps to `Free`).
- `invoice.paid` → reset `message_credits_used` to 0 and advance
  `credits_reset_date` for the new billing period.

## API surface

| Method & path           | Auth | Description                                            |
| ----------------------- | ---- | ------------------------------------------------------ |
| `GET /billing/subscription` | Bearer | Current plan, status, usage vs. limit, reset date. |
| `POST /billing/checkout`    | Bearer | Start a Checkout Session for a tier; returns a URL. |
| `POST /billing/portal`      | Bearer | Open the Customer Portal; returns a URL.            |
| `POST /billing/webhook`     | Signature | Stripe event sink (raw body, signature-verified). |

Typed client helpers live in `@mike/api-client`: `getSubscription()`,
`createCheckoutSession(tier)`, `createBillingPortalSession()`.

## Disabling billing (self-hosters)

Leave `STRIPE_SECRET_KEY` unset (the default). Billing is off, the
account → Billing page shows a "not enabled" notice, and everyone keeps the
generous default allowance. Optionally tune `MONTHLY_CREDIT_LIMIT`.
