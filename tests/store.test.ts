import { test, expect, afterEach } from "vitest";
import { MemoryStore, FsStore, LocalStorageStore, IndexedDbStore, CookieStore, makeDefaultStore, ACCOUNT } from "../src/store.js";
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
    PRODUCT_CONFIG: "product_config",
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

test("makeDefaultStore ignores a stub localStorage that lacks getItem/setItem (Node 25 footgun)", async () => {
  const g = globalThis as Record<string, unknown>;
  const prev = g.localStorage;
  g.localStorage = {}; // mimic Node 25's stub: present but no getItem/setItem
  const ns = `keylight-test-${Math.random().toString(36).slice(2)}`;
  try {
    const s = await makeDefaultStore(ns);
    expect(s).not.toBeInstanceOf(LocalStorageStore); // would have crashed on first use
    await s.set("k", "v");                            // must be functional (FsStore/Memory)
    expect(await s.get("k")).toBe("v");
  } finally {
    if (prev === undefined) delete g.localStorage; else g.localStorage = prev;
    await fs.unlink(path.join(os.homedir(), `.${ns}.json`)).catch(() => {});
  }
});

// --- IndexedDbStore (against a minimal in-test fake IDB) ---

type Handler = (() => void) | null;
function fakeIdb() {
  const data = new Map<string, unknown>();
  function request<T>(result: T) {
    const req = { result, error: null as unknown, onsuccess: null as Handler, onerror: null as Handler };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
  const objectStore = {
    get: (k: string) => request(data.get(k)),
    put: (v: unknown, k: string) => { data.set(k, v); return request(undefined); },
    delete: (k: string) => { data.delete(k); return request(undefined); },
  };
  const db = { createObjectStore: () => objectStore, transaction: () => ({ objectStore: () => objectStore }) };
  return {
    data,
    factory: {
      open() {
        const req = {
          result: db, error: null as unknown,
          onupgradeneeded: null as Handler, onsuccess: null as Handler, onerror: null as Handler, onblocked: null as Handler,
        };
        queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
        return req;
      },
    } as unknown as IDBFactory,
  };
}

test("indexeddb store round-trips, removes, and drops non-string values", async () => {
  const { data, factory } = fakeIdb();
  const s = new IndexedDbStore(factory);
  await s.ready();
  expect(await s.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).toBeNull();
  await s.set(ACCOUNT.FREE_TIER_INSTANCE_ID, "uuid-1");
  expect(await s.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).toBe("uuid-1");
  await s.remove(ACCOUNT.FREE_TIER_INSTANCE_ID);
  expect(await s.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).toBeNull();
  data.set("weird", 42); // corrupt/non-string value must read as null
  expect(await s.get("weird")).toBeNull();
});

test("indexeddb store ready() rejects when open fails (probe path)", async () => {
  const factory = {
    open() {
      const req = { result: undefined, error: new Error("denied"), onupgradeneeded: null as Handler, onsuccess: null as Handler, onerror: null as Handler, onblocked: null as Handler };
      queueMicrotask(() => req.onerror?.());
      return req;
    },
  } as unknown as IDBFactory;
  await expect(new IndexedDbStore(factory).ready()).rejects.toThrow("denied");
});

// --- CookieStore (against a minimal document.cookie fake) ---

function fakeDoc() {
  const jar = new Map<string, string>();
  return {
    get cookie() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "); },
    set cookie(s: string) {
      const [pair, ...attrs] = s.split(";").map((p) => p.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq), value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) jar.delete(name);
      else jar.set(name, value);
    },
  };
}

test("cookie store round-trips (URI-encoded), removes, and namespaces keys", async () => {
  const doc = fakeDoc();
  const s = new CookieStore(doc, "keylight_");
  expect(await s.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).toBeNull();
  await s.set(ACCOUNT.FREE_TIER_INSTANCE_ID, "id with spaces;=");
  expect(doc.cookie).toContain("keylight_free_tier_instance_id=");
  expect(await s.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).toBe("id with spaces;=");
  await s.remove(ACCOUNT.FREE_TIER_INSTANCE_ID);
  expect(await s.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).toBeNull();
});

test("makeDefaultStore falls back to IndexedDB when localStorage is unusable (browser path)", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevLs = g.localStorage, prevIdb = g.indexedDB, prevProc = g.process;
  g.localStorage = {};              // Node-25-style stub: present but unusable
  g.indexedDB = fakeIdb().factory;  // usable IndexedDB
  // Hide Node so the fs branch doesn't win (simulates a browser runtime).
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try {
    const s = await makeDefaultStore("keylight-idb-test");
    expect(s).toBeInstanceOf(IndexedDbStore);
    await s.set("k", "v");
    expect(await s.get("k")).toBe("v");
  } finally {
    g.process = prevProc;
    if (prevLs === undefined) delete g.localStorage; else g.localStorage = prevLs;
    if (prevIdb === undefined) delete g.indexedDB; else g.indexedDB = prevIdb;
  }
});

test("makeDefaultStore falls back to cookies when localStorage and IndexedDB are unavailable", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevLs = g.localStorage, prevIdb = g.indexedDB, prevDoc = g.document, prevProc = g.process;
  g.localStorage = {};
  delete g.indexedDB;
  g.document = fakeDoc();
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try {
    const s = await makeDefaultStore("keylight-cookie-test");
    expect(s).toBeInstanceOf(CookieStore);
    await s.set(ACCOUNT.FREE_TIER_INSTANCE_ID, "stable-id");
    expect(await s.get(ACCOUNT.FREE_TIER_INSTANCE_ID)).toBe("stable-id");
  } finally {
    g.process = prevProc;
    if (prevLs === undefined) delete g.localStorage; else g.localStorage = prevLs;
    if (prevIdb === undefined) delete g.indexedDB; else g.indexedDB = prevIdb;
    if (prevDoc === undefined) delete g.document; else g.document = prevDoc;
  }
});

test("makeDefaultStore ends at MemoryStore when nothing durable exists", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevLs = g.localStorage, prevIdb = g.indexedDB, prevDoc = g.document, prevProc = g.process;
  g.localStorage = {};
  delete g.indexedDB;
  delete g.document;
  Object.defineProperty(g, "process", { value: undefined, configurable: true, writable: true });
  try {
    expect(await makeDefaultStore("keylight-mem-test")).toBeInstanceOf(MemoryStore);
  } finally {
    g.process = prevProc;
    if (prevLs === undefined) delete g.localStorage; else g.localStorage = prevLs;
    if (prevIdb === undefined) delete g.indexedDB; else g.indexedDB = prevIdb;
    if (prevDoc === undefined) delete g.document; else g.document = prevDoc;
  }
});
