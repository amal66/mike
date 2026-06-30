import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    creditLimitForTier,
    getPlan,
    getPlans,
    isBillingEnabled,
    normalizeTier,
    priceIdForTier,
    tierForPriceId,
    SELF_HOST_CREDIT_LIMIT,
} from "../plans";

// The plan catalogue reads process.env at call time, so each test sets exactly
// the env it needs and restores the original afterwards.
const ENV_KEYS = [
    "STRIPE_SECRET_KEY",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_ENTERPRISE",
    "FREE_TIER_CREDITS",
    "PRO_TIER_CREDITS",
    "ENTERPRISE_TIER_CREDITS",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

describe("normalizeTier", () => {
    it("passes through known tiers", () => {
        expect(normalizeTier("Pro")).toBe("Pro");
        expect(normalizeTier("Enterprise")).toBe("Enterprise");
        expect(normalizeTier("Free")).toBe("Free");
    });

    it("defaults unknown / empty values to Free", () => {
        expect(normalizeTier("platinum")).toBe("Free");
        expect(normalizeTier(null)).toBe("Free");
        expect(normalizeTier(undefined)).toBe("Free");
    });
});

describe("isBillingEnabled", () => {
    it("is false when STRIPE_SECRET_KEY is unset (self-host default)", () => {
        expect(isBillingEnabled()).toBe(false);
    });

    it("is true once STRIPE_SECRET_KEY is set", () => {
        process.env.STRIPE_SECRET_KEY = "sk_test_123";
        expect(isBillingEnabled()).toBe(true);
    });
});

describe("creditLimitForTier — billing disabled", () => {
    it("returns the generous self-host default for every tier", () => {
        // No STRIPE_SECRET_KEY -> billing disabled -> tier is irrelevant.
        expect(creditLimitForTier("Free")).toBe(SELF_HOST_CREDIT_LIMIT);
        expect(creditLimitForTier("Pro")).toBe(SELF_HOST_CREDIT_LIMIT);
        expect(creditLimitForTier("Enterprise")).toBe(SELF_HOST_CREDIT_LIMIT);
        expect(creditLimitForTier("anything")).toBe(SELF_HOST_CREDIT_LIMIT);
    });
});

describe("creditLimitForTier — billing enabled", () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = "sk_test_123";
    });

    it("uses per-tier allowances from the catalogue", () => {
        expect(creditLimitForTier("Free")).toBe(50);
        expect(creditLimitForTier("Pro")).toBe(1_500);
        expect(creditLimitForTier("Enterprise")).toBe(10_000);
    });

    it("maps unknown tiers to the Free allowance", () => {
        expect(creditLimitForTier("mystery")).toBe(50);
    });

    it("honours per-tier credit overrides from the environment", () => {
        process.env.PRO_TIER_CREDITS = "2222";
        expect(creditLimitForTier("Pro")).toBe(2222);
    });
});

describe("priceIdForTier", () => {
    it("returns null for Free even when Stripe is configured", () => {
        process.env.STRIPE_SECRET_KEY = "sk_test_123";
        expect(priceIdForTier("Free")).toBeNull();
    });

    it("returns the configured price id for a paid tier", () => {
        process.env.STRIPE_PRICE_PRO = "price_pro_abc";
        expect(priceIdForTier("Pro")).toBe("price_pro_abc");
    });

    it("returns null for a paid tier with no configured price", () => {
        expect(priceIdForTier("Enterprise")).toBeNull();
    });
});

describe("tierForPriceId — reverse lookup used by the webhook", () => {
    beforeEach(() => {
        process.env.STRIPE_PRICE_PRO = "price_pro_abc";
        process.env.STRIPE_PRICE_ENTERPRISE = "price_ent_xyz";
    });

    it("maps a known price id back to its tier", () => {
        expect(tierForPriceId("price_pro_abc")).toBe("Pro");
        expect(tierForPriceId("price_ent_xyz")).toBe("Enterprise");
    });

    it("falls back to Free for unknown / null price ids", () => {
        expect(tierForPriceId("price_unknown")).toBe("Free");
        expect(tierForPriceId(null)).toBe("Free");
        expect(tierForPriceId(undefined)).toBe("Free");
    });
});

describe("getPlans / getPlan", () => {
    it("never marks Free as purchasable (no price id)", () => {
        process.env.STRIPE_SECRET_KEY = "sk_test_123";
        process.env.STRIPE_PRICE_PRO = "price_pro_abc";
        const plans = getPlans();
        expect(plans.Free.priceId).toBeNull();
        expect(plans.Pro.priceId).toBe("price_pro_abc");
    });

    it("getPlan defaults to the Free plan for unknown tiers", () => {
        expect(getPlan("nope").tier).toBe("Free");
    });
});
