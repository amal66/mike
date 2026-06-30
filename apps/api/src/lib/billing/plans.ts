// ---------------------------------------------------------------------------
// Billing plans — the single source of truth for subscription tiers.
//
// This module maps each subscription *tier* to:
//   1. a human-readable display name,
//   2. a Stripe Price ID (read from the environment — never hard-coded), and
//   3. a monthly message-credit limit.
//
// The credit limit defined here drives the EXISTING credits system in
// `../credits.ts`. We deliberately do not invent a second metering mechanism:
// PR #157 already added `message_credits_used` / `credits_reset_date` columns
// and per-request enforcement. Billing simply decides *what the limit is* for a
// given user based on the tier their Stripe subscription has put them on.
//
// SELF-HOSTING IS FIRST-CLASS. If Stripe is not configured (no
// `STRIPE_SECRET_KEY`), billing is "disabled": there is nothing to upgrade to,
// every user stays on a generous default limit, and none of the billing routes
// do anything destructive. A self-hoster who never touches Stripe gets exactly
// the behaviour they had before this feature shipped.
//
// SECURITY NOTE: the browser may tell us which *tier* a user wants to buy, but
// it must NEVER tell us the price. We resolve tier -> Stripe Price ID here, on
// the server, so a tampered client cannot check out at an attacker-chosen
// price. See `priceIdForTier()` and the `/billing/checkout` route.
// ---------------------------------------------------------------------------

/**
 * The set of subscription tiers Mike understands. These string values are
 * stored verbatim in `user_profiles.tier` (which defaults to 'Free'), so they
 * are intentionally capitalised to match the existing column convention.
 */
export const TIERS = ["Free", "Pro", "Enterprise"] as const;
export type Tier = (typeof TIERS)[number];

export interface Plan {
    /** Stable tier identifier, also stored in `user_profiles.tier`. */
    tier: Tier;
    /** Label shown in the billing UI. */
    displayName: string;
    /**
     * Stripe Price ID for this tier's recurring subscription, or `null` for a
     * tier that has no Stripe price (the Free tier, and any tier whose price ID
     * env var is unset). Resolved from the environment at call time.
     */
    priceId: string | null;
    /** Monthly message-credit allowance for users on this tier. */
    monthlyMessageCredits: number;
}

/**
 * Default monthly limit used when billing is DISABLED (no Stripe configured).
 * Platform operators can override it with `MONTHLY_CREDIT_LIMIT`; self-hosters
 * who don't run a metered platform inherit a very high value so the limit is
 * effectively "unlimited". This matches the historical behaviour of the
 * `MONTHLY_CREDIT_LIMIT` constant from PR #157.
 */
export const SELF_HOST_CREDIT_LIMIT = process.env.MONTHLY_CREDIT_LIMIT
    ? Number(process.env.MONTHLY_CREDIT_LIMIT)
    : 999_999;

// Per-tier monthly credit allowances used when billing IS enabled. These are
// the platform defaults; an operator can override any of them via env without a
// code change (e.g. FREE_TIER_CREDITS=100).
function tierCredits(envVar: string, fallback: number): number {
    const raw = process.env[envVar];
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build the plan catalogue from the current environment.
 *
 * We read `process.env` on each call (rather than memoising at import time) so
 * that unit tests can flip configuration on and off, and so that price IDs are
 * always consistent with the running environment. The work is trivial.
 */
export function getPlans(): Record<Tier, Plan> {
    return {
        Free: {
            tier: "Free",
            displayName: "Free",
            // The Free tier is never purchased through Checkout, so it has no
            // price ID even when Stripe is configured.
            priceId: null,
            monthlyMessageCredits: tierCredits("FREE_TIER_CREDITS", 50),
        },
        Pro: {
            tier: "Pro",
            displayName: "Pro",
            priceId: process.env.STRIPE_PRICE_PRO ?? null,
            monthlyMessageCredits: tierCredits("PRO_TIER_CREDITS", 1_500),
        },
        Enterprise: {
            tier: "Enterprise",
            displayName: "Enterprise",
            priceId: process.env.STRIPE_PRICE_ENTERPRISE ?? null,
            monthlyMessageCredits: tierCredits(
                "ENTERPRISE_TIER_CREDITS",
                10_000,
            ),
        },
    };
}

/**
 * Billing is enabled only when a Stripe secret key is present. Everything in
 * the billing surface keys off this single predicate so that "Stripe absent"
 * degrades cleanly to "billing disabled" everywhere.
 */
export function isBillingEnabled(): boolean {
    return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Narrow an arbitrary string to a known {@link Tier}, defaulting to `Free`. */
export function normalizeTier(value: string | null | undefined): Tier {
    return TIERS.includes(value as Tier) ? (value as Tier) : "Free";
}

/** The {@link Plan} for a tier (defaults to the Free plan for unknown input). */
export function getPlan(tier: string | null | undefined): Plan {
    return getPlans()[normalizeTier(tier)];
}

/**
 * Resolve the monthly message-credit limit for a user on `tier`.
 *
 * - Billing DISABLED  -> the generous self-host default (unchanged behaviour).
 * - Billing ENABLED   -> the per-tier allowance from the plan catalogue.
 *
 * This is the function the credits system calls; it is what makes a Stripe
 * subscription actually change how many messages a user can send.
 */
export function creditLimitForTier(tier: string | null | undefined): number {
    if (!isBillingEnabled()) return SELF_HOST_CREDIT_LIMIT;
    return getPlan(tier).monthlyMessageCredits;
}

/**
 * Resolve a tier to its Stripe Price ID for Checkout. Returns `null` for the
 * Free tier or any tier whose price env var is unset. This is the *only*
 * place a tier becomes a price — the client never supplies a price.
 */
export function priceIdForTier(tier: Tier): string | null {
    return getPlan(tier).priceId;
}

/**
 * Reverse lookup used by the webhook: given a Stripe Price ID from a
 * subscription's line item, find which tier it corresponds to. Returns `Free`
 * when no configured price matches (e.g. a subscription was cancelled, or the
 * price was created outside this deployment's configuration).
 */
export function tierForPriceId(priceId: string | null | undefined): Tier {
    if (!priceId) return "Free";
    for (const plan of Object.values(getPlans())) {
        if (plan.priceId && plan.priceId === priceId) {
            return plan.tier;
        }
    }
    return "Free";
}
