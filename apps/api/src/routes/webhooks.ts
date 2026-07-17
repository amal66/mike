import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireUserSession } from "../middleware/auth";
import { parseBody, sendError } from "../lib/http";
import { env } from "../lib/env";
import { validateRemoteMcpUrl } from "../lib/mcpConnectors";
import {
  WEBHOOK_EVENT_TYPES,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  isWebhookEventType,
  listWebhookDeliveries,
  listWebhookEndpoints,
  type WebhookEventType,
} from "../lib/webhooks";

/**
 * Webhook management API, mounted at `/v1/webhooks`. Like the API-key routes,
 * these require a real user session (`requireUserSession`), so a programmatic
 * key cannot reconfigure where a user's events are sent.
 */
export const webhooksRouter = Router();

webhooksRouter.use(requireAuth, requireUserSession);

const createEndpointSchema = z.object({
  url: z.string().url(),
  event_types: z
    .array(z.string())
    .nonempty("at least one event type is required"),
});

// GET /v1/webhooks/events — the catalogue of subscribable event types.
webhooksRouter.get("/events", (_req, res) => {
  res.json({ event_types: WEBHOOK_EVENT_TYPES });
});

// POST /v1/webhooks/endpoints — register an endpoint; secret returned once.
webhooksRouter.post("/endpoints", async (req, res) => {
  const body = parseBody(createEndpointSchema, req, res);
  if (!body) return;

  // Require HTTPS in production: a webhook secret + payload sent over plain HTTP
  // could be read off the wire. Localhost HTTP is allowed in dev for testing.
  // Parse the URL (rather than regex-matching) to avoid ReDoS and host spoofing.
  const parsed = new URL(body.url);
  const isHttps = parsed.protocol === "https:";
  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (!isHttps && !(env.NODE_ENV !== "production" && isLocalhost)) {
    sendError(res, 400, "VALIDATION_ERROR", "Webhook URL must use HTTPS");
    return;
  }
  if (env.NODE_ENV === "production") {
    try {
      // Webhook delivery is server-side egress. Apply the same DNS-rebinding,
      // metadata-host and private-network protections used by MCP connectors.
      await validateRemoteMcpUrl(body.url);
    } catch (error) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        error instanceof Error ? error.message : "Webhook URL is not allowed",
      );
      return;
    }
  }

  const invalid = body.event_types.filter((e) => !isWebhookEventType(e));
  if (invalid.length > 0) {
    sendError(
      res,
      400,
      "VALIDATION_ERROR",
      `Unknown event type(s): ${invalid.join(", ")}`,
    );
    return;
  }

  const userId = res.locals.userId as string;
  const { endpoint, secret } = await createWebhookEndpoint(
    userId,
    body.url,
    body.event_types as WebhookEventType[],
  );
  res.status(201).json({ ...endpoint, secret });
});

// GET /v1/webhooks/endpoints — list endpoints (secrets are never returned).
webhooksRouter.get("/endpoints", async (_req, res) => {
  const userId = res.locals.userId as string;
  res.json(await listWebhookEndpoints(userId));
});

// DELETE /v1/webhooks/endpoints/:id
webhooksRouter.delete("/endpoints/:id", async (req, res) => {
  const userId = res.locals.userId as string;
  const deleted = await deleteWebhookEndpoint(userId, req.params.id);
  if (!deleted) {
    sendError(res, 404, "NOT_FOUND", "Webhook endpoint not found");
    return;
  }
  res.status(204).send();
});

// GET /v1/webhooks/deliveries — recent delivery attempts (audit / debugging).
webhooksRouter.get("/deliveries", async (req, res) => {
  const userId = res.locals.userId as string;
  const endpointId =
    typeof req.query.endpoint_id === "string"
      ? req.query.endpoint_id
      : undefined;
  const limit =
    typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  res.json(
    await listWebhookDeliveries(userId, {
      endpointId,
      limit: Number.isFinite(limit) ? limit : undefined,
    }),
  );
});
