import { test, expect } from "vitest";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import type { Transport } from "../src/transport.js";

function transportReturning(body: string): Transport {
  return { async postJson() { return { kind: "response", status: 200, body }; }, async get() { return { kind: "terminal", error: "n/a" }; } };
}

test("invalid key format short-circuits without a network call", async () => {
  let called = false;
  const t: Transport = { async postJson() { called = true; return { kind: "response", status: 200, body: "{}" }; }, async get() { return { kind: "terminal", error: "x" }; } };
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: t, store: new MemoryStore() });
  const r = await kl.activate("bad_key");
  expect(r.activated).toBe(false);
  expect(called).toBe(false);
});

test("activated:false response surfaces the server error", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: transportReturning(`{"activated":false,"error":"seat limit"}`), store: new MemoryStore() });
  const r = await kl.activate("ABCD-1234");
  expect(r.activated).toBe(false);
  expect(r.error).toBe("seat limit");
});

test("successful activation persists key + instance id", async () => {
  const store = new MemoryStore();
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: transportReturning(`{"activated":true,"instance_id":"srv-1","license_expires_at":null,"lease":null}`), store });
  const r = await kl.activate("ABCD-1234");
  expect(r.activated).toBe(true);
  expect(r.instanceId).toBe("srv-1");
  expect(await store.get(ACCOUNT.LICENSE_KEY)).toBe("ABCD-1234");
  expect(await store.get(ACCOUNT.INSTANCE_ID)).toBe("srv-1");
});
