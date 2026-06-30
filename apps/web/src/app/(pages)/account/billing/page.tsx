"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ExternalLink, Check } from "lucide-react";
import {
    type BillingTier,
    type SubscriptionInfo,
    createBillingPortalSession,
    createCheckoutSession,
    getSubscription,
} from "@/app/lib/mikeApi";
import { AccountSection } from "../AccountSection";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function UsageBar({ used, limit }: { used: number; limit: number }) {
    const pct =
        limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    // Warm the bar as the user approaches their limit.
    const tone =
        pct >= 100
            ? "bg-red-500"
            : pct >= 80
              ? "bg-amber-500"
              : "bg-gray-900";
    return (
        <div className="space-y-1.5">
            <div
                className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
                role="progressbar"
                aria-valuenow={used}
                aria-valuemin={0}
                aria-valuemax={limit}
            >
                <div
                    className={`h-full rounded-full transition-all ${tone}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <p className="text-sm text-gray-500">
                {used.toLocaleString()} / {limit.toLocaleString()} messages used
                this period
            </p>
        </div>
    );
}

export default function BillingPage() {
    const [sub, setSub] = useState<SubscriptionInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            setSub(await getSubscription());
        } catch (err) {
            devLog("[account/billing] load failed", { err });
            setError("Could not load billing information.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const handleUpgrade = async (tier: BillingTier) => {
        setBusy(tier);
        setError(null);
        try {
            const { url } = await createCheckoutSession(tier);
            if (url) window.location.assign(url);
            else setError("Checkout is unavailable right now.");
        } catch (err) {
            devLog("[account/billing] checkout failed", { err });
            setError("Could not start checkout. Please try again.");
        } finally {
            setBusy(null);
        }
    };

    const handleManage = async () => {
        setBusy("portal");
        setError(null);
        try {
            const { url } = await createBillingPortalSession();
            if (url) window.location.assign(url);
            else setError("The billing portal is unavailable right now.");
        } catch (err) {
            devLog("[account/billing] portal failed", { err });
            setError("Could not open the billing portal. Please try again.");
        } finally {
            setBusy(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
        );
    }

    if (!sub) {
        return (
            <AccountSection className="p-4">
                <p className="text-sm text-red-600">
                    {error ?? "Billing information is unavailable."}
                </p>
            </AccountSection>
        );
    }

    const hasSubscription =
        sub.billingEnabled && sub.tier !== "Free" && sub.status;

    return (
        <div className="space-y-8">
            {error && (
                <p className="text-sm text-red-600" role="alert">
                    {error}
                </p>
            )}

            {/* Current plan + usage */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Current Plan
                </h2>
                <AccountSection className="p-4">
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-base font-medium text-gray-900">
                                    {sub.planDisplayName}
                                </p>
                                {sub.status && (
                                    <p className="text-sm text-gray-500 capitalize">
                                        {sub.status.replace(/_/g, " ")}
                                        {sub.currentPeriodEnd
                                            ? ` · renews ${formatDate(sub.currentPeriodEnd)}`
                                            : ""}
                                    </p>
                                )}
                            </div>
                            {sub.billingEnabled && hasSubscription && (
                                <button
                                    type="button"
                                    onClick={() => void handleManage()}
                                    disabled={busy !== null}
                                    className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-300"
                                >
                                    {busy === "portal" ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <ExternalLink className="h-4 w-4" />
                                    )}
                                    Manage subscription
                                </button>
                            )}
                        </div>

                        <UsageBar
                            used={sub.creditsUsed}
                            limit={sub.creditsLimit}
                        />

                        <p className="text-sm text-gray-500">
                            Credits reset on {formatDate(sub.creditsResetDate)}.
                        </p>
                    </div>
                </AccountSection>
            </section>

            {/* Self-hosted: billing disabled */}
            {!sub.billingEnabled && (
                <AccountSection className="p-4">
                    <p className="text-sm text-gray-600">
                        Billing is not enabled on this instance. You have a
                        generous message allowance and there is nothing to pay.
                        Operators can enable Stripe billing by following{" "}
                        <span className="font-medium">docs/billing.md</span>.
                    </p>
                </AccountSection>
            )}

            {/* Upgrade options (only when billing is enabled) */}
            {sub.billingEnabled && (
                <section className="space-y-3">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Plans
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-3">
                        {sub.availablePlans.map((plan) => {
                            const current = plan.tier === sub.tier;
                            return (
                                <AccountSection
                                    key={plan.tier}
                                    className="flex flex-col gap-3 p-4"
                                >
                                    <div className="space-y-1">
                                        <p className="text-base font-medium text-gray-900">
                                            {plan.displayName}
                                        </p>
                                        <p className="text-sm text-gray-500">
                                            {plan.monthlyMessageCredits.toLocaleString()}{" "}
                                            messages / month
                                        </p>
                                    </div>
                                    {current ? (
                                        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-900">
                                            <Check className="h-4 w-4" />
                                            Current plan
                                        </span>
                                    ) : plan.purchasable ? (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void handleUpgrade(plan.tier)
                                            }
                                            disabled={busy !== null}
                                            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {busy === plan.tier ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : null}
                                            Choose {plan.displayName}
                                        </button>
                                    ) : (
                                        <span className="text-sm text-gray-400">
                                            {plan.tier === "Free"
                                                ? "Default plan"
                                                : "Contact us"}
                                        </span>
                                    )}
                                </AccountSection>
                            );
                        })}
                    </div>
                </section>
            )}
        </div>
    );
}
