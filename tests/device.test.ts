import { test, expect } from "vitest";
import { MemoryStore, ACCOUNT } from "../src/store.js";
import { ensureInstanceId } from "../src/device.js";

test("generates once, then reuses the persisted id", async () => {
  const s = new MemoryStore();
  const a = await ensureInstanceId(s, ACCOUNT.FREE_TIER_INSTANCE_ID);
  const b = await ensureInstanceId(s, ACCOUNT.FREE_TIER_INSTANCE_ID);
  expect(a).toBe(b);
  // Strict RFC4122 v4: also verifies the version (4) and variant (8/9/a/b) nibbles.
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("respects an override", async () => {
  const s = new MemoryStore();
  const id = await ensureInstanceId(s, ACCOUNT.FREE_TIER_INSTANCE_ID, "fixed-123");
  expect(id).toBe("fixed-123");
});
