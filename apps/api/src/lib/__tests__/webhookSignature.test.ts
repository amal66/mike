import { describe, it, expect } from "vitest";
import {
  WEBHOOK_SECRET_PREFIX,
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../../core/webhookSignature";

const SECRET = "whsec_test_0123456789abcdef";
const PAYLOAD = JSON.stringify({ id: "evt_1", type: "document.uploaded" });

describe("generateWebhookSecret", () => {
  it("returns a whsec_-prefixed secret", () => {
    expect(generateWebhookSecret().startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
  });

  it("returns a fresh value each call", () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});

describe("signWebhookPayload", () => {
  it("is a 64-char hex HMAC-SHA256 digest", () => {
    expect(signWebhookPayload(PAYLOAD, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical input", () => {
    expect(signWebhookPayload(PAYLOAD, SECRET)).toBe(
      signWebhookPayload(PAYLOAD, SECRET),
    );
  });

  it("changes when the payload changes (integrity)", () => {
    const a = signWebhookPayload(PAYLOAD, SECRET);
    const b = signWebhookPayload(PAYLOAD + " ", SECRET);
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes (authenticity)", () => {
    const a = signWebhookPayload(PAYLOAD, SECRET);
    const b = signWebhookPayload(PAYLOAD, "whsec_other_secret");
    expect(a).not.toBe(b);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a signature it produced", () => {
    const sig = signWebhookPayload(PAYLOAD, SECRET);
    expect(verifyWebhookSignature(PAYLOAD, sig, SECRET)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const sig = signWebhookPayload(PAYLOAD, "whsec_attacker");
    expect(verifyWebhookSignature(PAYLOAD, sig, SECRET)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const sig = signWebhookPayload(PAYLOAD, SECRET);
    expect(verifyWebhookSignature(PAYLOAD + "tamper", sig, SECRET)).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verifyWebhookSignature(PAYLOAD, "abc", SECRET)).toBe(false);
  });
});
