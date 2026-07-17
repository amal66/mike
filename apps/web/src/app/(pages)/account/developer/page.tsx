"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import {
    type ApiKey,
    type WebhookDelivery,
    type WebhookEndpoint,
    type WebhookEventType,
    createApiKey,
    createWebhookEndpoint,
    deleteWebhookEndpoint,
    listApiKeys,
    listWebhookDeliveries,
    listWebhookEndpoints,
    listWebhookEventTypes,
    revokeApiKey,
} from "@/app/lib/mikeApi";
import {
    accountGlassDangerButtonClassName,
    accountGlassInputClassName,
    accountGlassPrimaryButtonClassName,
} from "../accountStyles";
import { AccountSection } from "../AccountSection";

/**
 * Developer settings: mint programmatic API keys, register webhook endpoints,
 * and inspect recent deliveries. Mirrors the styling of the sibling account
 * pages (AccountSection + accountGlass* classes).
 */
export default function DeveloperPage() {
    return (
        <div className="space-y-8">
            <div>
                <h2 className="mb-3 text-2xl font-medium font-serif text-gray-900">
                    Developer
                </h2>
                <p className="text-sm text-gray-500">
                    Build on Mike programmatically. Create an API key to call the
                    REST API from scripts or CI, and register webhooks to receive
                    events. See the{" "}
                    <a
                        href={
                            (process.env.NEXT_PUBLIC_API_BASE_URL ??
                                "http://localhost:3001") + "/docs"
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="text-gray-700 underline hover:text-gray-950"
                    >
                        interactive API reference
                    </a>
                    .
                </p>
            </div>

            <ApiKeysSection />
            <WebhooksSection />
        </div>
    );
}

// ── A one-time secret reveal box (used for both keys and webhook secrets) ─────

function SecretReveal({
    label,
    secret,
    onDismiss,
}: {
    label: string;
    secret: string;
    onDismiss: () => void;
}) {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        await navigator.clipboard.writeText(secret);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="m-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-800">
                <AlertTriangle className="h-4 w-4" />
                {label} — copy it now. You won&apos;t be able to see it again.
            </div>
            <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-md border border-amber-200 bg-white px-3 py-2 font-mono text-sm text-gray-900">
                    {secret}
                </code>
                <button
                    type="button"
                    onClick={copy}
                    className={`flex items-center gap-1 px-3 py-2 text-xs font-medium ${accountGlassPrimaryButtonClassName}`}
                >
                    {copied ? (
                        <Check className="h-4 w-4" />
                    ) : (
                        <Copy className="h-4 w-4" />
                    )}
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <button
                type="button"
                onClick={onDismiss}
                className="mt-3 text-xs font-medium text-amber-800 underline hover:text-amber-900"
            >
                I&apos;ve stored it safely — dismiss
            </button>
        </div>
    );
}

// ── API keys ──────────────────────────────────────────────────────────────────

function ApiKeysSection() {
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState("");
    const [creating, setCreating] = useState(false);
    const [newSecret, setNewSecret] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setKeys(await listApiKeys());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const create = async () => {
        if (!name.trim()) return;
        setCreating(true);
        try {
            const created = await createApiKey({ name: name.trim() });
            setNewSecret(created.key);
            setName("");
            await refresh();
        } catch {
            alert("Failed to create API key.");
        } finally {
            setCreating(false);
        }
    };

    const revoke = async (id: string) => {
        if (!confirm("Revoke this API key? Any client using it will stop working."))
            return;
        try {
            await revokeApiKey(id);
            await refresh();
        } catch {
            alert("Failed to revoke key.");
        }
    };

    return (
        <div>
            <h3 className="mb-2 text-lg font-medium text-gray-900">API keys</h3>
            <p className="mb-3 text-sm text-gray-500">
                Use a key as a bearer token:{" "}
                <code className="font-mono text-xs">
                    Authorization: Bearer mike_sk_…
                </code>
            </p>
            <AccountSection>
                <div className="flex flex-wrap items-end gap-2 px-4 py-4">
                    <div className="min-w-0 flex-1">
                        <label className="mb-1 block text-sm font-medium text-gray-700">
                            New key name
                        </label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. CI pipeline"
                            className={accountGlassInputClassName}
                            spellCheck={false}
                        />
                    </div>
                    <button
                        type="button"
                        onClick={create}
                        disabled={creating || !name.trim()}
                        className={`flex items-center gap-1 px-3 py-2 text-sm font-medium ${accountGlassPrimaryButtonClassName}`}
                    >
                        {creating ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Plus className="h-4 w-4" />
                        )}
                        Create
                    </button>
                </div>

                {newSecret && (
                    <SecretReveal
                        label="Your new API key"
                        secret={newSecret}
                        onDismiss={() => setNewSecret(null)}
                    />
                )}

                <div className="border-t border-gray-200">
                    {loading ? (
                        <div className="flex items-center gap-2 px-4 py-5 text-sm text-gray-500">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                        </div>
                    ) : keys.length === 0 ? (
                        <p className="px-4 py-5 text-sm text-gray-500">
                            No API keys yet.
                        </p>
                    ) : (
                        keys.map((key) => (
                            <div
                                key={key.id}
                                className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3 last:border-b-0"
                            >
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-gray-900">
                                        {key.name}
                                    </div>
                                    <div className="font-mono text-xs text-gray-500">
                                        {key.key_prefix}…{" · "}
                                        {key.scopes.join(", ")}
                                        {" · "}
                                        {key.last_used_at
                                            ? `last used ${new Date(key.last_used_at).toLocaleDateString()}`
                                            : "never used"}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => revoke(key.id)}
                                    className={`flex items-center gap-1 px-2 py-1 text-xs font-medium ${accountGlassDangerButtonClassName}`}
                                >
                                    <Trash2 className="h-4 w-4" /> Revoke
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </AccountSection>
        </div>
    );
}

// ── Webhooks ────────────────────────────────────────────────────────────────

function WebhooksSection() {
    const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
    const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
    const [eventTypes, setEventTypes] = useState<WebhookEventType[]>([]);
    const [loading, setLoading] = useState(true);
    const [url, setUrl] = useState("");
    const [selected, setSelected] = useState<Set<WebhookEventType>>(new Set());
    const [creating, setCreating] = useState(false);
    const [newSecret, setNewSecret] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [eps, dels] = await Promise.all([
                listWebhookEndpoints(),
                listWebhookDeliveries({ limit: 20 }),
            ]);
            setEndpoints(eps);
            setDeliveries(dels);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void listWebhookEventTypes().then(setEventTypes).catch(() => {});
        void refresh();
    }, [refresh]);

    const toggleEvent = (event: WebhookEventType) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(event)) next.delete(event);
            else next.add(event);
            return next;
        });
    };

    const create = async () => {
        if (!url.trim() || selected.size === 0) return;
        setCreating(true);
        try {
            const created = await createWebhookEndpoint({
                url: url.trim(),
                event_types: [...selected],
            });
            setNewSecret(created.secret);
            setUrl("");
            setSelected(new Set());
            await refresh();
        } catch {
            alert("Failed to create endpoint. URLs must use HTTPS in production.");
        } finally {
            setCreating(false);
        }
    };

    const remove = async (id: string) => {
        if (!confirm("Delete this webhook endpoint?")) return;
        try {
            await deleteWebhookEndpoint(id);
            await refresh();
        } catch {
            alert("Failed to delete endpoint.");
        }
    };

    return (
        <div>
            <h3 className="mb-2 text-lg font-medium text-gray-900">Webhooks</h3>
            <p className="mb-3 text-sm text-gray-500">
                Receive a signed POST when events happen. Verify the{" "}
                <code className="font-mono text-xs">X-Mike-Signature</code> header
                with the secret shown once at creation.
            </p>
            <AccountSection>
                <div className="space-y-3 px-4 py-4">
                    <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">
                            Endpoint URL
                        </label>
                        <Input
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://example.com/webhooks/mike"
                            className={accountGlassInputClassName}
                            spellCheck={false}
                        />
                    </div>
                    <div className="flex flex-wrap gap-3">
                        {eventTypes.map((event) => (
                            <label
                                key={event}
                                className="flex items-center gap-2 text-sm text-gray-700"
                            >
                                <input
                                    type="checkbox"
                                    checked={selected.has(event)}
                                    onChange={() => toggleEvent(event)}
                                />
                                <code className="font-mono text-xs">{event}</code>
                            </label>
                        ))}
                    </div>
                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={create}
                            disabled={creating || !url.trim() || selected.size === 0}
                            className={`flex items-center gap-1 px-3 py-2 text-sm font-medium ${accountGlassPrimaryButtonClassName}`}
                        >
                            {creating ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Plus className="h-4 w-4" />
                            )}
                            Add endpoint
                        </button>
                    </div>
                </div>

                {newSecret && (
                    <SecretReveal
                        label="Webhook signing secret"
                        secret={newSecret}
                        onDismiss={() => setNewSecret(null)}
                    />
                )}

                <div className="border-t border-gray-200">
                    {loading ? (
                        <div className="flex items-center gap-2 px-4 py-5 text-sm text-gray-500">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                        </div>
                    ) : endpoints.length === 0 ? (
                        <p className="px-4 py-5 text-sm text-gray-500">
                            No webhook endpoints yet.
                        </p>
                    ) : (
                        endpoints.map((endpoint) => (
                            <div
                                key={endpoint.id}
                                className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3 last:border-b-0"
                            >
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-gray-900">
                                        {endpoint.url}
                                    </div>
                                    <div className="font-mono text-xs text-gray-500">
                                        {endpoint.event_types.join(", ")}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => remove(endpoint.id)}
                                    className={`flex items-center gap-1 px-2 py-1 text-xs font-medium ${accountGlassDangerButtonClassName}`}
                                >
                                    <Trash2 className="h-4 w-4" /> Delete
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </AccountSection>

            {deliveries.length > 0 && (
                <div className="mt-6">
                    <h4 className="mb-2 text-sm font-medium text-gray-700">
                        Recent deliveries
                    </h4>
                    <AccountSection>
                        {deliveries.map((delivery) => (
                            <div
                                key={delivery.id}
                                className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2 text-xs last:border-b-0"
                            >
                                <code className="font-mono text-gray-700">
                                    {delivery.event_type}
                                </code>
                                <span
                                    className={
                                        delivery.status === "succeeded"
                                            ? "text-green-600"
                                            : delivery.status === "failed"
                                              ? "text-red-600"
                                              : "text-gray-500"
                                    }
                                >
                                    {delivery.status}
                                    {delivery.response_status
                                        ? ` (${delivery.response_status})`
                                        : ""}
                                    {" · "}
                                    {delivery.attempts} attempt
                                    {delivery.attempts === 1 ? "" : "s"}
                                </span>
                            </div>
                        ))}
                    </AccountSection>
                </div>
            )}
        </div>
    );
}
