import { WEBHOOK_EVENT_TYPES } from "./webhooks";

/**
 * OpenAPI 3.1 description of Mike's public API surface.
 *
 * WHAT AN OPENAPI SPEC IS FOR: it's a machine-readable contract describing every
 * endpoint, its inputs and its outputs. From one document you can render
 * interactive docs (Swagger UI / Redoc), generate typed client SDKs, drive
 * contract tests, and let tools like Postman import the whole API. It is the
 * single source of truth that humans and machines agree on.
 *
 * WHY HAND-AUTHORED (vs generated from Zod): this repo runs Zod v4. The popular
 * `@asteasolutions/zod-to-openapi` generator targets Zod v3's API, so wiring it
 * in cleanly would mean either pinning an older Zod or shimming every schema —
 * more moving parts than a focused, readable spec for the handful of public
 * endpoints. We therefore curate this document by hand and treat keeping it in
 * sync as part of the definition of done. The trade-off is recorded in
 * `docs/adr/0001-developer-platform.md`, along with "generate SDKs FROM this
 * spec" as the natural next step.
 */

const bearerAuth = { bearerAuth: [] as string[] };

function jsonResponse(description: string, schema: unknown) {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

const ErrorSchema = {
  type: "object",
  properties: {
    detail: { type: "string" },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Mike API",
    version: "1.0.0",
    description:
      "Public REST API for Mike, the AI legal-document assistant. Authenticate " +
      "with a programmatic API key (`Authorization: Bearer mike_sk_...`) created " +
      "from the Developer settings page, or with a Supabase session JWT.",
    license: { name: "AGPL-3.0-only" },
  },
  servers: [
    { url: "http://localhost:3001", description: "Local development" },
  ],
  // Applied to every operation unless overridden.
  security: [bearerAuth],
  tags: [
    { name: "API Keys", description: "Manage programmatic API keys." },
    { name: "Webhooks", description: "Register endpoints and inspect deliveries." },
    { name: "Projects", description: "Matter/case projects." },
    { name: "Documents", description: "Standalone documents." },
    { name: "Chat", description: "Assistant chats." },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "A Mike API key (`mike_sk_...`) or a Supabase session JWT. Key " +
          "management and webhook endpoints require a session JWT.",
      },
    },
    schemas: {
      Error: ErrorSchema,
      ApiKey: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          key_prefix: {
            type: "string",
            description: "Non-secret prefix for display, e.g. mike_sk_Ab3xK9.",
          },
          scopes: {
            type: "array",
            items: { type: "string", enum: ["read", "write"] },
          },
          last_used_at: { type: ["string", "null"], format: "date-time" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      ApiKeyCreateRequest: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 100 },
          scopes: {
            type: "array",
            items: { type: "string", enum: ["read", "write"] },
            description: "Defaults to ['read','write'].",
          },
        },
      },
      ApiKeyCreateResponse: {
        allOf: [
          { $ref: "#/components/schemas/ApiKey" },
          {
            type: "object",
            properties: {
              key: {
                type: "string",
                description:
                  "The full secret. Shown ONCE on creation and never again.",
              },
            },
          },
        ],
      },
      WebhookEndpoint: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          url: { type: "string", format: "uri" },
          enabled: { type: "boolean" },
          event_types: {
            type: "array",
            items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] },
          },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      WebhookEndpointCreateRequest: {
        type: "object",
        required: ["url", "event_types"],
        properties: {
          url: { type: "string", format: "uri", description: "HTTPS in production." },
          event_types: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] },
          },
        },
      },
      WebhookEndpointCreateResponse: {
        allOf: [
          { $ref: "#/components/schemas/WebhookEndpoint" },
          {
            type: "object",
            properties: {
              secret: {
                type: "string",
                description:
                  "HMAC signing secret (whsec_...). Shown ONCE on creation.",
              },
            },
          },
        ],
      },
      WebhookDelivery: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          endpoint_id: { type: "string", format: "uuid" },
          event_type: { type: "string" },
          status: { type: "string", enum: ["pending", "succeeded", "failed"] },
          attempts: { type: "integer" },
          response_status: { type: ["integer", "null"] },
          last_error: { type: ["string", "null"] },
          created_at: { type: "string", format: "date-time" },
          delivered_at: { type: ["string", "null"], format: "date-time" },
        },
      },
      Project: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          cm_number: { type: ["string", "null"] },
          shared_with: { type: "array", items: { type: "string" } },
          created_at: { type: "string", format: "date-time" },
        },
      },
      ProjectCreateRequest: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          cm_number: { type: "string" },
          shared_with: { type: "array", items: { type: "string", format: "email" } },
        },
      },
      Document: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          project_id: { type: ["string", "null"], format: "uuid" },
          status: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Chat: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: ["string", "null"] },
          created_at: { type: "string", format: "date-time" },
        },
      },
    },
    responses: {
      Unauthorized: jsonResponse("Missing or invalid credentials", {
        $ref: "#/components/schemas/Error",
      }),
      Forbidden: jsonResponse("Authenticated but not permitted", {
        $ref: "#/components/schemas/Error",
      }),
      NotFound: jsonResponse("Resource not found", {
        $ref: "#/components/schemas/Error",
      }),
    },
  },
  paths: {
    "/v1/api-keys": {
      get: {
        tags: ["API Keys"],
        summary: "List active API keys",
        description: "Returns prefixes and metadata only — never the secret.",
        responses: {
          "200": jsonResponse("List of keys", {
            type: "array",
            items: { $ref: "#/components/schemas/ApiKey" },
          }),
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
      post: {
        tags: ["API Keys"],
        summary: "Create an API key",
        description:
          "Requires a session JWT — you cannot mint a key with another key.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiKeyCreateRequest" },
            },
          },
        },
        responses: {
          "201": jsonResponse("Created — includes the one-time secret", {
            $ref: "#/components/schemas/ApiKeyCreateResponse",
          }),
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
    },
    "/v1/api-keys/{id}": {
      delete: {
        tags: ["API Keys"],
        summary: "Revoke an API key",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "204": { description: "Revoked" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/webhooks/events": {
      get: {
        tags: ["Webhooks"],
        summary: "List subscribable event types",
        responses: {
          "200": jsonResponse("Event catalogue", {
            type: "object",
            properties: {
              event_types: { type: "array", items: { type: "string" } },
            },
          }),
        },
      },
    },
    "/v1/webhooks/endpoints": {
      get: {
        tags: ["Webhooks"],
        summary: "List webhook endpoints",
        responses: {
          "200": jsonResponse("Endpoints (no secrets)", {
            type: "array",
            items: { $ref: "#/components/schemas/WebhookEndpoint" },
          }),
        },
      },
      post: {
        tags: ["Webhooks"],
        summary: "Register a webhook endpoint",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/WebhookEndpointCreateRequest",
              },
            },
          },
        },
        responses: {
          "201": jsonResponse("Created — includes the one-time signing secret", {
            $ref: "#/components/schemas/WebhookEndpointCreateResponse",
          }),
          "400": jsonResponse("Validation error", {
            $ref: "#/components/schemas/Error",
          }),
        },
      },
    },
    "/v1/webhooks/endpoints/{id}": {
      delete: {
        tags: ["Webhooks"],
        summary: "Delete a webhook endpoint",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "204": { description: "Deleted" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/v1/webhooks/deliveries": {
      get: {
        tags: ["Webhooks"],
        summary: "List recent webhook deliveries",
        parameters: [
          {
            name: "endpoint_id",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", maximum: 200 },
          },
        ],
        responses: {
          "200": jsonResponse("Deliveries", {
            type: "array",
            items: { $ref: "#/components/schemas/WebhookDelivery" },
          }),
        },
      },
    },
    "/projects": {
      get: {
        tags: ["Projects"],
        summary: "List projects",
        responses: {
          "200": jsonResponse("Projects", {
            type: "array",
            items: { $ref: "#/components/schemas/Project" },
          }),
        },
      },
      post: {
        tags: ["Projects"],
        summary: "Create a project",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProjectCreateRequest" },
            },
          },
        },
        responses: {
          "201": jsonResponse("Created", { $ref: "#/components/schemas/Project" }),
        },
      },
    },
    "/projects/{projectId}": {
      get: {
        tags: ["Projects"],
        summary: "Get a project",
        parameters: [
          {
            name: "projectId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": jsonResponse("Project", { $ref: "#/components/schemas/Project" }),
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/single-documents": {
      get: {
        tags: ["Documents"],
        summary: "List standalone documents",
        responses: {
          "200": jsonResponse("Documents", {
            type: "array",
            items: { $ref: "#/components/schemas/Document" },
          }),
        },
      },
    },
    "/chat": {
      get: {
        tags: ["Chat"],
        summary: "List chats",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": jsonResponse("Chats", {
            type: "array",
            items: { $ref: "#/components/schemas/Chat" },
          }),
        },
      },
    },
  },
} as const;

export type OpenApiDocument = typeof openApiDocument;
