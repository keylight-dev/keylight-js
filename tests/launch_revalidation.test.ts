// Mirrors the Swift reference suite's LaunchRevalidationTests, adapted to the JS SDK's
// store-derived `state()` (no optimistic-seed / paywall-flash handling needed here —
// see docs/superpowers/specs/2026-07-08-cross-sdk-revocation-parity-design.md).
import { test, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import { leasePayload, type Lease } from "../src/lease.js";
import type { Transport } from "../src/transport.js";

const nowSecs = () => Math.floor(Date.now() / 1000);

// Real ed25519 keypair so state()'s signature verification actually trusts the lease.
// sha512Sync is installed as a side effect of importing verifier.js (transitively, via
// client.js) — see verifier.ts's module-scope `ed.etc.sha512Sync = ...`.
const privKey = ed.utils.randomPrivateKey();
const pubKeyB64 = Buffer.from(ed.getPublicKey(privKey)).toString("base64");
const TRUSTED_KEYS = { k1: pubKeyB64 };

function signedLease(status: string, expiresAt: number): Lease {
  const lease: Lease = { kid: "k1", licenseKeyHash: "h", instanceId: "srv-1", issuedAt: nowSecs() - 3600, expiresAt, status, signature: "", entitlements: ["pro"] };
  const sig = ed.sign(new TextEncoder().encode(leasePayload(lease)), privKey);
  lease.signature = Buffer.from(sig).toString("base64");
  return lease;
}

/** A licensed store: signed+trusted "active" lease, far future expiry, validated
 *  online `agoSecs` seconds ago. */
async function seededLicensedStore(agoSecs: number): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
  await store.set(ACCOUNT.INSTANCE_ID, "srv-1");
  await store.set(ACCOUNT.LEASE, JSON.stringify(signedLease("active", nowSecs() + 30 * 86400)));
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

// A transport whose failure is "terminal" (per transport.ts, a non-retryable TypeError
// class of failure) so post() throws NetworkError immediately with no retry/backoff sleep.
const terminalFailureTransport: Transport = {
  async postJson() { return { kind: "terminal", error: "offline" }; },
  async get() { return { kind: "terminal", error: "n/a" }; },
};

// Fails the test if the network is actually hit — used to prove state()/cachedLease are
// pure store reads with no server round-trip.
const neverCalledTransport: Transport = {
  async postJson() { throw new Error("must not call the network"); },
  async get() { throw new Error("must not call the network"); },
};

test("(a) revoke is caught on the next launch, even with a fresh cached lease (real worker wire shape: HTTP 422, no valid/lease field)", async () => {
  const store = await seededLicensedStore(60); // validated a minute ago -> well within refreshIfNeeded's 5m/6h gates
  const { t, calls } = countingTransport(422, JSON.stringify({ error: "License has been revoked" }));
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();
  expect(kl.state()).toEqual({ kind: "Licensed" }); // sanity: starts out licensed

  await kl.checkOnLaunch();

  expect(calls(), "checkOnLaunch must always validate, not defer to the staleness-gated refreshIfNeeded").toBe(1);
  expect(kl.state()).not.toEqual({ kind: "Licensed" });
  expect(kl.isEntitled).toBe(false);
});

test("(b) a transient failure on launch keeps access within the offline cap", async () => {
  const store = await seededLicensedStore(2 * 86400); // validated 2 days ago, well within the 15-day default cap
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: terminalFailureTransport, store });
  await kl.load();

  await expect(kl.checkOnLaunch()).resolves.toBeUndefined(); // must not throw / must not paywall on a transient error

  expect(kl.state()).toEqual({ kind: "Licensed" });
  expect(kl.isEntitled).toBe(true);
});

test("(c) offline past the 15-day cap denies via state(), even with a signed, unexpired cached lease present", async () => {
  const store = await seededLicensedStore(16 * 86400); // validated 16 days ago > default 15-day cap
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: neverCalledTransport, store });
  await kl.load();

  expect(kl.state()).not.toEqual({ kind: "Licensed" });
  expect(kl.isEntitled).toBe(false);
  expect(kl.cachedLease).toBeNull();
});

test("(d) maxOfflineDays: null disables the cap -- never denies for offline age", async () => {
  const store = await seededLicensedStore(1000 * 86400); // validated ~3 years ago
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, maxOfflineDays: null, transport: neverCalledTransport, store });
  await kl.load();

  expect(kl.state()).toEqual({ kind: "Licensed" });
  expect(kl.isEntitled).toBe(true);
  expect(kl.cachedLease).not.toBeNull();
});
