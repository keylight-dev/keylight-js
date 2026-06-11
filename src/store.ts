/** Storage keys — byte-identical to the Rust `account` module. */
export const ACCOUNT = {
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
} as const;

/** Async key/value persistence. Implement to back the SDK with any runtime store. */
export interface LicenseStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryStore implements LicenseStore {
  private m = new Map<string, string>();
  async get(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async remove(k: string) { this.m.delete(k); }
}

/** Browser localStorage adapter (namespaced). */
export class LocalStorageStore implements LicenseStore {
  constructor(private readonly ls: Storage, private readonly prefix = "keylight_") {}
  async get(k: string) { return this.ls.getItem(this.prefix + k); }
  async set(k: string, v: string) { this.ls.setItem(this.prefix + k, v); }
  async remove(k: string) { this.ls.removeItem(this.prefix + k); }
}

/** Node/Bun/Deno filesystem adapter (one JSON file). */
export class FsStore implements LicenseStore {
  private cache: Record<string, string> | null = null;
  constructor(private readonly filePath: string, private readonly fs: typeof import("node:fs/promises")) {}
  private async load() {
    if (this.cache) return this.cache;
    try { this.cache = JSON.parse(await this.fs.readFile(this.filePath, "utf8")); }
    catch { this.cache = {}; }
    return this.cache!;
  }
  private async flush() { await this.fs.writeFile(this.filePath, JSON.stringify(this.cache ?? {})); }
  async get(k: string) { const c = await this.load(); return k in c ? c[k] : null; }
  async set(k: string, v: string) { const c = await this.load(); c[k] = v; await this.flush(); }
  async remove(k: string) { const c = await this.load(); delete c[k]; await this.flush(); }
}

/**
 * Auto-select a default store: localStorage (browser) -> fs (node/bun/deno) -> memory (edge).
 * IndexedDB is available as an opt-in adapter but is not the auto-default, so that the
 * client's in-memory cache can hydrate from a fast synchronous-backed store.
 */
export async function makeDefaultStore(namespace = "keylight"): Promise<LicenseStore> {
  try {
    if (typeof localStorage !== "undefined") return new LocalStorageStore(localStorage, `${namespace}_`);
  } catch { /* localStorage may throw in sandboxed iframes */ }
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      return new FsStore(path.join(os.homedir(), `.${namespace}.json`), fs);
    }
  } catch { /* fall through */ }
  return new MemoryStore();
}
