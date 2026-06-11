import { test, expect } from "vitest";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import type { Transport } from "../src/transport.js";

const noNet: Transport = { async postJson() { return { kind: "terminal", error: "x" }; }, async get() { return { kind: "terminal", error: "x" }; } };

test("isEntitled: false for free tier / invalid, true for an active trial", async () => {
  const free = new Keylight({ tenantId: "t", productId: "p", freeTierEnabled: true, transport: noNet, store: new MemoryStore() });
  await free.load();
  expect(free.isEntitled).toBe(false); // FreeTier is not "entitled"

  const store = new MemoryStore();
  await store.set(ACCOUNT.TRIAL_START, String(Math.floor(Date.now() / 1000))); // trial just started
  const trial = new Keylight({ tenantId: "t", productId: "p", trialDurationDays: 7, transport: noNet, store });
  await trial.load();
  expect(trial.state().kind).toBe("Trial");
  expect(trial.isEntitled).toBe(true);
});

test("productFreeTierEnabled reflects config", async () => {
  expect(new Keylight({ tenantId: "t", productId: "p", freeTierEnabled: true, transport: noNet, store: new MemoryStore() }).productFreeTierEnabled()).toBe(true);
  expect(new Keylight({ tenantId: "t", productId: "p", transport: noNet, store: new MemoryStore() }).productFreeTierEnabled()).toBe(false);
});

test("isValidKeyFormat uses the configured prefix", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", keyPrefix: "PRO-", transport: noNet, store: new MemoryStore() });
  expect(kl.isValidKeyFormat("pro-1")).toBe(true);  // case-insensitive prefix
  expect(kl.isValidKeyFormat("LITE-1")).toBe(false);
});

test("refresh(force=false) defers to refreshIfNeeded; no license -> null", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: noNet, store: new MemoryStore() });
  await kl.load();
  expect(await kl.refresh(false)).toBeNull(); // no stored license
  expect(await kl.refresh(true)).toBeNull();  // force, still no stored license -> null
});

test("freeTierInstanceIdIfPresent returns null until one is created, then the value", async () => {
  const store = new MemoryStore();
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: noNet, store });
  await kl.load();
  expect(await kl.freeTierInstanceIdIfPresent()).toBeNull();
  const id = await kl.freeTierInstanceId();       // creates it
  expect(await kl.freeTierInstanceIdIfPresent()).toBe(id);
});

test("reportFreeTier delegates to reportKeylessState('free_tier')", async () => {
  let body = "";
  const t: Transport = { async postJson(_u, _h, b) { body = b; return { kind: "response", status: 200, body: "{}" }; }, async get() { return { kind: "terminal", error: "x" }; } };
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: t, store: new MemoryStore() });
  await kl.load();
  await kl.reportFreeTier();
  expect(JSON.parse(body).state).toBe("free_tier");
});
