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
