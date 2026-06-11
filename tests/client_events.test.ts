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

test("subscribe / on receive lifecycle events", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: ok, store: new MemoryStore() });
  const seen: string[] = [];
  kl.on("Restored", () => seen.push("Restored"));
  (kl as unknown as { fire: (e: string) => void }).fire("Restored");
  expect(seen).toEqual(["Restored"]);
});
