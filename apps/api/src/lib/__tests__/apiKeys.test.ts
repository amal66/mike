import { describe, it, expect } from "vitest";
import {
  API_KEY_PREFIX,
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  isApiKeyToken,
  randomBase62,
  verifyApiKeyHash,
} from "../../core/apiKeys";
import { authenticateApiKey, revokeApiKey } from "../apiKeys";

/**
 * Minimal chainable stand-in for a Supabase query builder. Every builder method
 * returns the chain; awaiting the chain (or calling `.single()`) resolves to
 * whatever `handler` returns. This lets us drive the DB layer with canned rows
 * without a live database.
 */
function makeDb(
  handler: (table: string) => { data: unknown; error: unknown },
): never {
  const builder = (table: string): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const passthrough = [
      "select",
      "insert",
      "update",
      "delete",
      "eq",
      "is",
      "in",
      "order",
    ];
    for (const m of passthrough) chain[m] = () => builder(table);
    chain.single = () => Promise.resolve(handler(table));
    chain.maybeSingle = () => Promise.resolve(handler(table));
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(handler(table)).then(resolve, reject);
    return chain;
  };
  return { from: (table: string) => builder(table) } as never;
}

describe("randomBase62", () => {
  it("returns a string of the requested length", () => {
    expect(randomBase62(40)).toHaveLength(40);
    expect(randomBase62(1)).toHaveLength(1);
  });

  it("uses only base62 characters", () => {
    expect(randomBase62(200)).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("is overwhelmingly unlikely to repeat", () => {
    const a = randomBase62(40);
    const b = randomBase62(40);
    expect(a).not.toBe(b);
  });
});

describe("generateApiKey", () => {
  it("produces a token with the mike_sk_ prefix", () => {
    const { token } = generateApiKey();
    expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(isApiKeyToken(token)).toBe(true);
  });

  it("derives a prefix that the token starts with", () => {
    const { token, prefix } = generateApiKey();
    expect(token.startsWith(prefix)).toBe(true);
    // Prefix is short and non-secret — must NOT reveal the whole token.
    expect(prefix.length).toBeLessThan(token.length);
  });

  it("derives a hash equal to the SHA-256 of the token", () => {
    const { token, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never stores the raw secret in the hash", () => {
    const { token, hash } = generateApiKey();
    expect(hash).not.toContain(token);
  });
});

describe("apiKeyPrefix", () => {
  it("is stable for a given token", () => {
    const { token } = generateApiKey();
    expect(apiKeyPrefix(token)).toBe(apiKeyPrefix(token));
  });
});

describe("verifyApiKeyHash", () => {
  it("accepts the matching token", () => {
    const { token, hash } = generateApiKey();
    expect(verifyApiKeyHash(token, hash)).toBe(true);
  });

  it("rejects a different token", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(verifyApiKeyHash(a.token, b.hash)).toBe(false);
  });

  it("rejects a tampered token", () => {
    const { token, hash } = generateApiKey();
    const tampered = `${token}x`;
    expect(verifyApiKeyHash(tampered, hash)).toBe(false);
  });

  it("rejects a malformed (non-hex) stored hash without throwing", () => {
    const { token } = generateApiKey();
    expect(verifyApiKeyHash(token, "not-a-valid-hash")).toBe(false);
  });

  it("rejects a hash of the wrong length", () => {
    const { token } = generateApiKey();
    expect(verifyApiKeyHash(token, "abcd")).toBe(false);
  });
});

describe("authenticateApiKey (DB layer)", () => {
  it("returns the owner + scopes for a valid, active key", async () => {
    const { token, hash } = generateApiKey();
    const db = makeDb(() => ({
      data: [
        {
          id: "key-1",
          user_id: "user-42",
          key_hash: hash,
          scopes: ["read", "write"],
        },
      ],
      error: null,
    }));
    const result = await authenticateApiKey(token, db);
    expect(result).toEqual({
      keyId: "key-1",
      userId: "user-42",
      scopes: ["read", "write"],
    });
  });

  it("rejects a token whose prefix has no matching row (revoked or unknown)", async () => {
    const { token } = generateApiKey();
    // Simulate the `.is('revoked_at', null)` filter excluding a revoked key.
    const db = makeDb(() => ({ data: [], error: null }));
    expect(await authenticateApiKey(token, db)).toBeNull();
  });

  it("rejects when the stored hash does not match the presented token", async () => {
    const presented = generateApiKey();
    const other = generateApiKey();
    const db = makeDb(() => ({
      data: [
        {
          id: "key-1",
          user_id: "user-42",
          key_hash: other.hash, // a different key's hash
          scopes: ["read", "write"],
        },
      ],
      error: null,
    }));
    expect(await authenticateApiKey(presented.token, db)).toBeNull();
  });

  it("rejects a non-API-key bearer (e.g. a Supabase JWT) without touching the DB", async () => {
    let queried = false;
    const db = makeDb(() => {
      queried = true;
      return { data: [], error: null };
    });
    expect(await authenticateApiKey("eyJhbGciOi.jwt.token", db)).toBeNull();
    expect(queried).toBe(false);
  });
});

describe("revokeApiKey (DB layer)", () => {
  it("returns true when a row was revoked", async () => {
    const db = makeDb(() => ({ data: [{ id: "key-1" }], error: null }));
    expect(await revokeApiKey("user-42", "key-1", db)).toBe(true);
  });

  it("returns false when nothing matched (wrong owner or already revoked)", async () => {
    const db = makeDb(() => ({ data: [], error: null }));
    expect(await revokeApiKey("user-42", "key-1", db)).toBe(false);
  });
});
