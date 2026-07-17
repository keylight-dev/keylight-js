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

test("stableDeviceId derives machine_hash on keyless, activate, and validate when no machine id", async () => {
  const bodies: string[] = [];
  const t: Transport = {
    async postJson(_url, _headers, body) { bodies.push(body); return { kind: "response", status: 200, body: `{"activated":true,"valid":true,"instance_id":"srv-1"}` }; },
    async get() { return { kind: "terminal", error: "x" }; },
  };
  const kl = new Keylight({
    tenantId: "testco",
    productId: "testapp",
    transport: t,
    store: new MemoryStore(),
    machineId: () => null,
    stableDeviceId: "user-42",
  });
  await kl.load();
  await kl.reportKeylessState("free_tier");
  await kl.activate("ABCD-1234");
  await kl.validate();
  expect(bodies).toHaveLength(3);
  for (const raw of bodies) {
    // sha256("keylight-keyless-machine-v1|testco|testapp|user-42") — same material as hardware ids.
    expect(JSON.parse(raw).machine_hash).toBe("1ef4ddc83063f31e15355544360699870411ca9f53b7b0d0e94280e2b64d07f9");
  }
});

test("stableDeviceId accepts an async function", async () => {
  let captured: string | null = null;
  const t: Transport = {
    async postJson(_url, _headers, body) { captured = body; return { kind: "response", status: 200, body: "{}" }; },
    async get() { return { kind: "terminal", error: "x" }; },
  };
  const kl = new Keylight({
    tenantId: "testco", productId: "testapp", transport: t, store: new MemoryStore(),
    machineId: () => null,
    stableDeviceId: async () => "user-42",
  });
  await kl.load();
  await kl.reportKeylessState("free_tier");
  const body = JSON.parse(captured as unknown as string);
  expect(body.machine_hash).toBe("1ef4ddc83063f31e15355544360699870411ca9f53b7b0d0e94280e2b64d07f9");
});

test("hardware machine id takes precedence over stableDeviceId", async () => {
  let captured: string | null = null;
  const t: Transport = {
    async postJson(_url, _headers, body) { captured = body; return { kind: "response", status: 200, body: "{}" }; },
    async get() { return { kind: "terminal", error: "x" }; },
  };
  const kl = new Keylight({
    tenantId: "testco", productId: "testapp", transport: t, store: new MemoryStore(),
    machineId: () => "hardware-1",
    stableDeviceId: "user-42",
  });
  await kl.load();
  await kl.reportKeylessState("free_tier");
  const body = JSON.parse(captured as unknown as string);
  // Pinned hardware vector — unchanged by the presence of stableDeviceId.
  expect(body.machine_hash).toBe("8e8871112f28cabda180ada131d0b4f4f07c72fb47c5d884edbe32812885b22a");
});

test("null/empty stableDeviceId behaves as unset — machine_hash omitted", async () => {
  for (const stable of [() => null, () => "", ""] as const) {
    const bodies: string[] = [];
    const t: Transport = {
      async postJson(_url, _headers, body) { bodies.push(body); return { kind: "response", status: 200, body: `{"activated":true,"valid":true,"instance_id":"srv-1"}` }; },
      async get() { return { kind: "terminal", error: "x" }; },
    };
    const kl = new Keylight({
      tenantId: "testco", productId: "testapp", transport: t, store: new MemoryStore(),
      machineId: () => null,
      stableDeviceId: stable,
    });
    await kl.load();
    await kl.reportKeylessState("free_tier");
    await kl.activate("ABCD-1234");
    await kl.validate();
    expect(bodies).toHaveLength(3);
    for (const raw of bodies) expect("machine_hash" in JSON.parse(raw)).toBe(false);
  }
});

test("reportKeylessState returns true on success and true on the debounced no-op", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: ok, store: new MemoryStore(), machineId: () => null });
  await kl.load();
  expect(await kl.reportKeylessState("free_tier")).toBe(true); // sent, 200
  expect(await kl.reportKeylessState("free_tier")).toBe(true); // debounced, already reported
});

test("reportKeylessState returns false on failure and does NOT persist the debounce state", async () => {
  const bad: Transport = { async postJson() { return { kind: "response", status: 400, body: "{}" }; }, async get() { return { kind: "terminal", error: "x" }; } };
  const store = new MemoryStore();
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: bad, store, machineId: () => null });
  await kl.load();
  expect(await kl.reportKeylessState("free_tier")).toBe(false);
  expect(await store.get(ACCOUNT.KEYLESS_LAST_STATE)).toBeNull();
  expect(await store.get(ACCOUNT.LAST_KEYLESS_PING_AT)).toBeNull();
});

test("reportFreeTier surfaces the beacon result", async () => {
  const bad: Transport = { async postJson() { return { kind: "terminal", error: "offline" }; }, async get() { return { kind: "terminal", error: "x" }; } };
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: bad, store: new MemoryStore(), machineId: () => null });
  await kl.load();
  expect(await kl.reportFreeTier()).toBe(false);
});

test("activate and validate include machine_hash when a machine id is available (cross-SDK vector)", async () => {
  const bodies: string[] = [];
  const t: Transport = {
    async postJson(_url, _headers, body) { bodies.push(body); return { kind: "response", status: 200, body: `{"activated":true,"valid":true,"instance_id":"srv-1"}` }; },
    async get() { return { kind: "terminal", error: "x" }; },
  };
  const kl = new Keylight({ tenantId: "testco", productId: "testapp", transport: t, store: new MemoryStore(), machineId: () => "hardware-1" });
  await kl.activate("ABCD-1234");
  await kl.validate();
  expect(bodies).toHaveLength(2);
  for (const raw of bodies) {
    // Same pinned vector as the keyless beacon test — hash material unchanged.
    expect(JSON.parse(raw).machine_hash).toBe("8e8871112f28cabda180ada131d0b4f4f07c72fb47c5d884edbe32812885b22a");
  }
});

test("activate and validate omit machine_hash when no machine id is available", async () => {
  const bodies: string[] = [];
  const t: Transport = {
    async postJson(_url, _headers, body) { bodies.push(body); return { kind: "response", status: 200, body: `{"activated":true,"valid":true,"instance_id":"srv-1"}` }; },
    async get() { return { kind: "terminal", error: "x" }; },
  };
  const kl = new Keylight({ tenantId: "testco", productId: "testapp", transport: t, store: new MemoryStore(), machineId: () => null });
  await kl.activate("ABCD-1234");
  await kl.validate();
  for (const raw of bodies) expect("machine_hash" in JSON.parse(raw)).toBe(false);
});
