import { test, expect } from "vitest";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import type { Transport } from "../src/transport.js";

const noTransport: Transport = { async postJson() { return { kind: "terminal", error: "x" }; }, async get() { return { kind: "terminal", error: "x" }; } };

test("hasStoredLicense + cachedLicenseKey reflect the store after load()", async () => {
  const store = new MemoryStore();
  await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: noTransport, store });
  await kl.load();
  expect(kl.hasStoredLicense()).toBe(true);
  expect(kl.cachedLicenseKey).toBe("ABCD-1234");
});

test("no lease + free tier on -> FreeTier", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", freeTierEnabled: true, transport: noTransport, store: new MemoryStore() });
  await kl.load();
  expect(kl.state()).toEqual({ kind: "FreeTier" });
});

test("upgradeUrl is null without a key, set with one", async () => {
  const store = new MemoryStore();
  const kl = new Keylight({ tenantId: "acme", productId: "notes", transport: noTransport, store });
  await kl.load();
  expect(kl.upgradeUrl).toBeNull();
  await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234"); kl["cache"].set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
  expect(kl.upgradeUrl).toBe("https://portal.keylight.dev/p/acme/upgrade/notes?key=ABCD-1234");
});

// A structurally-valid lease that is NOT signed by any configured trusted key, far-future expiry.
// (Trusted-lease behavior within the offline window is covered by the T19 live tests.)
const untrustedLease = JSON.stringify({ kid: "k1", licenseKeyHash: "h", instanceId: "i", issuedAt: 1, expiresAt: 9999999999, status: "active", signature: "AA", entitlements: ["pro"] });

test("cachedLease/hasEntitlement gate out an untrusted lease; state() still resolves via raw lease", async () => {
  const store = new MemoryStore();
  await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
  await store.set(ACCOUNT.LEASE, untrustedLease);
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: noTransport, store }); // no trustedKeys
  await kl.load();
  expect(kl.cachedLease).toBeNull();          // gated: untrusted -> null
  expect(kl.hasEntitlement("pro")).toBe(false); // entitlement check goes through the gate
  expect(kl.state()).toEqual({ kind: "Expired" }); // state() uses raw lease + hadLicense -> Expired
});

test("maxOfflineDays gate: cachedLease is null when no online validation was recorded", async () => {
  const store = new MemoryStore();
  await store.set(ACCOUNT.LEASE, untrustedLease);
  const kl = new Keylight({ tenantId: "t", productId: "p", maxOfflineDays: 7, transport: noTransport, store });
  await kl.load();
  expect(kl.cachedLease).toBeNull(); // offline gate short-circuits before trust check
});
