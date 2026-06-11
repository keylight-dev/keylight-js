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

test("account keys match the Rust contract (exhaustive)", () => {
  expect(ACCOUNT).toEqual({
    LICENSE_KEY: "license_key",
    INSTANCE_ID: "instance_id",
    LEASE: "lease",
    LICENSE_EXPIRES_AT: "license_expires_at",
    LAST_SEEN: "last_seen",
    LAST_VALIDATED_ONLINE: "last_validated_online",
    TRIAL_START: "trial_start",
    FREE_TIER_INSTANCE_ID: "free_tier_instance_id",
    KEYLESS_LAST_STATE: "keyless_last_state",
    LAST_KEYLESS_PING_AT: "last_keyless_ping_at",
  });
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

test("fs store actually persists to disk (cold re-read by a second instance)", async () => {
  const tmpFile = path.join(os.tmpdir(), `keylight-store-cold-${Math.random().toString(36).slice(2)}.json`);
  try {
    await new FsStore(tmpFile, fs).set(ACCOUNT.LICENSE_KEY, "persisted-1");
    // A fresh instance must read the flushed value from disk, not from memory.
    const cold = new FsStore(tmpFile, fs);
    expect(await cold.get(ACCOUNT.LICENSE_KEY)).toBe("persisted-1");
  } finally {
    await fs.unlink(tmpFile).catch(() => {/* already gone */});
  }
});

test("fs store drops non-string values from a corrupt file", async () => {
  const tmpFile = path.join(os.tmpdir(), `keylight-store-corrupt-${Math.random().toString(36).slice(2)}.json`);
  try {
    await fs.writeFile(tmpFile, JSON.stringify({ [ACCOUNT.LICENSE_KEY]: "ok", bad: 42, alsoBad: null }));
    const s = new FsStore(tmpFile, fs);
    expect(await s.get(ACCOUNT.LICENSE_KEY)).toBe("ok");
    expect(await s.get("bad")).toBeNull();
    expect(await s.get("alsoBad")).toBeNull();
  } finally {
    await fs.unlink(tmpFile).catch(() => {/* already gone */});
  }
});
