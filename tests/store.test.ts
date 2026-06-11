import { test, expect, afterEach } from "vitest";
import { MemoryStore, FsStore, ACCOUNT } from "../src/store.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

test("memory store round-trips and removes", async () => {
  const s = new MemoryStore();
  expect(await s.get(ACCOUNT.LICENSE_KEY)).toBeNull();
  await s.set(ACCOUNT.LICENSE_KEY, "K-1");
  expect(await s.get(ACCOUNT.LICENSE_KEY)).toBe("K-1");
  await s.remove(ACCOUNT.LICENSE_KEY);
  expect(await s.get(ACCOUNT.LICENSE_KEY)).toBeNull();
});

test("account keys match the Rust contract", () => {
  expect(ACCOUNT.FREE_TIER_INSTANCE_ID).toBe("free_tier_instance_id");
  expect(ACCOUNT.LAST_VALIDATED_ONLINE).toBe("last_validated_online");
});

test("fs store round-trips and removes via temp file", async () => {
  const tmpFile = path.join(os.tmpdir(), `keylight-store-test-${Math.random().toString(36).slice(2)}.json`);
  try {
    const s = new FsStore(tmpFile, fs);
    expect(await s.get(ACCOUNT.INSTANCE_ID)).toBeNull();
    await s.set(ACCOUNT.INSTANCE_ID, "test-instance-42");
    expect(await s.get(ACCOUNT.INSTANCE_ID)).toBe("test-instance-42");
    await s.remove(ACCOUNT.INSTANCE_ID);
    expect(await s.get(ACCOUNT.INSTANCE_ID)).toBeNull();
    // Multiple keys coexist
    await s.set(ACCOUNT.LICENSE_KEY, "K-2");
    await s.set(ACCOUNT.LEASE, "lease-blob");
    expect(await s.get(ACCOUNT.LICENSE_KEY)).toBe("K-2");
    expect(await s.get(ACCOUNT.LEASE)).toBe("lease-blob");
  } finally {
    await fs.unlink(tmpFile).catch(() => {/* already gone */});
  }
});
