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
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import type { Transport } from "../src/transport.js";

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
  issuedAt = NOW,
): Record<string, unknown> {
  const expiresAt = issuedAt + 86_400;
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

/**
 * The same rules, this time through the real client. The `absorb()` helper
 * above restates the gate; these tests exist so that deleting the gate in
 * `Keylight.absorbConfigFields` turns something red. Every response body is
 * served by a scripted transport, and "stored" means what the client actually
 * wrote to the store under `ACCOUNT.PRODUCT_CONFIG`.
 *
 * The client verifies against the wall clock, so the signed fixtures here are
 * issued at `Date.now()` rather than at the pinned `NOW`.
 */
describe("requireSignedConfig through the client", () => {
  const SEED_DAYS = 30;

  /** Answers every call — GET /config and POST validate alike — with one body. */
  function scripted(body: Record<string, unknown>, status = 200): Transport {
    const text = JSON.stringify(body);
    return {
      async postJson() { return { kind: "response", status, body: text }; },
      async get() { return { kind: "response", status, body: text }; },
    };
  }

  function client(body: Record<string, unknown>, requireSignedConfig: boolean, store = new MemoryStore()) {
    const kl = new Keylight({
      tenantId: TENANT,
      productId: PRODUCT,
      trialDurationDays: SEED_DAYS,
      trustedKeys: trusted(),
      requireSignedConfig,
      transport: scripted(body),
      store,
      keylessHeartbeatMs: null,
    });
    return { kl, store };
  }

  const liveSigned = (trialDays: number) => signedBody(trialDays, false, TENANT, PRODUCT, Math.floor(Date.now() / 1000));

  /** A store with a license on it, so `validate()` has something to send. */
  async function licensedStore(): Promise<MemoryStore> {
    const store = new MemoryStore();
    await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
    await store.set(ACCOUNT.INSTANCE_ID, "srv-1");
    return store;
  }

  // (a) Rule 2 on the wire: an unsigned /config is not cached, the seed stays.
  it("flag on: an unsigned /config response is not stored and the seed is kept", async () => {
    const { kl, store } = client(unsignedBody(365), true);

    await kl.fetchConfig();

    expect(await store.get(ACCOUNT.PRODUCT_CONFIG)).toBeNull();
    expect(kl.effectiveTrialDurationDays()).toBe(SEED_DAYS);
  });

  // (b) A valid signature gets through.
  it("flag on: a validly signed /config response is stored", async () => {
    const { kl, store } = client(liveSigned(14), true);

    await kl.fetchConfig();

    expect(kl.effectiveTrialDurationDays()).toBe(14);
    expect(JSON.parse((await store.get(ACCOUNT.PRODUCT_CONFIG)) ?? "{}").trialDurationDays).toBe(14);
  });

  // (c) Rule 4: the validate route is not a way around the gate.
  it("flag on: a tampered signature riding on validate is not stored", async () => {
    const tampered = { ...liveSigned(14), trial_duration_days: 365 };
    const { kl, store } = client(tampered, true, await licensedStore());

    await kl.validate();

    expect(await store.get(ACCOUNT.PRODUCT_CONFIG)).toBeNull();
    expect(kl.effectiveTrialDurationDays()).toBe(SEED_DAYS);
  });

  it("flag on: an unsigned body riding on validate is not stored either", async () => {
    const { kl, store } = client(unsignedBody(365), true, await licensedStore());

    await kl.validate();

    expect(await store.get(ACCOUNT.PRODUCT_CONFIG)).toBeNull();
    expect(kl.effectiveTrialDurationDays()).toBe(SEED_DAYS);
  });

  // (d) The default stays permissive: unsigned products keep working.
  it("flag off: an unsigned /config response is stored", async () => {
    const { kl, store } = client(unsignedBody(14), false);

    await kl.fetchConfig();

    expect(kl.effectiveTrialDurationDays()).toBe(14);
    expect(JSON.parse((await store.get(ACCOUNT.PRODUCT_CONFIG)) ?? "{}").trialDurationDays).toBe(14);
  });
});
