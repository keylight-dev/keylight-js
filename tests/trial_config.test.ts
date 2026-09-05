/**
 * Trial length and free tier are settings the **server** owns; the values passed
 * to `new Keylight({...})` are only a seed for an install that has never reached
 * the server.
 *
 * Resolution order is server value → local seed → 0. These are the tests that
 * caught real bugs in the C++ port rather than the ones that restate the
 * implementation — see `keylight-cpp`'s
 * `docs/superpowers/specs/2026-09-05-trial-parity-handoff.md`.
 */
import { test, expect } from "vitest";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import type { Transport } from "../src/transport.js";

const nowSecs = () => Math.floor(Date.now() / 1000);

/** Answers every call — POST and GET — with one body, and records the paths it
 *  was asked for so a test can assert what the client did *not* call. */
function scripted(body: string, status = 200) {
  const paths: string[] = [];
  const t: Transport = {
    async postJson(url) { paths.push(url); return { kind: "response", status, body }; },
    async get(url) { paths.push(url); return { kind: "response", status, body }; },
  };
  return { transport: t, paths };
}

function client(opts: { seedDays?: number; seedFreeTier?: boolean; body?: string; status?: number; store?: MemoryStore }) {
  const store = opts.store ?? new MemoryStore();
  const s = scripted(opts.body ?? "{}", opts.status);
  const kl = new Keylight({
    tenantId: "t",
    productId: "p",
    trialDurationDays: opts.seedDays ?? 14,
    freeTierEnabled: opts.seedFreeTier ?? false,
    transport: s.transport,
    store,
    keylessHeartbeatMs: null,
  });
  return { kl, store, paths: s.paths };
}

async function seedTrialStart(store: MemoryStore, daysAgo: number) {
  await store.set(ACCOUNT.TRIAL_START, String(nowSecs() - daysAgo * 86400));
}

// ---------------------------------------------------------------- resolution

test("a server duration grants a trial when the seed is 0", async () => {
  const store = new MemoryStore();
  await seedTrialStart(store, 3);
  const { kl } = client({ seedDays: 0, body: `{"trial_duration_days":14}`, store });

  await kl.fetchConfig();

  expect(kl.effectiveTrialDurationDays()).toBe(14);
  expect(kl.checkTrial()).toEqual({ kind: "active", daysLeft: 11 });
});

test("a server 0 turns off a seed-enabled trial — the direction a tenant notices", async () => {
  const store = new MemoryStore();
  await seedTrialStart(store, 1);
  const { kl } = client({ seedDays: 14, body: `{"trial_duration_days":0}`, store });

  await kl.fetchConfig();

  expect(kl.effectiveTrialDurationDays()).toBe(0);
  expect(kl.checkTrial()).toEqual({ kind: "expired" });
});

test("an absent config falls through to the seed, not to 0", async () => {
  const { kl } = client({ seedDays: 14, seedFreeTier: true, body: "{}" });
  await kl.load();

  expect(kl.effectiveTrialDurationDays()).toBe(14);
  expect(kl.effectiveFreeTierEnabled()).toBe(true);
});

// -------------------------------------------------------------------- stamp

test("startTrial stamps the clock even at a zero duration", async () => {
  const { kl, store } = client({ seedDays: 0, body: `{"trial_duration_days":14}` });

  await kl.startTrial();

  expect(await store.get(ACCOUNT.TRIAL_START)).not.toBeNull();
  expect(kl.checkTrial()).toEqual({ kind: "expired" });

  // The tenant enables a 14-day trial. The window runs from the stamp that
  // already exists — nothing calls startTrial() a second time.
  await kl.fetchConfig();
  expect(kl.checkTrial()).toEqual({ kind: "active", daysLeft: 14 });
});

test("startTrial mints the instance id even at a zero duration", async () => {
  const { kl, store } = client({ seedDays: 0 });
  await kl.startTrial();
  expect(await store.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).not.toBeNull();
});

test("an old stamp is honoured, never restarted", async () => {
  const store = new MemoryStore();
  await seedTrialStart(store, 60);
  const { kl } = client({ seedDays: 0, body: `{"trial_duration_days":14}`, store });

  await kl.fetchConfig();

  // Assert the duration landed first, or this passes for the wrong reason: a
  // seed of 0 also resolves to expired.
  expect(kl.effectiveTrialDurationDays()).toBe(14);
  expect(kl.checkTrial()).toEqual({ kind: "expired" });
});

test("startTrial does not restart an existing stamp", async () => {
  const store = new MemoryStore();
  await seedTrialStart(store, 10);
  const before = await store.get(ACCOUNT.TRIAL_START);
  const { kl } = client({ seedDays: 14, store });

  await kl.startTrial();

  expect(await store.get(ACCOUNT.TRIAL_START)).toBe(before);
  expect(kl.checkTrial()).toEqual({ kind: "active", daysLeft: 4 });
});

// -------------------------------------------------------------- persistence

test("a server 0 survives a relaunch as 0, not as the seed", async () => {
  const store = new MemoryStore();
  const first = client({ seedDays: 14, body: `{"trial_duration_days":0}`, store });
  await first.kl.fetchConfig();

  const relaunched = client({ seedDays: 14, body: "{}", store });
  await relaunched.kl.load();

  expect(relaunched.kl.effectiveTrialDurationDays()).toBe(0);
});

test("a server free_tier_enabled:false survives against a seed of true", async () => {
  const store = new MemoryStore();
  const first = client({ seedDays: 14, seedFreeTier: true, body: `{"free_tier_enabled":false}`, store });
  await first.kl.fetchConfig();

  const relaunched = client({ seedDays: 14, seedFreeTier: true, body: "{}", store });
  await relaunched.kl.load();

  expect(relaunched.kl.effectiveFreeTierEnabled()).toBe(false);
  expect(relaunched.kl.productFreeTierEnabled()).toBe(false);
});

test("a response with no config fields leaves the cache alone", async () => {
  const store = new MemoryStore();
  const first = client({ seedDays: 30, body: `{"trial_duration_days":7,"free_tier_enabled":true}`, store });
  await first.kl.fetchConfig();

  const older = client({ seedDays: 30, body: "{}", store });
  await older.kl.fetchConfig();

  expect(older.kl.effectiveTrialDurationDays()).toBe(7);
  expect(older.kl.effectiveFreeTierEnabled()).toBe(true);
});

test("a partial response merges rather than replaces", async () => {
  const store = new MemoryStore();
  const first = client({ seedDays: 30, body: `{"trial_duration_days":7,"free_tier_enabled":true}`, store });
  await first.kl.fetchConfig();

  const partial = client({ seedDays: 30, body: `{"trial_duration_days":21}`, store });
  await partial.kl.fetchConfig();

  expect(partial.kl.effectiveTrialDurationDays()).toBe(21);
  expect(partial.kl.effectiveFreeTierEnabled()).toBe(true);
});

test("a failed fetch keeps the cached value rather than falling back to the seed", async () => {
  const store = new MemoryStore();
  const first = client({ seedDays: 30, body: `{"trial_duration_days":7}`, store });
  await first.kl.fetchConfig();

  const offline = client({ seedDays: 30, body: `{"error":"nope"}`, status: 500, store });
  await offline.kl.fetchConfig();

  expect(offline.kl.effectiveTrialDurationDays()).toBe(7);
});

// --------------------------------------------------------------------- wire

test("validate carries the config and it is absorbed", async () => {
  const store = new MemoryStore();
  await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
  await store.set(ACCOUNT.INSTANCE_ID, "srv-1");
  const { kl } = client({
    seedDays: 30,
    body: `{"valid":true,"trial_duration_days":21,"free_tier_enabled":true}`,
    store,
  });

  await kl.validate();

  expect(kl.effectiveTrialDurationDays()).toBe(21);
  expect(kl.effectiveFreeTierEnabled()).toBe(true);
});

test("the keyless beacon response carries the config", async () => {
  const { kl } = client({ seedDays: 30, body: `{"trial_duration_days":7}` });

  await kl.reportKeylessState("trial");

  expect(kl.effectiveTrialDurationDays()).toBe(7);
});

test("resolving state does not fetch /config", async () => {
  const { kl, paths } = client({ seedDays: 14, body: `{"trial_duration_days":7}` });

  await kl.startTrial();
  kl.state();
  kl.checkTrial();

  expect(paths.some((p) => p.endsWith("/config"))).toBe(false);
});

// ---------------------------------------------------------------- telemetry

test("activate and validate report the compiled-in seed, not the effective value", async () => {
  const bodies: string[] = [];
  const store = new MemoryStore();
  await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
  await store.set(ACCOUNT.INSTANCE_ID, "srv-1");
  const transport: Transport = {
    async postJson(_url, _h, body) { bodies.push(body); return { kind: "response", status: 200, body: `{"valid":true,"trial_duration_days":7}` }; },
    async get() { return { kind: "terminal", error: "x" }; },
  };
  const kl = new Keylight({ tenantId: "t", productId: "p", trialDurationDays: 30, transport, store, keylessHeartbeatMs: null });

  await kl.validate();

  // The server now says 7, but the diagnostic value must stay 30 — echoing the
  // server's own number back would diagnose nothing.
  expect(kl.effectiveTrialDurationDays()).toBe(7);
  expect(JSON.parse(bodies[0]).sdk_trial_duration_days).toBe(30);
});
