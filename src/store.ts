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
  private loading: Promise<Record<string, string>> | null = null;
  constructor(private readonly filePath: string, private readonly fs: typeof import("node:fs/promises")) {}
  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    // Latch concurrent first-loads onto a single read so we don't fire two readFile calls.
    if (!this.loading) {
      this.loading = (async () => {
        const parsed: Record<string, string> = {};
        try {
          const raw = JSON.parse(await this.fs.readFile(this.filePath, "utf8")) as unknown;
          // Keep only string values — a corrupt/hand-edited file must not poison the
          // store with non-string values (the LicenseStore contract is string|null).
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
              if (typeof v === "string") parsed[k] = v;
            }
          }
        } catch { /* missing or unparseable file -> empty store */ }
        this.cache = parsed;
        return parsed;
      })();
    }
    return this.loading;
  }
  private async flush() { await this.fs.writeFile(this.filePath, JSON.stringify(this.cache ?? {})); }
  async get(k: string) { const c = await this.load(); return k in c ? c[k] : null; }
  // set/remove await flush(), so a writeFile rejection (disk full, EACCES) propagates to the caller.
  async set(k: string, v: string) { const c = await this.load(); c[k] = v; await this.flush(); }
  async remove(k: string) { const c = await this.load(); delete c[k]; await this.flush(); }
}

/**
 * Auto-select a default store: localStorage (browser) -> fs (Node/Bun) -> memory
 * (Deno, edge/Workers, or anywhere with no detectable persistence). Deno can still
 * use FsStore by constructing it explicitly with a node:fs/promises-compatible fs.
 * IndexedDB is available as an opt-in adapter but is not the auto-default, so that the
 * client's in-memory cache can hydrate from a fast synchronous-backed store.
 */
/** True only for a *functional* Web Storage. Node 25+ defines a stub `localStorage = {}`
 *  without getItem/setItem, which must NOT be selected (it would crash on first use). */
function hasUsableLocalStorage(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && typeof localStorage.getItem === "function"
      && typeof localStorage.setItem === "function";
  } catch { return false; } // accessing localStorage can throw in sandboxed iframes
}

export async function makeDefaultStore(namespace = "keylight"): Promise<LicenseStore> {
  if (hasUsableLocalStorage()) return new LocalStorageStore(localStorage, `${namespace}_`);
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
