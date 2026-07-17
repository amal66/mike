import crypto from "crypto";

/**
 * Webhook payload signing — pure crypto so it can be unit-tested and copied
 * verbatim into a receiver's codebase.
 *
 * WHAT AN HMAC SIGNATURE PROVES: an HMAC (Hash-based Message Authentication
 * Code) is computed from the request body AND a shared secret. Because only
 * Mike and the endpoint owner know the secret, a valid signature proves two
 * things at once:
 *   1. Authenticity — the request really came from Mike (nobody else can
 *      produce the signature without the secret).
 *   2. Integrity — the body was not modified in transit (any change alters the
 *      signature).
 * It is NOT encryption: the payload is still plaintext JSON. It is a tamper-
 * evident seal, the same idea behind the download tokens elsewhere in this
 * codebase (`core/downloadTokens.ts`).
 */

/** Prefix for generated endpoint secrets — `whsec` = "webhook secret". */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/** Mint a random per-endpoint signing secret. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
}

/** Hex-encoded HMAC-SHA256 of the exact body bytes under the endpoint secret. */
export function signWebhookPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Constant-time verification a receiver can use. Exposed so docs can point at a
 * canonical implementation and so it is covered by the same tests as signing.
 *
 * The constant-time compare matters for the same reason as API-key hashes: a
 * byte-by-byte `===` would let an attacker forge a signature incrementally by
 * timing the rejection.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signWebhookPayload(payload, secret), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}
