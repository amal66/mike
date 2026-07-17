import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { logger } from "../../lib/logger";
import { sendError, parseBody } from "../../lib/http";
import { safeErrorMessage } from "../../lib/safeError";
import {
    TIERS,
    type Tier,
    getPlan,
    getPlans,
    isBillingEnabled,
    priceIdForTier,
} from "../../lib/billing/plans";
import {
    getOrCreateCustomer,
    getStripe,
    STRIPE_API_VERSION,
} from "../../lib/billing/stripe";
import { constructWebhookEvent, handleStripeEvent } from "../../lib/billing/webhook";

export const billingRouter = Router();

function frontendBillingUrl(path = "/account/billing"): string {
    const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
        /\/+$/,
        "",
    );
    return `${base}${path}`;
}

// The client may name a tier, but never a price. We accept only tiers that are
// actually purchasable (have a configured Stripe price) — the price itself is
// resolved server-side in `priceIdForTier`.
const checkoutSchema = z.object({
    tier: z.enum(TIERS),
});

// POST /billing/checkout — start a Stripe Checkout Session for a chosen tier.
billingRouter.post("/checkout", requireAuth, async (req: Request, res: Response) => {
    if (!isBillingEnabled()) {
        return void sendError(
            res,
            503,
            "BILLING_DISABLED",
            "Billing is not enabled on this instance.",
        );
    }

    const body = parseBody(checkoutSchema, req, res);
    if (!body) return;

    const tier = body.tier as Tier;
    const priceId = priceIdForTier(tier);
    if (!priceId) {
        return void sendError(
            res,
            400,
            "BAD_REQUEST",
            `Tier "${tier}" is not available for purchase on this instance.`,
        );
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    try {
        const customerId = await getOrCreateCustomer(userId, userEmail, db);
        const session = await getStripe().checkout.sessions.create({
            mode: "subscription",
            customer: customerId,
            line_items: [{ price: priceId, quantity: 1 }],
            // Stamp the Mike user id so the webhook can resolve the user even
            // before our customer-id mapping has been persisted.
            metadata: { userId, tier },
            subscription_data: { metadata: { userId } },
            success_url: `${frontendBillingUrl()}?checkout=success`,
            cancel_url: `${frontendBillingUrl()}?checkout=cancelled`,
            allow_promotion_codes: true,
        });
        res.json({ url: session.url });
    } catch (err) {
        logger.error(
            { userId, err: safeErrorMessage(err) },
            "[billing] checkout session creation failed",
        );
        sendError(res, 502, "BILLING_ERROR", "Could not start checkout.");
    }
});

// POST /billing/portal — open the Stripe Customer Portal for self-serve
// management (change plan, view invoices, cancel).
billingRouter.post("/portal", requireAuth, async (_req: Request, res: Response) => {
    if (!isBillingEnabled()) {
        return void sendError(
            res,
            503,
            "BILLING_DISABLED",
            "Billing is not enabled on this instance.",
        );
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    try {
        const customerId = await getOrCreateCustomer(userId, userEmail, db);
        const session = await getStripe().billingPortal.sessions.create({
            customer: customerId,
            return_url: frontendBillingUrl(),
        });
        res.json({ url: session.url });
    } catch (err) {
        logger.error(
            { userId, err: safeErrorMessage(err) },
            "[billing] portal session creation failed",
        );
        sendError(res, 502, "BILLING_ERROR", "Could not open billing portal.");
    }
});

// GET /billing/subscription — current plan, status, and usage against limit.
billingRouter.get("/subscription", requireAuth, async (_req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();

    const { data, error } = await db
        .from("user_profiles")
        .select(
            "tier, message_credits_used, credits_reset_date, subscription_status, subscription_current_period_end",
        )
        .eq("user_id", userId)
        .maybeSingle();

    // Tolerate older databases that predate the billing columns (42703 =
    // undefined_column): fall back to a tier-only read so the page still works.
    let row = data as
        | {
              tier?: string | null;
              message_credits_used?: number | null;
              credits_reset_date?: string | null;
              subscription_status?: string | null;
              subscription_current_period_end?: string | null;
          }
        | null;
    if (error && (error as { code?: string }).code === "42703") {
        const legacy = await db
            .from("user_profiles")
            .select("tier, message_credits_used, credits_reset_date")
            .eq("user_id", userId)
            .maybeSingle();
        row = legacy.data as typeof row;
    } else if (error) {
        return void sendError(res, 500, "INTERNAL_ERROR", error.message);
    }

    const plan = getPlan(row?.tier);
    const allPlans = getPlans();

    res.json({
        billingEnabled: isBillingEnabled(),
        tier: plan.tier,
        planDisplayName: plan.displayName,
        status: row?.subscription_status ?? null,
        currentPeriodEnd: row?.subscription_current_period_end ?? null,
        creditsUsed: row?.message_credits_used ?? 0,
        creditsLimit: plan.monthlyMessageCredits,
        creditsResetDate: row?.credits_reset_date ?? null,
        // Surface the catalogue so the UI can render upgrade options without
        // hard-coding tiers. Only tiers with a configured price are purchasable.
        availablePlans: Object.values(allPlans).map((p) => ({
            tier: p.tier,
            displayName: p.displayName,
            monthlyMessageCredits: p.monthlyMessageCredits,
            purchasable: Boolean(p.priceId),
        })),
    });
});

/**
 * Express handler for `POST /billing/webhook`.
 *
 * This is mounted SEPARATELY in `app.ts` with `express.raw` *before* the global
 * `express.json` parser, because Stripe signature verification must run over
 * the exact raw bytes Stripe sent (see `lib/billing/webhook.ts`). `req.body`
 * here is a Buffer, not parsed JSON.
 *
 * We always verify the signature first and return 400 on failure (Stripe will
 * retry). On success we acknowledge with 200 quickly; the actual state sync is
 * idempotent and guarded against duplicate deliveries.
 */
export async function billingWebhookHandler(
    req: Request,
    res: Response,
): Promise<void> {
    if (!isBillingEnabled()) {
        return void sendError(
            res,
            503,
            "BILLING_DISABLED",
            "Billing is not enabled on this instance.",
        );
    }

    const signature = req.headers["stripe-signature"];
    let event;
    try {
        event = constructWebhookEvent(
            req.body as Buffer,
            typeof signature === "string" ? signature : undefined,
        );
    } catch (err) {
        // Do NOT leak verification details; log safely, reject the payload.
        logger.warn(
            { err: safeErrorMessage(err) },
            "[billing] webhook signature verification failed",
        );
        return void sendError(
            res,
            400,
            "BAD_REQUEST",
            "Webhook signature verification failed.",
        );
    }

    try {
        await handleStripeEvent(event);
        res.json({ received: true });
    } catch (err) {
        logger.error(
            { type: event.type, err: safeErrorMessage(err) },
            "[billing] webhook handler error",
        );
        // 500 tells Stripe to retry later; the handler is idempotent so a retry
        // is safe.
        sendError(res, 500, "INTERNAL_ERROR", "Webhook processing failed.");
    }
}

// Re-export so `app.ts` can advertise the pinned version in logs if desired.
export { STRIPE_API_VERSION };
