import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";
import { snapshotFromSubscription, tierFromSubscription } from "../stripe";

// tierFromSubscription -> tierForPriceId reads process.env at call time.
let savedPro: string | undefined;
let savedEnt: string | undefined;

beforeEach(() => {
    savedPro = process.env.STRIPE_PRICE_PRO;
    savedEnt = process.env.STRIPE_PRICE_ENTERPRISE;
    process.env.STRIPE_PRICE_PRO = "price_pro_abc";
    process.env.STRIPE_PRICE_ENTERPRISE = "price_ent_xyz";
});

afterEach(() => {
    if (savedPro === undefined) delete process.env.STRIPE_PRICE_PRO;
    else process.env.STRIPE_PRICE_PRO = savedPro;
    if (savedEnt === undefined) delete process.env.STRIPE_PRICE_ENTERPRISE;
    else process.env.STRIPE_PRICE_ENTERPRISE = savedEnt;
});

// Minimal subscription factory — only the fields the mappers read.
function sub(opts: {
    status: string;
    priceId?: string;
    periodEnd?: number;
    id?: string;
}): Stripe.Subscription {
    return {
        id: opts.id ?? "sub_123",
        status: opts.status,
        current_period_end: opts.periodEnd,
        items: {
            data: [
                {
                    price: { id: opts.priceId },
                    current_period_end: opts.periodEnd,
                },
            ],
        },
    } as unknown as Stripe.Subscription;
}

describe("tierFromSubscription", () => {
    it("maps an active Pro-price subscription to the Pro tier", () => {
        expect(tierFromSubscription(sub({ status: "active", priceId: "price_pro_abc" }))).toBe(
            "Pro",
        );
    });

    it("maps an active Enterprise-price subscription to Enterprise", () => {
        expect(
            tierFromSubscription(sub({ status: "active", priceId: "price_ent_xyz" })),
        ).toBe("Enterprise");
    });

    it("treats trialing as a live, paid tier", () => {
        expect(
            tierFromSubscription(sub({ status: "trialing", priceId: "price_pro_abc" })),
        ).toBe("Pro");
    });

    it("demotes non-live statuses to Free", () => {
        for (const status of ["canceled", "past_due", "unpaid", "incomplete"]) {
            expect(
                tierFromSubscription(sub({ status, priceId: "price_pro_abc" })),
            ).toBe("Free");
        }
    });

    it("falls back to Free for an unrecognised price", () => {
        expect(
            tierFromSubscription(sub({ status: "active", priceId: "price_other" })),
        ).toBe("Free");
    });
});

describe("snapshotFromSubscription", () => {
    it("projects the persisted columns from a subscription", () => {
        const periodEnd = 1_900_000_000; // seconds
        const snapshot = snapshotFromSubscription(
            sub({
                id: "sub_abc",
                status: "active",
                priceId: "price_pro_abc",
                periodEnd,
            }),
        );
        expect(snapshot).toEqual({
            tier: "Pro",
            subscription_status: "active",
            stripe_subscription_id: "sub_abc",
            subscription_current_period_end: new Date(
                periodEnd * 1000,
            ).toISOString(),
        });
    });

    it("tolerates a missing current_period_end", () => {
        const snapshot = snapshotFromSubscription(
            sub({ status: "active", priceId: "price_pro_abc" }),
        );
        expect(snapshot.subscription_current_period_end).toBeNull();
    });
});
