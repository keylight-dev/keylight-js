/**
 * Ed25519 verification of server-owned product settings.
 *
 * The payload format is frozen across every SDK — see section 4 of
 * `keylight-cpp/docs/superpowers/specs/2026-09-05-trial-parity-handoff.md`:
 *
 *   cfg1|{kid}|{tenantId}|{productId}|{issuedAt}|{expiresAt}|{trialDurationDays}|{freeTierEnabled}
 *
 * Once a verifying client is in the wild these bytes cannot change: every
 * shipped client would reject valid configs, and it cannot be fixed from the
 * server. The first test is therefore a golden vector captured from the live
 * worker rather than a fixture this file generated for itself — a fixture only
 * proves the file agrees with itself. It is the same vector the Swift, C# and
 * Rust SDKs pin.
 */
import { describe, it, expect } from "vitest";
import { verifyConfig } from "../src/verifier.js";
import type { ProductConfigFields } from "../src/productConfig.js";

// Captured from GET https://api.keylight.dev/anotheragence/getbarry/config on
// 2026-09-06, worker version 717cfb7c. The public key is what
// GET /anotheragence/.well-known/keylight-keys serves for kid k1.
const TENANT = "anotheragence";
const PRODUCT = "getbarry";
const KID = "k1";
const PUBLIC_KEY = "wPOiRNiP2hbc0O4UCAuO6FRRLKp4YvGtf8V27xnPzNY=";
const SIGNATURE =
  "WbyLOjmB7jtA3Ny9Qon/uJtXpZx61/Vx+U7OsQpSD17xkem5QrYwvSQOmRLw7J6Ozhgr8r2bptQ/UhiDRUZ7DA==";
const ISSUED_AT = 1_788_695_996;
const EXPIRES_AT = 1_788_782_396;
const SKEW = 300;

/** An instant inside the signature window, so freshness passes deterministically
 *  forever rather than for one day in 2026. */
const INSIDE_WINDOW = 1_788_700_000;

const trusted = (kid = KID): Record<string, string> => ({ [kid]: PUBLIC_KEY });

function fields(over: Partial<ProductConfigFields> = {}): ProductConfigFields {
  return {
    trial_duration_days: 1,
    free_tier_enabled: true,
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    kid: KID,
    signature: SIGNATURE,
    ...over,
  };
}

const verify = (
  f: ProductConfigFields = fields(),
  tenant = TENANT,
  product = PRODUCT,
  now = INSIDE_WINDOW,
  keys = trusted(),
) => verifyConfig(f, tenant, product, keys, now, SKEW);

describe("verifyConfig", () => {
  it("verifies a real signature from the live worker", () => {
    expect(verify()).toBe(true);
  });

  // Rule 1: tenant and product come from local config, never the body.

  it("rejects a config signed for a different product", () => {
    expect(verify(fields(), TENANT, "someotherapp")).toBe(false);
  });

  it("rejects a config signed for a different tenant", () => {
    expect(verify(fields(), "someothertenant")).toBe(false);
  });

  it("rejects a kid missing from the trusted keyset", () => {
    expect(verify(fields(), TENANT, PRODUCT, INSIDE_WINDOW, trusted("k2"))).toBe(false);
  });

  it("rejects tampered values", () => {
    expect(verify(fields({ trial_duration_days: 365 }))).toBe(false);
  });

  it("rejects an absent signature", () => {
    expect(verify(fields({ signature: null }))).toBe(false);
  });

  // Rule 3: freshness applies to the wire.

  it("rejects a response from before its issued_at", () => {
    expect(verify(fields(), TENANT, PRODUCT, ISSUED_AT - SKEW - 1)).toBe(false);
  });

  it("rejects a response past its expiry", () => {
    expect(verify(fields(), TENANT, PRODUCT, EXPIRES_AT + SKEW + 1)).toBe(false);
  });

  it("accepts clock drift within the skew tolerance", () => {
    expect(verify(fields(), TENANT, PRODUCT, EXPIRES_AT + SKEW - 1)).toBe(true);
    expect(verify(fields(), TENANT, PRODUCT, ISSUED_AT - SKEW + 1)).toBe(true);
  });

  /** The worker signs a complete pair or sends the response unsigned, so a
   *  partial config was never signable. */
  it("rejects a partial config", () => {
    expect(verify(fields({ free_tier_enabled: null }))).toBe(false);
  });
});

describe("readConfigFields", () => {
  it("carries the signature through, so a route cannot silently drop it", async () => {
    const { readConfigFields } = await import("../src/productConfig.js");
    const parsed = readConfigFields({
      trial_duration_days: 1,
      free_tier_enabled: true,
      issued_at: ISSUED_AT,
      expires_at: EXPIRES_AT,
      kid: KID,
      signature: SIGNATURE,
    });
    expect(parsed.kid).toBe(KID);
    expect(parsed.signature).toBe(SIGNATURE);
    expect(parsed.issued_at).toBe(ISSUED_AT);
    expect(parsed.expires_at).toBe(EXPIRES_AT);
  });
});
