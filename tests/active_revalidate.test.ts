// Mirrors the Swift reference suite's ActiveRevalidateTests (Tests/KeylightSDKTests/
// ActiveRevalidateTests.swift), adapted to the JS SDK's store-derived `state()`.
//
// `activeRevalidate()` is the foreground/active-use trigger: a FORCED validate that
// bypasses `refreshIfNeeded`'s staleness gates, debounced in memory at 60s, that
// downgrades on a definitive rejection but never on a network blip.
import { test, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import { leasePayload, type Lease } from "../src/lease.js";
import type { Transport } from "../src/transport.js";

const nowSecs = () => Math.floor(Date.now() / 1000);

// Real ed25519 keypair so state()'s signature verification actually trusts the lease
// (same setup as launch_revalidation.test.ts).
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

const okBody = () => JSON.stringify({ valid: true, license_expires_at: nowSecs() + 30 * 86400, lease: signedLease("active", nowSecs() + 30 * 86400) });

test("(1) no stored license key -> no-op, no network call", async () => {
  const { t, calls } = countingTransport(200, okBody());
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store: new MemoryStore() });
  await kl.load();

  await expect(kl.activeRevalidate()).resolves.toBeUndefined();

  expect(calls(), "no stored key must not hit the network").toBe(0);
});

test("(2) forces a validate even when refreshIfNeeded's staleness gates would skip it", async () => {
  const store = await seededLicensedStore(60); // validated a minute ago -> inside the 5m debounce
  const { t, calls } = countingTransport(200, okBody());
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();

  expect(await kl.refreshIfNeeded(), "sanity: refreshIfNeeded skips inside its 5m debounce").toBeNull();
  expect(calls()).toBe(0);

  await kl.activeRevalidate();

  expect(calls(), "activeRevalidate must bypass the staleness gates").toBe(1);
  expect(kl.state()).toEqual({ kind: "Licensed" });
});

test("(3) a second call inside the 60s window is debounced", async () => {
  const store = await seededLicensedStore(60);
  const { t, calls } = countingTransport(200, okBody());
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();

  await kl.activeRevalidate();
  await kl.activeRevalidate();

  expect(calls(), "second call within 60s should be debounced").toBe(1);
});

test("(4) the debounce is in memory only -- a fresh instance over the same store revalidates", async () => {
  const store = await seededLicensedStore(60);
  const { t, calls } = countingTransport(200, okBody());
  const first = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await first.load();
  await first.activeRevalidate();
  expect(calls()).toBe(1);

  // Simulates a process restart / page reload: same persistent store, new instance.
  const second = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await second.load();
  await second.activeRevalidate();

  expect(calls(), "the debounce must not survive a reload").toBe(2);
});

// The debounce suppresses revalidation, so anchoring it to the wall clock let a
// backwards clock jump suppress revocation enforcement for the size of the jump.
// On a licensing SDK that is an adversarial move, not just an NTP correction.
test("(4b) the debounce is immune to a backwards wall clock", async () => {
  const store = await seededLicensedStore(60);
  const { t, calls } = countingTransport(200, okBody());
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();

  await kl.activeRevalidate();
  expect(calls()).toBe(1);

  // Wind the wall clock back a day. A Date.now()-anchored debounce would now
  // compute a large negative elapsed time and suppress every subsequent call.
  const realNow = Date.now;
  Date.now = () => realNow() - 86_400_000;
  try {
    await kl.activeRevalidate();
  } finally {
    Date.now = realNow;
  }

  // Still debounced -- but by monotonic time, not the wall clock, so this is the
  // 60s window doing its job rather than the clock jump doing it.
  expect(calls(), "a clock jump must not change debounce behaviour").toBe(1);
});

// `performance.now()` starts near zero, so a 0 sentinel would read as "just ran"
// and swallow the first call of every process -- the one call that matters most,
// since it is the post-launch revocation check.
test("(4c) the very first call of a process is never suppressed", async () => {
  const store = await seededLicensedStore(60);
  const { t, calls } = countingTransport(200, okBody());
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();

  await kl.activeRevalidate();

  expect(calls(), "first activeRevalidate must always reach the network").toBe(1);
});

test("(5) a revoke (HTTP 422, valid:false) downgrades immediately", async () => {
  const store = await seededLicensedStore(60);
  // Real worker wire shape for a dashboard revoke: 422 with valid:false and no lease.
  const { t, calls } = countingTransport(422, JSON.stringify({ valid: false, reason: "revoked", error: "License has been revoked" }));
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();
  expect(kl.state()).toEqual({ kind: "Licensed" }); // sanity

  await kl.activeRevalidate();

  expect(calls()).toBe(1);
  expect(kl.state(), "a definitive rejection must downgrade").not.toEqual({ kind: "Licensed" });
  expect(kl.isEntitled).toBe(false);
  expect(kl.cachedLease).toBeNull();
});

test("(6) a network failure does NOT downgrade a live session", async () => {
  const store = await seededLicensedStore(2 * 86400); // well within the 15-day offline cap
  const { t, calls } = countingFailureTransport();
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();

  await expect(kl.activeRevalidate(), "must never throw at the call site").resolves.toBeUndefined();

  expect(calls()).toBe(1);
  expect(kl.state(), "a blip must keep last-known-good").toEqual({ kind: "Licensed" });
  expect(kl.isEntitled).toBe(true);
  expect(kl.cachedLease).not.toBeNull();
});

test("(7) a lifecycle subscriber sees the downgrade", async () => {
  const store = await seededLicensedStore(60);
  const { t } = countingTransport(422, JSON.stringify({ valid: false, error: "License has been revoked" }));
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();
  const seen: string[] = [];
  kl.subscribe((s) => seen.push(s.kind));

  await kl.activeRevalidate();

  expect(seen.length, "the state change must be published").toBeGreaterThan(0);
  expect(seen.at(-1)).not.toBe("Licensed");
});

test("(8) a tampered (known-kid, bad signature) served lease denies -- same triage as checkOnLaunch", async () => {
  const store = await seededLicensedStore(60);
  const good = signedLease("active", nowSecs() + 30 * 86400);
  const tampered = { ...good, entitlements: [...good.entitlements, "smuggled"] }; // payload changes, kid stays k1
  const { t } = countingTransport(200, JSON.stringify({ valid: true, license_expires_at: nowSecs() + 30 * 86400, lease: tampered }));
  const kl = new Keylight({ tenantId: "t", productId: "p", trustedKeys: TRUSTED_KEYS, transport: t, store });
  await kl.load();
  expect(kl.state()).toEqual({ kind: "Licensed" });
  const seen: string[] = [];
  kl.subscribe((s) => seen.push(s.kind));

  await expect(kl.activeRevalidate()).resolves.toBeUndefined();

  expect(kl.state(), "a forged lease must not keep the user entitled off the stale cached lease").not.toEqual({ kind: "Licensed" });
  expect(kl.isEntitled).toBe(false);
  // Unlike (7), this deny comes out of forcedRevalidate's catch (validate() threw before
  // its own reconciliation), so the catch path owns publishing the transition.
  expect(seen.length, "the throw-path deny must also publish the state change").toBeGreaterThan(0);
  expect(seen.at(-1)).not.toBe("Licensed");
});
