import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireUserSession } from "../middleware/auth";
import { parseBody, sendError } from "../lib/http";
import {
  DEFAULT_API_KEY_SCOPES,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyScope,
} from "../lib/apiKeys";

/**
 * Management API for programmatic keys, mounted at `/v1/api-keys`.
 *
 * These routes are guarded by `requireUserSession` (a real logged-in user),
 * NOT just `requireAuth` — you cannot use one API key to mint another. That
 * closes an obvious privilege-escalation path: a leaked key can call the data
 * API but can never enlarge or replace itself.
 */
export const apiKeysRouter = Router();

apiKeysRouter.use(requireAuth, requireUserSession);

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100),
  scopes: z.array(z.enum(["read", "write"])).nonempty().optional(),
});

// POST /v1/api-keys — mint a key. The plaintext secret is returned exactly once.
apiKeysRouter.post("/", async (req, res) => {
  const body = parseBody(createSchema, req, res);
  if (!body) return;

  const userId = res.locals.userId as string;
  const scopes = (body.scopes ?? DEFAULT_API_KEY_SCOPES) as ApiKeyScope[];
  const { token, apiKey } = await createApiKey(userId, body.name, scopes);

  // `key` is the full secret — clients must store it now; we can never show it
  // again because only its hash is persisted.
  res.status(201).json({ ...apiKey, key: token });
});

// GET /v1/api-keys — list active keys (prefixes only; no secrets).
apiKeysRouter.get("/", async (_req, res) => {
  const userId = res.locals.userId as string;
  res.json(await listApiKeys(userId));
});

// DELETE /v1/api-keys/:id — revoke a key.
apiKeysRouter.delete("/:id", async (req, res) => {
  const userId = res.locals.userId as string;
  const revoked = await revokeApiKey(userId, req.params.id);
  if (!revoked) {
    sendError(res, 404, "NOT_FOUND", "API key not found");
    return;
  }
  res.status(204).send();
});
