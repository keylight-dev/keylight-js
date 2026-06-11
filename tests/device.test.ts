import { test, expect } from "vitest";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import { ensureInstanceId } from "../src/device.js";

test("generates once, then reuses the persisted id", async () => {
  const s = new MemoryStore();
  const a = await ensureInstanceId(s, ACCOUNT.FREE_TIER_INSTANCE_ID);
  const b = await ensureInstanceId(s, ACCOUNT.FREE_TIER_INSTANCE_ID);
  expect(a).toBe(b);
  expect(a).toMatch(/[0-9a-f-]{36}/);
});

test("respects an override", async () => {
  const s = new MemoryStore();
  const id = await ensureInstanceId(s, ACCOUNT.FREE_TIER_INSTANCE_ID, "fixed-123");
  expect(id).toBe("fixed-123");
});
