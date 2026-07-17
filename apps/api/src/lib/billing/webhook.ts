import type Stripe from "stripe";
import { logger } from "../logger";
import { getAdminClient, type MikeSupabaseClient } from "../supabase";
import { getStripe } from "./stripe";
import { findUserIdForCustomer, snapshotFromSubscription } from "./stripe";

// ---------------------------------------------------------------------------
// Stripe webhook handling.
//
// WHY WEBHOOKS AT ALL: Checkout happens on Stripe's domain, not ours. When a
// user finishes paying we are not in the request path, so Stripe POSTs us an
// event ("the payment succeeded", "the subscription changed") out-of-band. The
// webhook is how the source of truth (Stripe) tells our database what to do.
// We sync state in response to events rather than polling Stripe on a timer.
//
// WHY SIGNATURE VERIFICATION + RAW BODY: the webhook URL is public, so anyone
// could POST a fake "you are now Enterprise" event. Stripe signs each request
// with an HMAC over the EXACT bytes it sent, using `STRIPE_WEBHOOK_SECRET`.
// We recompute that HMAC and reject anything that doesn't match. The HMAC is
// over the raw bytes, so the body must NOT be JSON-parsed-then-re-serialised
// first (key order / whitespace would change and break the signature) — the
// route mounts `express.raw` for this path. See `app.ts`.
//
// WHY IDEMPOTENCY: Stripe guarantees *at-least-once* delivery and will retry on
// timeouts, so the same event can arrive twice. Payment side effects must be
// safe to replay. We record every processed event id in `billing_events` and
// skip anything we've already seen, so a duplicate "invoice.paid" can't, say,
// reset credits a second time mid-cycle.
// ---------------------------------------------------------------------------

/**
 * Verify a raw webhook payload against the Stripe signature header and return
 * the typed event. Throws if the signature is invalid or the webhook secret is
 * not configured — the route turns that into a 400 so Stripe will retry.
 */
export function constructWebhookEvent(
    rawBody: Buffer | string,
    signature: string | undefined,
): Stripe.Event {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
        throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
    }
    if (!signature) {
        throw new Error("Missing Stripe-Signature header");
    }
    // `constructEvent` performs the HMAC comparison and timestamp tolerance
    // check; it throws `Stripe.errors.StripeSignatureVerificationError` on any
    // mismatch.
    return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Claim an event id for processing. Returns `true` if this is the first time we
 * have seen it (caller should proceed), or `false` if it was already processed
 * (caller should no-op). Implemented as an insert into a table with the event
 * id as primary key: a duplicate insert fails the unique constraint, which is
 * our idempotency signal. Any other ledger failure is fatal: processing a
 * payment event without idempotency can apply billing side effects twice.
 */
async function claimEvent(
    event: Stripe.Event,
    db: MikeSupabaseClient,
): Promise<boolean> {
    const { error } = await db.from("billing_events").insert({
        event_id: event.id,
        type: event.type,
    });
    if (!error) return true;

    // 23505 = unique_violation -> we have processed this event already.
    if ((error as { code?: string }).code === "23505") return false;

    throw new Error(
        `Unable to claim Stripe event ${event.id}: ${error.message ?? "unknown database error"}`,
    );
}

async function releaseEventClaim(
    eventId: string,
    db: MikeSupabaseClient,
): Promise<void> {
    const { error } = await db
        .from("billing_events")
        .delete()
        .eq("event_id", eventId);
    if (error) {
        logger.error(
            { eventId, error: error.message },
            "[billing] failed to release unsuccessful event claim",
        );
    }
}

/** Apply a subscription's current state to a user's profile. */
async function applySubscription(
    userId: string,
    sub: Stripe.Subscription,
    db: MikeSupabaseClient,
): Promise<void> {
    const snapshot = snapshotFromSubscription(sub);
    const { error } = await db
        .from("user_profiles")
        .update({
            tier: snapshot.tier,
            subscription_status: snapshot.subscription_status,
            stripe_subscription_id: snapshot.stripe_subscription_id,
            subscription_current_period_end:
                snapshot.subscription_current_period_end,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (error) throw new Error(`Failed to sync subscription: ${error.message}`);
    logger.info(
        { userId, tier: snapshot.tier, status: snapshot.subscription_status },
        "[billing] subscription synced",
    );
}

/** Resolve the user id from an event that carries a Stripe customer id. */
async function userIdForCustomer(
    customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
    db: MikeSupabaseClient,
): Promise<string | null> {
    const customerId =
        typeof customer === "string" ? customer : (customer?.id ?? null);
    if (!customerId) return null;
    return findUserIdForCustomer(customerId, db);
}

/**
 * Handle a verified Stripe event. Pure-ish branching logic over the event
 * payload — all Stripe network access is via the injected/derived clients, so
 * this is straightforward to unit test. Unhandled event types are ignored
 * (we acknowledge them with 200 so Stripe stops retrying).
 */
export async function handleStripeEvent(
    event: Stripe.Event,
    db: MikeSupabaseClient = getAdminClient(),
): Promise<void> {
    if (!(await claimEvent(event, db))) {
        logger.info({ eventId: event.id }, "[billing] duplicate event ignored");
        return;
    }

    try {
        switch (event.type) {
            case "checkout.session.completed": {
                // The user just finished paying. The session links the customer to
                // the subscription they bought; fetch it and apply the tier.
                const session = event.data.object as Stripe.Checkout.Session;
                const userId =
                    session.metadata?.userId ??
                    (await userIdForCustomer(session.customer, db));
                const subscriptionId =
                    typeof session.subscription === "string"
                        ? session.subscription
                        : (session.subscription?.id ?? null);
                if (userId && subscriptionId) {
                    const sub =
                        await getStripe().subscriptions.retrieve(
                            subscriptionId,
                        );
                    await applySubscription(userId, sub, db);
                }
                break;
            }

            case "customer.subscription.created":
            case "customer.subscription.updated":
            case "customer.subscription.deleted": {
                // The subscription changed (upgrade, downgrade, cancel, lapse).
                // `tierFromSubscription` returns Free for any non-live status, so a
                // deleted/canceled subscription automatically demotes the user.
                const sub = event.data.object as Stripe.Subscription;
                const userId = await userIdForCustomer(sub.customer, db);
                if (userId) await applySubscription(userId, sub, db);
                break;
            }

            case "invoice.paid": {
                // A renewal succeeded — the new billing period started, so reset
                // the user's monthly message credits. We integrate with the
                // existing credits columns rather than inventing new counters.
                const invoice = event.data.object as Stripe.Invoice;
                const userId = await userIdForCustomer(invoice.customer, db);
                if (userId) {
                    const periodEnd = invoice.period_end
                        ? new Date(invoice.period_end * 1000).toISOString()
                        : null;
                    const update: Record<string, unknown> = {
                        message_credits_used: 0,
                        updated_at: new Date().toISOString(),
                    };
                    if (periodEnd) update.credits_reset_date = periodEnd;
                    const { error } = await db
                        .from("user_profiles")
                        .update(update)
                        .eq("user_id", userId);
                    if (error)
                        throw new Error(
                            `Failed to reset credits: ${error.message}`,
                        );
                    logger.info(
                        { userId },
                        "[billing] credits reset on invoice.paid",
                    );
                }
                break;
            }

            default:
                logger.debug(
                    { type: event.type },
                    "[billing] unhandled event type ignored",
                );
        }
    } catch (error) {
        // The event id is inserted before side effects. If a side effect fails,
        // remove that claim so Stripe's retry is allowed to process it again.
        // Without this, one transient DB/provider error would permanently turn
        // every later delivery into a false "duplicate" success.
        await releaseEventClaim(event.id, db);
        throw error;
    }
}
