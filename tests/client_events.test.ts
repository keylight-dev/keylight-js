import { test, expect } from "vitest";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import type { Transport } from "../src/transport.js";

const ok: Transport = { async postJson() { return { kind: "response", status: 200, body: "{}" }; }, async get() { return { kind: "terminal", error: "x" }; } };

test("startTrial sets trial_start once; checkTrial reflects it", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", trialDurationDays: 7, transport: ok, store: new MemoryStore() });
  await kl.load();
  await kl.startTrial();
  expect(kl.checkTrial().kind).toBe("active");
});

test("isClockManipulated true when last_seen is far in the future", async () => {
  const store = new MemoryStore();
  await store.set(ACCOUNT.LAST_SEEN, String(Math.floor(Date.now() / 1000) + 7200));
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: ok, store });
  await kl.load();
  expect(kl.isClockManipulated()).toBe(true);
});

test("reportKeylessState debounces within 24h for the same state", async () => {
  let calls = 0;
  const t: Transport = { async postJson() { calls++; return { kind: "response", status: 200, body: "{}" }; }, async get() { return { kind: "terminal", error: "x" }; } };
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: t, store: new MemoryStore() });
  await kl.load();
  await kl.reportKeylessState("free_tier");
  await kl.reportKeylessState("free_tier");
  expect(calls).toBe(1);
});

test("subscribe / on receive lifecycle events; unsubscribe stops them", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: ok, store: new MemoryStore() });
  const seen: string[] = [];
  const off = kl.on("Restored", () => seen.push("Restored"));
  (kl as unknown as { fire: (e: string) => void }).fire("Restored");
  off();
  (kl as unknown as { fire: (e: string) => void }).fire("Restored");
  expect(seen).toEqual(["Restored"]); // only the first fire, after unsubscribe nothing
});

test("subscribe receives the current state on each fire", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", freeTierEnabled: true, transport: ok, store: new MemoryStore() });
  await kl.load();
  const states: string[] = [];
  kl.subscribe((s) => states.push(s.kind));
  (kl as unknown as { fire: (e: string) => void }).fire("Restored");
  expect(states).toEqual(["FreeTier"]); // no license + free tier -> FreeTier
});

test("startTrial seeds a free-tier instance id (Rust parity for conversion linking)", async () => {
  const store = new MemoryStore();
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: ok, store });
  await kl.startTrial();
  expect(await store.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).toBeTruthy();
});

test("reportKeylessState includes machine_hash when a machine id is available", async () => {
  let captured: string | null = null;
  const t: Transport = {
    async postJson(_url, _headers, body) { captured = body; return { kind: "response", status: 200, body: "{}" }; },
    async get() { return { kind: "terminal", error: "x" }; },
  };
  const kl = new Keylight({
    tenantId: "testco",
    productId: "testapp",
    transport: t,
    store: new MemoryStore(),
    machineId: () => "hardware-1",
  });
  await kl.load();
  await kl.reportKeylessState("free_tier");
  expect(captured).not.toBeNull();
  const body = JSON.parse(captured as unknown as string);
  expect(body.machine_hash).toBe("8e8871112f28cabda180ada131d0b4f4f07c72fb47c5d884edbe32812885b22a");
});

test("reportKeylessState omits machine_hash when no machine id is available", async () => {
  let captured: string | null = null;
  const t: Transport = {
    async postJson(_url, _headers, body) { captured = body; return { kind: "response", status: 200, body: "{}" }; },
    async get() { return { kind: "terminal", error: "x" }; },
  };
  const kl = new Keylight({
    tenantId: "testco",
    productId: "testapp",
    transport: t,
    store: new MemoryStore(),
    machineId: () => null,
  });
  await kl.load();
  await kl.reportKeylessState("free_tier");
  expect(captured).not.toBeNull();
  const body = JSON.parse(captured as unknown as string);
  expect("machine_hash" in body).toBe(false);
});
