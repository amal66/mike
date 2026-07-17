import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptString } from "../mcp/client";
import { createWebhookEndpoint } from "../webhooks";

describe("webhook endpoint secrets", () => {
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    process.env.USER_API_KEYS_ENCRYPTION_SECRET =
      "test-webhook-encryption-secret-at-least-32-bytes";
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    } else {
      process.env.USER_API_KEYS_ENCRYPTION_SECRET = previousSecret;
    }
  });

  it("returns the secret once and stores only authenticated ciphertext", async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      from(table: string) {
        expect(table).toBe("webhook_endpoints");
        return {
          insert(row: Record<string, unknown>) {
            inserted = row;
            return {
              select() {
                return {
                  single: async () => ({
                    data: {
                      id: "endpoint-1",
                      created_at: "2026-07-12T00:00:00.000Z",
                      updated_at: "2026-07-12T00:00:00.000Z",
                      ...row,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      },
    } as Parameters<typeof createWebhookEndpoint>[3];

    const result = await createWebhookEndpoint(
      "user-1",
      "https://hooks.example.test/mike",
      ["document.uploaded"],
      db,
    );

    expect(result.secret).toMatch(/^whsec_/);
    expect(inserted).not.toHaveProperty("secret");
    expect(inserted?.encrypted_secret).not.toBe(result.secret);
    expect(
      decryptString(
        inserted?.encrypted_secret as string,
        inserted?.secret_iv as string,
        inserted?.secret_tag as string,
      ),
    ).toBe(result.secret);
  });
});
