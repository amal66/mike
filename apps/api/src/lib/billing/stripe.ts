import Stripe from "stripe";
import { logger } from "../logger";
import { getAdminClient, type MikeSupabaseClient } from "../supabase";
import { isBillingEnabled, tierForPriceId, type Tier } from "./plans";

// ---------------------------------------------------------------------------
// Stripe integration helpers.
//
// This module owns the Stripe SDK instance, customer creation/linking, and the
// mapping from a Stripe subscription to one of Mike's tiers. The HTTP routes in
// `modules/billing` stay thin and delegate the Stripe-specific work here.
// ---------------------------------------------------------------------------

// Pin the Stripe API version. Stripe rolls its API forward continuously; if we
// did NOT pin, a server restart could silently start talking to a newer API
// whose response shapes differ, breaking us in production. Pinning means we
// upgrade deliberately, in a commit, with tests — never by surprise.
//
// This must match the version the installed `stripe` SDK's types were built
// against, otherwise TypeScript rejects the literal.
export const STRIPE_API_VERSION = "2026-06-24.dahlia";

let _stripe: Stripe | null = null;

/**
 * Lazily construct the Stripe client. Throws if billing is not configured —
 * callers must gate on {@link isBillingEnabled} first. We construct lazily (not
 * at import time) so the module can be imported in environments without a
 * Stripe key (self-hosters, unit tests) without blowing up.
 */
export function getStripe(): Stripe {
    if (!isBillingEnabled()) {
        throw new Error("Stripe is not configured (STRIPE_SECRET_KEY is unset)");
    }
    if (!_stripe) {
        _stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
            apiVersion: STRIPE_API_VERSION,
            // Identify our integration in Stripe's logs/dashboards.
            appInfo: { name: "Mike", url: "https://github.com/" },
        });
    }
    return _stripe;
}

/** Test-only seam: inject a fake Stripe instance. */
export function __setStripeForTests(fake: Stripe | null): void {
    _stripe = fake;
}

/**
 * Find an existing Stripe customer ID for a user, or create one and persist it.
 *
 * We store `stripe_customer_id` on `user_profiles` so a user has exactly one
 * Stripe customer for the lifetime of their account. The Supabase user id is
 * written into the customer's `metadata.userId`, which lets the webhook map a
 * Stripe event back to a Mike user even if our DB write below was interrupted.
 */
export async function getOrCreateCustomer(
    userId: string,
    email: string | undefined,
    db: MikeSupabaseClient = getAdminClient(),
): Promise<string> {
    const { data } = await db
        .from("user_profiles")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();

    const existing = (data as { stripe_customer_id?: string | null } | null)
        ?.stripe_customer_id;
    if (existing) return existing;

    const stripe = getStripe();
    const customer = await stripe.customers.create({
        email,
        metadata: { userId },
    });

    await db
        .from("user_profiles")
        .update({
            stripe_customer_id: customer.id,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

    return customer.id;
}

/**
 * Derive the tier a subscription puts a user on from its line items.
 *
 * A Stripe subscription can in principle carry several prices; Mike's plans are
 * single-price, so we take the first item's price and map it to a tier. An
 * incomplete, past-due, or canceled subscription confers no paid tier, so it
 * maps to Free — we only grant a paid tier for a subscription Stripe considers
 * good standing (`active` or `trialing`).
 */
export function tierFromSubscription(sub: Stripe.Subscription): Tier {
    const isLive = sub.status === "active" || sub.status === "trialing";
    if (!isLive) return "Free";
    const priceId = sub.items?.data?.[0]?.price?.id ?? null;
    return tierForPriceId(priceId);
}

/** Subscription fields we persist on `user_profiles`. */
export interface SubscriptionSnapshot {
    tier: Tier;
    subscription_status: string;
    stripe_subscription_id: string;
    subscription_current_period_end: string | null;
}

/** Project a Stripe subscription into the columns we store. */
export function snapshotFromSubscription(
    sub: Stripe.Subscription,
): SubscriptionSnapshot {
    // `current_period_end` is a Unix timestamp (seconds). In newer API versions
    // it lives on the subscription item; fall back across both for safety.
    const periodEnd =
        (sub as { current_period_end?: number }).current_period_end ??
        sub.items?.data?.[0]?.current_period_end ??
        null;
    return {
        tier: tierFromSubscription(sub),
        subscription_status: sub.status,
        stripe_subscription_id: sub.id,
        subscription_current_period_end: periodEnd
            ? new Date(periodEnd * 1000).toISOString()
            : null,
    };
}

/**
 * Locate the Mike user a Stripe customer belongs to. We first try our own
 * `user_profiles.stripe_customer_id` mapping; if that misses (e.g. the linking
 * write was lost), we fall back to the `metadata.userId` we stamped on the
 * Stripe customer at creation time.
 */
export async function findUserIdForCustomer(
    customerId: string,
    db: MikeSupabaseClient = getAdminClient(),
): Promise<string | null> {
    const { data } = await db
        .from("user_profiles")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
    const userId = (data as { user_id?: string } | null)?.user_id;
    if (userId) return userId;

    try {
        const customer = await getStripe().customers.retrieve(customerId);
        if (!customer.deleted && customer.metadata?.userId) {
            return customer.metadata.userId;
        }
    } catch (err) {
        logger.warn(
            { customerId, err: err instanceof Error ? err.message : err },
            "[billing] customer lookup fallback failed",
        );
    }
    return null;
}
