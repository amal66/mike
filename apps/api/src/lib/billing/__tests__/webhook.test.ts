import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Stripe from "stripe";
import { constructWebhookEvent, handleStripeEvent } from "../webhook";
import { __setStripeForTests } from "../stripe";

// ---------------------------------------------------------------------------
// Mock Stripe + Supabase. No network calls are made.
// ---------------------------------------------------------------------------

interface MockTable {
    insertResult: { error: { code?: string } | null };
    selectResult: { data: unknown; error: { code?: string } | null };
    updates: Record<string, unknown>[];
    inserts: Record<string, unknown>[];
}

function makeDb(overrides: Partial<Record<string, Partial<MockTable>>> = {}) {
    const tables: Record<string, MockTable> = {};
    function tableFor(name: string): MockTable {
        if (!tables[name]) {
            tables[name] = {
                insertResult: { error: null },
                selectResult: { data: null, error: null },
                updates: [],
                inserts: [],
            };
            Object.assign(tables[name], overrides[name] ?? {});
        }
        return tables[name];
    }
    const db = {
        _tables: tables,
        from(name: string) {
            const t = tableFor(name);
            return {
                insert(row: Record<string, unknown>) {
                    t.inserts.push(row);
                    return Promise.resolve({ error: t.insertResult.error });
                },
                select() {
                    return {
                        eq() {
                            return {
                                maybeSingle: () =>
                                    Promise.resolve(t.selectResult),
                            };
                        },
                    };
                },
                update(row: Record<string, unknown>) {
                    t.updates.push(row);
                    return {
                        eq: () => Promise.resolve({ error: null }),
                    };
                },
            };
        },
    };
    return db as unknown as Parameters<typeof handleStripeEvent>[1] & {
        _tables: Record<string, MockTable>;
    };
}

const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
    }
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    __setStripeForTests(null);
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("constructWebhookEvent — signature verification", () => {
    it("returns the parsed event when the signature is valid", () => {
        const fakeEvent = { id: "evt_1", type: "invoice.paid" };
        const constructEvent = vi.fn().mockReturnValue(fakeEvent);
        __setStripeForTests({
            webhooks: { constructEvent },
        } as unknown as Stripe);

        const event = constructWebhookEvent(
            Buffer.from("{}"),
            "t=1,v1=abc",
        );

        expect(event).toBe(fakeEvent);
        expect(constructEvent).toHaveBeenCalledWith(
            expect.any(Buffer),
            "t=1,v1=abc",
            "whsec_test_123",
        );
    });

    it("throws when the signature header is missing", () => {
        __setStripeForTests({
            webhooks: { constructEvent: vi.fn() },
        } as unknown as Stripe);
        expect(() => constructWebhookEvent(Buffer.from("{}"), undefined)).toThrow(
            /Stripe-Signature/i,
        );
    });

    it("propagates Stripe's verification failure (tampered payload)", () => {
        const constructEvent = vi.fn().mockImplementation(() => {
            throw new Error("No signatures found matching the expected signature");
        });
        __setStripeForTests({
            webhooks: { constructEvent },
        } as unknown as Stripe);

        expect(() =>
            constructWebhookEvent(Buffer.from("{}"), "t=1,v1=bad"),
        ).toThrow(/signature/i);
    });

    it("throws when the webhook secret is not configured", () => {
        delete process.env.STRIPE_WEBHOOK_SECRET;
        __setStripeForTests({
            webhooks: { constructEvent: vi.fn() },
        } as unknown as Stripe);
        expect(() =>
            constructWebhookEvent(Buffer.from("{}"), "t=1,v1=abc"),
        ).toThrow(/STRIPE_WEBHOOK_SECRET/);
    });
});

// ---------------------------------------------------------------------------
// Handler branching + idempotency
// ---------------------------------------------------------------------------

describe("handleStripeEvent — idempotency", () => {
    it("skips processing when the event id was already recorded", async () => {
        const db = makeDb({
            billing_events: { insertResult: { error: { code: "23505" } } },
        });
        const event = {
            id: "evt_dup",
            type: "invoice.paid",
            data: { object: { customer: "cus_1", period_end: 1 } },
        } as unknown as Stripe.Event;

        await handleStripeEvent(event, db);

        // Duplicate -> no profile updates happened.
        expect(db._tables.user_profiles?.updates ?? []).toHaveLength(0);
    });

    it("records the event id before processing a fresh event", async () => {
        const db = makeDb({
            user_profiles: {
                selectResult: { data: { user_id: "user-1" }, error: null },
            },
        });
        const event = {
            id: "evt_new",
            type: "invoice.paid",
            data: { object: { customer: "cus_1", period_end: 1_900_000_000 } },
        } as unknown as Stripe.Event;

        await handleStripeEvent(event, db);

        expect(db._tables.billing_events.inserts[0]).toMatchObject({
            event_id: "evt_new",
            type: "invoice.paid",
        });
    });
});

describe("handleStripeEvent — invoice.paid resets credits", () => {
    it("zeroes message_credits_used and advances the reset date", async () => {
        const db = makeDb({
            user_profiles: {
                selectResult: { data: { user_id: "user-1" }, error: null },
            },
        });
        const periodEnd = 1_900_000_000;
        const event = {
            id: "evt_inv",
            type: "invoice.paid",
            data: { object: { customer: "cus_1", period_end: periodEnd } },
        } as unknown as Stripe.Event;

        await handleStripeEvent(event, db);

        const update = db._tables.user_profiles.updates[0];
        expect(update.message_credits_used).toBe(0);
        expect(update.credits_reset_date).toBe(
            new Date(periodEnd * 1000).toISOString(),
        );
    });
});

describe("handleStripeEvent — customer.subscription.updated", () => {
    beforeEach(() => {
        process.env.STRIPE_PRICE_PRO = "price_pro_abc";
    });
    afterEach(() => {
        delete process.env.STRIPE_PRICE_PRO;
    });

    it("syncs the resolved tier onto the user's profile", async () => {
        const db = makeDb({
            user_profiles: {
                selectResult: { data: { user_id: "user-7" }, error: null },
            },
        });
        const event = {
            id: "evt_sub",
            type: "customer.subscription.updated",
            data: {
                object: {
                    id: "sub_1",
                    status: "active",
                    customer: "cus_7",
                    current_period_end: 1_900_000_000,
                    items: { data: [{ price: { id: "price_pro_abc" } }] },
                },
            },
        } as unknown as Stripe.Event;

        await handleStripeEvent(event, db);

        const update = db._tables.user_profiles.updates[0];
        expect(update.tier).toBe("Pro");
        expect(update.subscription_status).toBe("active");
        expect(update.stripe_subscription_id).toBe("sub_1");
    });

    it("demotes to Free when the subscription is canceled", async () => {
        const db = makeDb({
            user_profiles: {
                selectResult: { data: { user_id: "user-7" }, error: null },
            },
        });
        const event = {
            id: "evt_sub_cancel",
            type: "customer.subscription.deleted",
            data: {
                object: {
                    id: "sub_1",
                    status: "canceled",
                    customer: "cus_7",
                    items: { data: [{ price: { id: "price_pro_abc" } }] },
                },
            },
        } as unknown as Stripe.Event;

        await handleStripeEvent(event, db);

        expect(db._tables.user_profiles.updates[0].tier).toBe("Free");
    });
});

describe("handleStripeEvent — checkout.session.completed", () => {
    beforeEach(() => {
        process.env.STRIPE_PRICE_PRO = "price_pro_abc";
    });
    afterEach(() => {
        delete process.env.STRIPE_PRICE_PRO;
    });

    it("retrieves the subscription and applies the tier", async () => {
        const retrieve = vi.fn().mockResolvedValue({
            id: "sub_99",
            status: "active",
            customer: "cus_9",
            current_period_end: 1_900_000_000,
            items: { data: [{ price: { id: "price_pro_abc" } }] },
        });
        __setStripeForTests({
            subscriptions: { retrieve },
        } as unknown as Stripe);

        const db = makeDb();
        const event = {
            id: "evt_checkout",
            type: "checkout.session.completed",
            data: {
                object: {
                    metadata: { userId: "user-42" },
                    customer: "cus_9",
                    subscription: "sub_99",
                },
            },
        } as unknown as Stripe.Event;

        await handleStripeEvent(event, db);

        expect(retrieve).toHaveBeenCalledWith("sub_99");
        expect(db._tables.user_profiles.updates[0].tier).toBe("Pro");
    });
});

describe("handleStripeEvent — unknown event types", () => {
    it("ignores unhandled events without touching the database", async () => {
        const db = makeDb();
        const event = {
            id: "evt_unknown",
            type: "payment_intent.succeeded",
            data: { object: {} },
        } as unknown as Stripe.Event;

        await expect(handleStripeEvent(event, db)).resolves.toBeUndefined();
        expect(db._tables.user_profiles?.updates ?? []).toHaveLength(0);
    });
});
