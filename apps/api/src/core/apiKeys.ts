import crypto from "crypto";

/**
 * Programmatic API-key primitives — pure crypto, no database or env access so
 * they can be unit-tested in isolation and reused anywhere.
 *
 * SECURITY MODEL (why it looks like this):
 *   - A Mike API key is a *bearer secret*: whoever holds the string can act as
 *     the user. We therefore treat it exactly like a password.
 *   - We NEVER store the raw key. We store a SHA-256 hash of it. If the
 *     database leaks, the hashes cannot be replayed against the API because the
 *     server only ever compares hashes — it never needs the original.
 *     (SHA-256 — not bcrypt/argon2 — is appropriate here because the secret has
 *     ~238 bits of entropy. Slow password hashes exist to defeat brute force of
 *     low-entropy human passwords; a 40-char random base62 string is not
 *     brute-forceable, so a fast hash is the correct, cheaper choice.)
 *   - We also store a short, non-secret PREFIX (e.g. `mike_sk_Ab3xK9`) so the
 *     UI can show users which key is which without ever revealing the secret.
 *   - Verification uses a constant-time comparison (see `verifyApiKeyHash`) to
 *     avoid leaking, via response timing, how many leading bytes of a guessed
 *     hash were correct.
 */

/** Human-readable, greppable prefix. `sk` = "secret key" (Stripe convention). */
export const API_KEY_PREFIX = "mike_sk_";

/** Number of random characters in the secret body. 40 base62 chars ≈ 238 bits. */
const SECRET_BODY_LENGTH = 40;

/**
 * How many characters of the random body we keep in the stored, non-secret
 * prefix. Enough to disambiguate keys in a list UI, far too few to guess the
 * rest of the secret.
 */
const PREFIX_BODY_CHARS = 6;

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Cryptographically-secure random base62 string.
 *
 * We map random bytes into the 62-char alphabet using rejection sampling:
 * bytes >= 248 are discarded so the remaining range (0..247) is an exact
 * multiple of 62. Without this, `byte % 62` would make the first few
 * characters of the alphabet slightly more likely (modulo bias).
 */
export function randomBase62(length: number): string {
  let result = "";
  while (result.length < length) {
    const bytes = crypto.randomBytes(length);
    for (const byte of bytes) {
      if (result.length >= length) break;
      if (byte < 248) result += BASE62[byte % 62];
    }
  }
  return result;
}

export type GeneratedApiKey = {
  /** The full secret, shown to the user exactly once. */
  token: string;
  /** Short non-secret identifier stored in the clear for display + lookup. */
  prefix: string;
  /** SHA-256 hex digest of the token — the only representation we persist. */
  hash: string;
};

/** Returns true if a bearer credential is a Mike API key (vs a Supabase JWT). */
export function isApiKeyToken(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX);
}

/** SHA-256 hex digest of the full key. Deterministic — same input, same hash. */
export function hashApiKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * The non-secret prefix we store and index on. Looking a key up by prefix lets
 * us fetch the (usually single) candidate row cheaply, then constant-time
 * compare the full hash — instead of scanning every hash in the table.
 */
export function apiKeyPrefix(token: string): string {
  return token.slice(0, API_KEY_PREFIX.length + PREFIX_BODY_CHARS);
}

/** Mint a brand-new key. The caller persists `{prefix, hash}` and returns `token` once. */
export function generateApiKey(): GeneratedApiKey {
  const token = `${API_KEY_PREFIX}${randomBase62(SECRET_BODY_LENGTH)}`;
  return { token, prefix: apiKeyPrefix(token), hash: hashApiKey(token) };
}

/**
 * Constant-time check that `token` hashes to `expectedHash`.
 *
 * WHAT TIMING-SAFE COMPARE DEFENDS AGAINST: a naive `a === b` on strings
 * returns as soon as it finds a differing byte. An attacker measuring response
 * latency could therefore discover the secret one byte at a time. crypto's
 * `timingSafeEqual` always compares the full buffers, so the time taken does
 * not depend on *where* the mismatch is.
 */
export function verifyApiKeyHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(token), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, "hex");
  } catch {
    return false;
  }
  // Length guard: timingSafeEqual throws if the buffers differ in length.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
