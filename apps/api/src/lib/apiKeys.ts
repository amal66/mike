import { createServerSupabase } from "./supabase";
import { logger } from "./logger";
import {
  apiKeyPrefix,
  generateApiKey,
  isApiKeyToken,
  verifyApiKeyHash,
} from "../core/apiKeys";

/**
 * Database layer for programmatic API keys. The pure crypto lives in
 * `core/apiKeys.ts`; this module is the thin bridge between that and Postgres.
 *
 * Every public function takes an optional `db` so callers (and tests) can
 * inject a client — the same dependency-injection pattern used by
 * `userApiKeys.ts`.
 */

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Scope model. Keys default to both scopes (full parity with an interactive
 * session). `read` covers safe GET/HEAD requests; `write` covers everything
 * that mutates. Enforcement happens in the auth middleware by mapping the HTTP
 * method to the required scope — see `middleware/auth.ts`.
 */
export const API_KEY_SCOPES = ["read", "write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const DEFAULT_API_KEY_SCOPES: ApiKeyScope[] = ["read", "write"];

/** Non-secret representation returned by the list/create management endpoints. */
export type ApiKeySummary = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  last_used_at: string | null;
  created_at: string;
};

/** Result of authenticating an incoming `Authorization: Bearer mike_sk_...`. */
export type AuthenticatedApiKey = {
  keyId: string;
  userId: string;
  scopes: ApiKeyScope[];
};

type ApiKeyRow = {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[] | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

function toSummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: (row.scopes ?? DEFAULT_API_KEY_SCOPES) as ApiKeyScope[],
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

/**
 * Mint and persist a new key. Returns the one-time plaintext `token` plus the
 * stored summary. The raw token is deliberately NOT persisted — only its hash
 * and prefix are — so this is the only moment the caller can ever see it.
 */
export async function createApiKey(
  userId: string,
  name: string,
  scopes: ApiKeyScope[] = DEFAULT_API_KEY_SCOPES,
  db: Db = createServerSupabase(),
): Promise<{ token: string; apiKey: ApiKeySummary }> {
  const { token, prefix, hash } = generateApiKey();

  const { data, error } = await db
    .from("api_keys")
    .insert({
      user_id: userId,
      name: name.trim() || "Untitled key",
      key_prefix: prefix,
      key_hash: hash,
      scopes,
    })
    .select("*")
    .single();
  if (error || !data) {
    throw error ?? new Error("Failed to create API key");
  }

  return { token, apiKey: toSummary(data as ApiKeyRow) };
}

/** List a user's active (non-revoked) keys, newest first. Secrets never leave the DB. */
export async function listApiKeys(
  userId: string,
  db: Db = createServerSupabase(),
): Promise<ApiKeySummary[]> {
  const { data, error } = await db
    .from("api_keys")
    .select("*")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: ApiKeyRow) => toSummary(row));
}

/**
 * Revoke (soft-delete) a key. We keep the row — setting `revoked_at` — rather
 * than hard-deleting so `last_used_at` and creation history survive for audit.
 * Returns true if a row was revoked, false if it did not exist / wasn't owned.
 */
export async function revokeApiKey(
  userId: string,
  keyId: string,
  db: Db = createServerSupabase(),
): Promise<boolean> {
  const { data, error } = await db
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Verify an incoming bearer token. Returns the owning user + scopes, or null.
 *
 * Lookup strategy: filter by the cheap, indexed, non-secret prefix to fetch the
 * (almost always single) candidate row, then constant-time compare the full
 * hash. This avoids both a full-table scan AND comparing the secret with a
 * timing-unsafe SQL equality on the hash column.
 */
export async function authenticateApiKey(
  token: string,
  db: Db = createServerSupabase(),
): Promise<AuthenticatedApiKey | null> {
  if (!isApiKeyToken(token)) return null;

  const { data, error } = await db
    .from("api_keys")
    .select("id, user_id, key_hash, scopes")
    .eq("key_prefix", apiKeyPrefix(token))
    .is("revoked_at", null);
  if (error || !data) return null;

  for (const row of data as Pick<
    ApiKeyRow,
    "id" | "user_id" | "key_hash" | "scopes"
  >[]) {
    if (verifyApiKeyHash(token, row.key_hash)) {
      return {
        keyId: row.id,
        userId: row.user_id,
        scopes: (row.scopes ?? DEFAULT_API_KEY_SCOPES) as ApiKeyScope[],
      };
    }
  }
  return null;
}

/**
 * Record that a key was just used. Best-effort and intentionally fire-and-
 * forget: a failed analytics write must never block or fail a real request.
 */
export async function touchApiKeyLastUsed(
  keyId: string,
  db: Db = createServerSupabase(),
): Promise<void> {
  try {
    await db
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", keyId);
  } catch (err) {
    logger.warn({ keyId, err }, "[api-keys] failed to update last_used_at");
  }
}
