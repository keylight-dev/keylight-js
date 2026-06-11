import { test, expect } from "vitest";
import { Keylight } from "../src/client.js";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import type { Transport } from "../src/transport.js";

async function seeded() {
  const store = new MemoryStore();
  await store.set(ACCOUNT.LICENSE_KEY, "ABCD-1234");
  await store.set(ACCOUNT.INSTANCE_ID, "srv-1");
  return store;
}
const respT = (body: string, status = 200): Transport => ({ async postJson() { return { kind: "response", status, body }; }, async get() { return { kind: "terminal", error: "x" }; } });

test("validate with no stored license throws NoStoredLicense", async () => {
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: respT("{}"), store: new MemoryStore() });
  await expect(kl.validate()).rejects.toThrow(/no stored license/i);
});

test("valid:true persists expiry + last_validated_online", async () => {
  const store = await seeded();
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: respT(`{"valid":true,"license_expires_at":999,"lease":null}`), store });
  const r = await kl.validate();
  expect(r.valid).toBe(true);
  expect(await store.get(ACCOUNT.LICENSE_EXPIRES_AT)).toBe("999");
  expect(await store.get(ACCOUNT.LAST_VALIDATED_ONLINE)).not.toBeNull();
});

test("deactivate clears all account keys", async () => {
  const store = await seeded();
  const kl = new Keylight({ tenantId: "t", productId: "p", transport: respT("{}"), store });
  await kl.deactivate();
  expect(await store.get(ACCOUNT.LICENSE_KEY)).toBeNull();
  expect(await store.get(ACCOUNT.INSTANCE_ID)).toBeNull();
});
