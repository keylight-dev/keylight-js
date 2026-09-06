/**
 * `requireSignedConfig` — the enforcement half of server-owned settings.
 *
 * Two rules from section 4 of
 * `keylight-cpp/docs/superpowers/specs/2026-09-05-trial-parity-handoff.md` are
 * what these tests exist to hold:
 *
 * - **Rule 2:** a config that does not verify is *never cached*. It falls back
 *   to the seed, never to what the server claimed.
 * - **Rule 4:** the rule applies wherever the fields ride. If `/config`
 *   verifies but a `validate` body caches unsigned settings, the check is one
 *   route away from useless. Authentication is a property of the fields, not of
 *   the endpoint they arrived on.
 *
 * The flag defaults **off**: the worker signs a product's settings only once
 * that product has a trial length configured, so defaulting it on would reject
 * the legitimate unsigned responses every other product gets.
 */
import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { configPayload } from "../src/verifier.js";
import { readConfigFields, mergeConfig, type CachedProductConfig } from "../src/productConfig.js";
import { verifyConfig } from "../src/verifier.js";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const TENANT = "t";
const PRODUCT = "p";
const KID = "k1";
const SKEW = 300;

// Fixed seed: these tests assert on verification outcomes, not on key
// generation, and a deterministic key keeps failures reproducible.
const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const publicKey = () => b64(ed.getPublicKey(SEED));
const trusted = (kid = KID): Record<string, string> => ({ [kid]: publicKey() });

const NOW = 1_800_000_000;

/** Sign the way the worker does, so these tests exercise the real payload. */
function signedBody(
  trialDays: number,
  freeTier = false,
  tenant = TENANT,
  product = PRODUCT,
): Record<string, unknown> {
  const issuedAt = NOW;
  const expiresAt = NOW + 86_400;
  const payload = configPayload(KID, tenant, product, issuedAt, expiresAt, trialDays, freeTier);
  const sig = b64(ed.sign(new TextEncoder().encode(payload), SEED));
  return {
    valid: true,
    trial_duration_days: trialDays,
    free_tier_enabled: freeTier,
    issued_at: issuedAt,
    expires_at: expiresAt,
    kid: KID,
    signature: sig,
  };
}

const unsignedBody = (trialDays: number): Record<string, unknown> => ({
  valid: true,
  trial_duration_days: trialDays,
  free_tier_enabled: false,
});

/**
 * The gate as the client applies it: verify when required, and on failure leave
 * the cache exactly as it was.
 */
function absorb(
  cached: CachedProductConfig,
  body: Record<string, unknown>,
  requireSigned: boolean,
  keys = trusted(),
  now = NOW,
): CachedProductConfig {
  const fields = readConfigFields(body);
  if (requireSigned && !verifyConfig(fields, TENANT, PRODUCT, keys, now, SKEW)) return cached;
  return mergeConfig(cached, fields);
}

describe("requireSignedConfig", () => {
  it("is off by default", async () => {
    const { normalizeConfig } = await import("../src/config.js");
    const cfg = normalizeConfig({ tenantId: TENANT, productId: PRODUCT, sdkKey: "sdk_live_test" });
    expect(cfg.requireSignedConfig).toBe(false);
  });

  it("absorbs an unsigned config when enforcement is off", () => {
    expect(absorb({}, unsignedBody(14), false).trialDurationDays).toBe(14);
  });

  // Rule 2: never cache what did not verify.

  it("rejects an unsigned config when enforcement is on", () => {
    const cached: CachedProductConfig = {};
    expect(absorb(cached, unsignedBody(365), true).trialDurationDays).toBeUndefined();
  });

  it("absorbs a validly signed config when enforcement is on", () => {
    expect(absorb({}, signedBody(14), true).trialDurationDays).toBe(14);
  });

  it("rejects a body that does not match its signature", () => {
    const tampered = { ...signedBody(14), trial_duration_days: 365 };
    expect(absorb({}, tampered, true).trialDurationDays).toBeUndefined();
  });

  it("rejects a config signed by a rotated-away kid", () => {
    expect(absorb({}, signedBody(14), true, trusted("k2")).trialDurationDays).toBeUndefined();
  });

  it("rejects a config signed for another product", () => {
    const neighbour = signedBody(14, false, TENANT, "neighbourapp");
    expect(absorb({}, neighbour, true).trialDurationDays).toBeUndefined();
  });

  // Rule 3: a cached config outlives its signature window.

  it("leaves an already-cached value alone once its window has passed", () => {
    const cached = absorb({}, signedBody(14), true);
    expect(cached.trialDurationDays).toBe(14);
    // A later launch, long after the signature expired. Nothing re-verifies a
    // value already accepted; only new responses are checked.
    const later = absorb(cached, unsignedBody(365), true, trusted(), NOW + 200_000);
    expect(later.trialDurationDays).toBe(14);
  });

  // Rule 4: validate is not a way around the gate.

  it("does not let an unsigned validate body write the cache", () => {
    const validateBody = { valid: true, trial_duration_days: 365, free_tier_enabled: true };
    expect(absorb({}, validateBody, true).trialDurationDays).toBeUndefined();
  });
});
