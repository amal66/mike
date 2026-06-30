import { createServerSupabase } from "./supabase";
import { logger } from "./logger";
import {
  generateWebhookSecret,
  signWebhookPayload,
} from "../core/webhookSignature";

/**
 * Webhooks subsystem: lets developers register HTTPS endpoints that Mike calls
 * when something happens to their data. This is the "push" half of the
 * developer platform — the REST API is "pull".
 *
 * Delivery is deliberately IN-PROCESS (setTimeout-based retries) rather than a
 * Redis/BullMQ queue. For a self-hostable, single-service app that is the right
 * amount of infrastructure; moving to a durable queue is documented as future
 * work in the ADR. The trade-off: deliveries scheduled but not yet sent are
 * lost on a process restart. We mitigate by persisting every delivery row up
 * front so history/▸replay is always inspectable.
 */

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Event catalogue. Each value maps to a real moment in the product. Keep this
 * list and the `data` shapes documented in `docs/developer-platform.md`.
 */
export const WEBHOOK_EVENT_TYPES = [
  "document.uploaded",
  "document.analysed",
  "chat.message",
  "workflow.completed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** How many times we attempt a single delivery before marking it failed. */
const MAX_ATTEMPTS = 5;

/**
 * Exponential backoff between attempts (milliseconds). Attempt N waits
 * RETRY_DELAYS_MS[N-1] before firing. The curve (0s, 5s, 30s, 2m, 10m) spreads
 * retries out so a briefly-down receiver recovers without us hammering it.
 */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000, 600_000];

/** Per-request timeout so one slow receiver can't pin a delivery open forever. */
const DELIVERY_TIMEOUT_MS = 10_000;

export type WebhookEndpointSummary = {
  id: string;
  url: string;
  enabled: boolean;
  event_types: WebhookEventType[];
  created_at: string;
  updated_at: string;
};

type WebhookEndpointRow = WebhookEndpointSummary & {
  user_id: string;
  secret: string;
};

export type WebhookDeliverySummary = {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
};

function toEndpointSummary(row: WebhookEndpointRow): WebhookEndpointSummary {
  return {
    id: row.id,
    url: row.url,
    enabled: row.enabled,
    event_types: row.event_types,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Endpoint management ──────────────────────────────────────────────────────

/**
 * Register an endpoint. We mint a signing secret here and return it to the
 * caller exactly once (mirroring API-key creation) — the receiver needs it to
 * verify `X-Mike-Signature`.
 */
export async function createWebhookEndpoint(
  userId: string,
  url: string,
  eventTypes: WebhookEventType[],
  db: Db = createServerSupabase(),
): Promise<{ endpoint: WebhookEndpointSummary; secret: string }> {
  const secret = generateWebhookSecret();
  const { data, error } = await db
    .from("webhook_endpoints")
    .insert({
      user_id: userId,
      url,
      secret,
      enabled: true,
      event_types: eventTypes,
    })
    .select("*")
    .single();
  if (error || !data) throw error ?? new Error("Failed to create endpoint");
  return { endpoint: toEndpointSummary(data as WebhookEndpointRow), secret };
}

export async function listWebhookEndpoints(
  userId: string,
  db: Db = createServerSupabase(),
): Promise<WebhookEndpointSummary[]> {
  const { data, error } = await db
    .from("webhook_endpoints")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r: WebhookEndpointRow) => toEndpointSummary(r));
}

export async function deleteWebhookEndpoint(
  userId: string,
  endpointId: string,
  db: Db = createServerSupabase(),
): Promise<boolean> {
  const { data, error } = await db
    .from("webhook_endpoints")
    .delete()
    .eq("id", endpointId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function listWebhookDeliveries(
  userId: string,
  opts: { endpointId?: string; limit?: number } = {},
  db: Db = createServerSupabase(),
): Promise<WebhookDeliverySummary[]> {
  let query = db
    .from("webhook_deliveries")
    .select(
      "id, endpoint_id, event_type, status, attempts, response_status, last_error, created_at, updated_at, delivered_at",
    )
    .eq("user_id", userId);
  if (opts.endpointId) query = query.eq("endpoint_id", opts.endpointId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(Math.min(opts.limit ?? 50, 200));
  if (error) throw error;
  return (data ?? []) as WebhookDeliverySummary[];
}

// ── Event emission + delivery ────────────────────────────────────────────────

/**
 * Fan an event out to every enabled endpoint that subscribed to it. Creates one
 * `webhook_deliveries` row per endpoint, then kicks off async delivery.
 *
 * This is fire-and-forget by design: a webhook failure must NEVER break the
 * product action that triggered it (e.g. a document upload). Callers should
 * `void emitWebhookEvent(...)` and not await it.
 */
export async function emitWebhookEvent(
  userId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
  db: Db = createServerSupabase(),
): Promise<void> {
  try {
    const { data: endpoints, error } = await db
      .from("webhook_endpoints")
      .select("id")
      .eq("user_id", userId)
      .eq("enabled", true)
      .contains("event_types", [eventType]);
    if (error) throw error;
    if (!endpoints || endpoints.length === 0) return;

    for (const endpoint of endpoints as { id: string }[]) {
      const { data: delivery, error: insErr } = await db
        .from("webhook_deliveries")
        .insert({
          user_id: userId,
          endpoint_id: endpoint.id,
          event_type: eventType,
          payload: data,
          status: "pending",
          attempts: 0,
        })
        .select("id")
        .single();
      if (insErr || !delivery) {
        logger.warn(
          { userId, eventType, err: insErr },
          "[webhooks] failed to enqueue delivery",
        );
        continue;
      }
      scheduleDelivery((delivery as { id: string }).id, 1);
    }
  } catch (err) {
    logger.warn({ userId, eventType, err }, "[webhooks] emit failed");
  }
}

/** Schedule attempt `attempt` of a delivery after the backoff delay. */
function scheduleDelivery(deliveryId: string, attempt: number): void {
  const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!;
  const timer = setTimeout(() => {
    void attemptDelivery(deliveryId, attempt);
  }, delay);
  // Don't let a pending retry keep the process alive on shutdown.
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Perform one delivery attempt. On a non-2xx / network error it reschedules the
 * next attempt (up to MAX_ATTEMPTS) with the next backoff step. Every outcome
 * is written back to the delivery row so history is complete and auditable.
 */
async function attemptDelivery(
  deliveryId: string,
  attempt: number,
  db: Db = createServerSupabase(),
): Promise<void> {
  const { data: delivery } = await db
    .from("webhook_deliveries")
    .select("id, user_id, endpoint_id, event_type, payload")
    .eq("id", deliveryId)
    .single();
  if (!delivery) return;

  const { data: endpoint } = await db
    .from("webhook_endpoints")
    .select("url, secret, enabled")
    .eq("id", delivery.endpoint_id)
    .single();
  if (!endpoint || endpoint.enabled === false) return;

  // The signed body is the canonical event envelope. The delivery id doubles
  // as the event id, giving receivers a natural idempotency key.
  const body = JSON.stringify({
    id: delivery.id,
    type: delivery.event_type,
    created_at: new Date().toISOString(),
    data: delivery.payload ?? {},
  });
  const signature = signWebhookPayload(body, endpoint.secret as string);

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let lastError: string | null = null;
  let ok = false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint.url as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mike-Webhooks/1.0",
        "X-Mike-Event": String(delivery.event_type),
        "X-Mike-Delivery-Id": String(delivery.id),
        "X-Mike-Signature": signature,
      },
      body,
      signal: controller.signal,
    });
    responseStatus = res.status;
    responseBody = (await res.text()).slice(0, 1000); // cap stored body
    ok = res.ok;
    if (!ok) lastError = `Endpoint returned HTTP ${res.status}`;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
  }

  const willRetry = !ok && attempt < MAX_ATTEMPTS;
  await db
    .from("webhook_deliveries")
    .update({
      status: ok ? "succeeded" : willRetry ? "pending" : "failed",
      attempts: attempt,
      response_status: responseStatus,
      response_body: responseBody,
      last_error: lastError,
      delivered_at: ok ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);

  if (willRetry) scheduleDelivery(deliveryId, attempt + 1);
}
