// Mirrors the Swift reference suite's coverage for `refreshAfterUpgrade` (poll-revalidate
// briefly after an upgrade so new entitlements appear without waiting for the normal
// cadence -- covers payment-webhook lag), adapted to the JS SDK's store-derived `state()`.
//
// Fixtures (countingTransport / countingFailureTransport / signedLease / seededLicensedStore)
// are copied verbatim from tests/active_revalidate.test.ts so this file stays self-contained
// and readable on its own.
import { test, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import { leasePayload, type Lease } from "../src/lease.js";
import type { Transport } from "../src/transport.js";

const nowSecs = () => Math.floor(Date.now() / 1000);

// Real ed25519 keypair so state()'s signature verification actually trusts the lease
// (same setup as active_revalidate.test.ts).
const privKey = ed.utils.randomPrivateKey();
const pubKeyB64 = Buffer.from(ed.getPublicKey(privKey)).toString("base64");
const TRUSTED_KEYS = { k1: pubKeyB64 };

function signedLease(status: string, expiresAt: number, entitlements: string[] = ["pro"]): Lease {
  const lease: Lease = { kid: "k1", licenseKeyHash: "h", instanceId: "srv-1", issuedAt: nowSecs() - 3600, expiresAt, status, signature: "", entitlements };
  const sig = ed.sign(new TextEncoder().encode(leasePayload(lease)), privKey);
  lease.signature = Buffer.from(sig).toString("base64");
  return lease;
}

/** A licensed store: signed+trusted "active" lease, far future expiry, validated
 *  online `agoSecs` seconds ago. */
async function seededLicensedStore(agoSecs: number, entitlements: string[] = ["pro"]): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
  await store.set(ACCOUNT.INSTANCE_ID, "srv-1");
  await store.set(ACCOUNT.LEASE, JSON.stringify(signedLease("active", nowSecs() + 30 * 86400, entitlements)));
  await store.set(ACCOUNT.LAST_VALIDATED_ONLINE, String(nowSecs() - agoSecs));
  return store;
}

function countingTransport(status: number, body: string) {
  let calls = 0;
  const t: Transport = {
    async postJson() { calls++; return { kind: "response", status, body }; },
    async get() { return { kind: "terminal", error: "n/a" }; },
  };
  return { t, calls: () => calls };
}

// A "terminal" transport failure (per transport.ts) so post() throws NetworkError
// immediately with no retry/backoff sleep.
function countingFailureTransport() {
  let calls = 0;
  const t: Transport = {
    async postJson() { calls++; return { kind: "terminal", error: "offline" }; },
    async get() { return { kind: "terminal", error: "n/a" }; },
  };
  return { t, calls: () => calls };
}

const okBodyWithEntitlements = (entitlements: string[]) =>
  JSON.stringify({ valid: true, license_expires_at: nowSecs() + 30 * 86400, lease: signedLease("active", nowSecs() + 30 * 86400, entitlements) });

test("(1) entitlements change on the first validate -> true", async () => {
  const store = await seededLicensedStore(60, ["pro"]);
  const { t, calls } = countingTransport(200, okBodyWithEntitlements(["pro", "pro-plus"]));
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();

  const result = await kl.refreshAfterUpgrade(1_000, 100);

  expect(result).toBe(true);
  expect(calls(), "should resolve on the first poll, no need for more").toBe(1);
  expect(kl.cachedLease?.entitlements).toEqual(["pro", "pro-plus"]);
});

test("(2) no stored license -> false, zero network calls", async () => {
  const { t, calls } = countingTransport(200, okBodyWithEntitlements(["pro"]));
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store: new MemoryStore() });
  await kl.load();

  const result = await kl.refreshAfterUpgrade(1_000, 100);

  expect(result).toBe(false);
  expect(calls(), "no stored license must not hit the network at all").toBe(0);
});

test("(3) the webhook never lands -> false, but it did poll (validate called more than once)", async () => {
  const store = await seededLicensedStore(60, ["pro"]);
  // Same entitlements / same state every time -- nothing ever changes.
  const { t, calls } = countingTransport(200, okBodyWithEntitlements(["pro"]));
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();

  const result = await kl.refreshAfterUpgrade(350, 100);

  expect(result).toBe(false);
  expect(calls(), "must have polled more than once before timing out").toBeGreaterThan(1);
});

test("(4) a definitive rejection mid-poll drives the manager to invalid -> true", async () => {
  const store = await seededLicensedStore(60, ["pro"]);
  let call = 0;
  const t: Transport = {
    async postJson() {
      call++;
      // First poll: nothing changed yet (webhook hasn't landed). Second poll: the
      // real worker wire shape for a dashboard revoke -- 422, valid:false, no lease.
      if (call === 1) return { kind: "response", status: 200, body: okBodyWithEntitlements(["pro"]) };
      return { kind: "response", status: 422, body: JSON.stringify({ valid: false, reason: "revoked", error: "License has been revoked" }) };
    },
    async get() { return { kind: "terminal", error: "n/a" }; },
  };
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();
  expect(kl.state()).toEqual({ kind: "Licensed" }); // sanity

  const result = await kl.refreshAfterUpgrade(1_000, 100);

  expect(result).toBe(true);
  expect(kl.state(), "a definitive rejection must drive the manager to invalid").not.toEqual({ kind: "Licensed" });
  expect(kl.cachedLease).toBeNull();
});

test("(5) an already-aborted signal returns false quickly without polling further", async () => {
  const store = await seededLicensedStore(60, ["pro"]);
  // Same entitlements every time, so the only way this resolves before the 1s timeout
  // is via the abort check.
  const { t, calls } = countingTransport(200, okBodyWithEntitlements(["pro"]));
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();
  const controller = new AbortController();
  controller.abort();

  const start = performance.now();
  const result = await kl.refreshAfterUpgrade(1_000, 100, controller.signal);
  const elapsed = performance.now() - start;

  expect(result).toBe(false);
  expect(calls(), "must not poll repeatedly once aborted").toBeLessThanOrEqual(1);
  expect(elapsed, "must return well before the 1s timeout").toBeLessThan(500);
});

test("(6) a network blip mid-poll does not downgrade, keeps polling until the webhook lands", async () => {
  const store = await seededLicensedStore(2 * 86400, ["pro"]); // well within the offline cap
  let call = 0;
  const t: Transport = {
    async postJson() {
      call++;
      if (call === 1) return { kind: "terminal", error: "offline" }; // transient blip
      return { kind: "response", status: 200, body: okBodyWithEntitlements(["pro", "pro-plus"]) };
    },
    async get() { return { kind: "terminal", error: "n/a" }; },
  };
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();

  const result = await kl.refreshAfterUpgrade(1_000, 100);

  expect(result).toBe(true);
  expect(call, "the blip should not have stopped polling").toBe(2);
  expect(kl.state(), "a transient blip must not downgrade").not.toEqual({ kind: "Invalid" });
  expect(kl.cachedLease?.entitlements).toEqual(["pro", "pro-plus"]);
});
