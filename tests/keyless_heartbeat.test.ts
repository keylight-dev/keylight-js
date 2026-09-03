// The keyless heartbeat — the client's own cadence for re-reporting a keyless
// device while the host process keeps running.
//
// Without it the beacon only goes out when the app calls `reportKeylessState`
// itself, which in practice is once at startup. An Electron app or a resident
// Node service therefore reports itself once and then looks dead to the
// dashboard for as long as it runs: `last_seen` never moves past `first_seen`
// and the reported app version freezes at whatever shipped that day.
import { test, expect, vi, afterEach } from "vitest";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import type { Transport, TransportOutcome, Header } from "../src/transport.js";

/** Transport that answers 200 to everything and records the URLs it was posted to. */
function recordingTransport() {
  const urls: string[] = [];
  const transport: Transport = {
    async postJson(url: string, _h: Header[], _b: string): Promise<TransportOutcome> {
      urls.push(url);
      return { kind: "response", status: 200, body: "{}" };
    },
    async get(): Promise<TransportOutcome> { return { kind: "terminal", error: "x" }; },
  };
  return { transport, urls, keylessCount: () => urls.filter((u) => u.endsWith("/keyless")).length };
}

/** A store already holding a just-started trial, so `state()` resolves to Trial. */
function trialStore() {
  const store = new MemoryStore();
  return store;
}

async function seedTrial(store: MemoryStore) {
  await store.set(ACCOUNT.TRIAL_START, String(Math.floor(Date.now() / 1000)));
}

/** Step the wall clock past the 24h debounce so the next tick is allowed to
 *  send again. The debounce lives in `reportKeylessState` and reads Date.now();
 *  the client's own cache backs the stored stamp, so moving the clock — not
 *  rewriting the store behind the cache — is what a real day passing looks
 *  like. The interval timer runs on the event loop and is unaffected. */
function advancePastDebounce() {
  const real = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => real + 25 * 60 * 60 * 1000);
}

// Deliberately on performance.now(): the tests move Date.now() forward by a day
// to lapse the debounce, and a deadline read off a frozen clock never expires.
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

const clients: Keylight[] = [];
function track(kl: Keylight): Keylight { clients.push(kl); return kl; }

afterEach(() => {
  for (const kl of clients.splice(0)) kl.stopKeylessHeartbeat();
  vi.restoreAllMocks();
});

test("keeps beaconing on its own while the app stays open", async () => {
  const { transport, keylessCount } = recordingTransport();
  const store = trialStore();
  await seedTrial(store);
  const kl = track(new Keylight({
    tenantId: "t", productId: "p", trialDurationDays: 7,
    transport, store, keylessHeartbeatMs: 20,
  }));

  await kl.checkOnLaunch();
  expect(await waitFor(() => keylessCount() >= 1)).toBe(true);

  // The app does nothing further. Once the debounce lapses, the next tick must
  // send again — that is the whole point of the heartbeat.
  advancePastDebounce();

  expect(await waitFor(() => keylessCount() >= 2)).toBe(true);
});

test("a licensed device sends no keyless beacon", async () => {
  const { transport, keylessCount } = recordingTransport();
  const store = new MemoryStore();
  const kl = track(new Keylight({
    tenantId: "t", productId: "p", trialDurationDays: 7,
    transport, store, keylessHeartbeatMs: 20,
  }));
  await kl.load();
  kl.startKeylessHeartbeat();

  // No trial seeded and no license: state is Expired/FreeTier, which DOES beacon.
  // Force the licensed case instead by asserting on a state that must not:
  vi.spyOn(kl, "state").mockReturnValue({ kind: "Licensed" });

  await new Promise((r) => setTimeout(r, 120));
  expect(keylessCount()).toBe(0);
});

test("stopKeylessHeartbeat ends the cadence", async () => {
  const { transport, keylessCount } = recordingTransport();
  const store = trialStore();
  await seedTrial(store);
  const kl = track(new Keylight({
    tenantId: "t", productId: "p", trialDurationDays: 7,
    transport, store, keylessHeartbeatMs: 20,
  }));

  await kl.checkOnLaunch();
  expect(await waitFor(() => keylessCount() >= 1)).toBe(true);

  kl.stopKeylessHeartbeat();
  const afterStop = keylessCount();
  advancePastDebounce();
  await new Promise((r) => setTimeout(r, 120));

  expect(keylessCount()).toBe(afterStop);
});

test("keylessHeartbeatMs: null opts out entirely", async () => {
  const { transport, keylessCount } = recordingTransport();
  const store = trialStore();
  await seedTrial(store);
  const kl = track(new Keylight({
    tenantId: "t", productId: "p", trialDurationDays: 7,
    transport, store, keylessHeartbeatMs: null,
  }));

  await kl.checkOnLaunch();
  advancePastDebounce();
  await new Promise((r) => setTimeout(r, 120));

  expect(keylessCount()).toBe(0);
});

// A 6-hour interval that keeps a `node` process alive would turn a one-shot
// script into a hang. Node's unref() detaches the timer from the event loop.
test("does not hold a Node process open", async () => {
  const { transport } = recordingTransport();
  const store = trialStore();
  await seedTrial(store);
  const unref = vi.fn();
  const spy = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as never);

  const kl = track(new Keylight({
    tenantId: "t", productId: "p", trialDurationDays: 7,
    transport, store, keylessHeartbeatMs: 20,
  }));
  kl.startKeylessHeartbeat();

  expect(spy).toHaveBeenCalled();
  expect(unref).toHaveBeenCalled();
});
