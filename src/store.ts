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
  /** Last product configuration heard from the server (trial length, free tier).
   *  Cached so an offline launch uses the tenant's real settings rather than
   *  falling back to the compiled-in seed. */
  PRODUCT_CONFIG: "product_config",
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
 * Browser IndexedDB adapter (namespaced database, single "kv" object store).
 * Dependency-free; used as the durable fallback when localStorage is unavailable
 * (sandboxed iframes, some privacy modes) so the free-tier instance id survives
 * page loads instead of regenerating in a MemoryStore.
 */
export class IndexedDbStore implements LicenseStore {
  private readonly dbp: Promise<IDBDatabase>;
  constructor(idb: IDBFactory, dbName = "keylight", private readonly storeName = "kv") {
    this.dbp = new Promise((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try { req = idb.open(dbName, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(storeName); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB open blocked"));
    });
    // Avoid an unhandled-rejection crash if the caller never awaits ready()/ops.
    this.dbp.catch(() => {});
  }
  /** Resolves once the database is open; rejects if IndexedDB is unusable.
   *  makeDefaultStore awaits this to probe before committing to the adapter. */
  async ready(): Promise<void> { await this.dbp; }
  private async op<T>(mode: IDBTransactionMode, run: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.dbp;
    return new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(this.storeName, mode).objectStore(this.storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
    });
  }
  async get(k: string): Promise<string | null> {
    const v = await this.op("readonly", (os) => os.get(k) as IDBRequest<unknown>);
    return typeof v === "string" ? v : null;
  }
  async set(k: string, v: string): Promise<void> { await this.op("readwrite", (os) => os.put(v, k)); }
  async remove(k: string): Promise<void> { await this.op("readwrite", (os) => os.delete(k)); }
}

/**
 * Browser cookie adapter (namespaced, first-party, SameSite=Lax, ~400-day max-age —
 * the browser cap). Last-resort durable fallback when both localStorage and
 * IndexedDB are unavailable. Values are URI-encoded; total size is cookie-bounded,
 * fine for the small ACCOUNT keys the SDK persists.
 */
export class CookieStore implements LicenseStore {
  constructor(private readonly doc: { cookie: string }, private readonly prefix = "keylight_") {}
  async get(k: string): Promise<string | null> {
    const name = encodeURIComponent(this.prefix + k) + "=";
    for (const part of this.doc.cookie.split(";")) {
      const c = part.trim();
      if (c.startsWith(name)) return decodeURIComponent(c.slice(name.length));
    }
    return null;
  }
  async set(k: string, v: string): Promise<void> {
    // 400 days = the maximum cookie lifetime browsers honor (RFC 6265bis).
    this.doc.cookie = `${encodeURIComponent(this.prefix + k)}=${encodeURIComponent(v)}; max-age=34560000; path=/; SameSite=Lax`;
  }
  async remove(k: string): Promise<void> {
    this.doc.cookie = `${encodeURIComponent(this.prefix + k)}=; max-age=0; path=/; SameSite=Lax`;
  }
}

/**
 * Auto-select a default store, most durable first for the platform:
 *   localStorage (browser) -> fs (Node/Bun) -> IndexedDB (browser fallback)
 *   -> cookies (browser last durable resort) -> memory (edge/Workers, nothing else).
 * Layering rationale: one browser profile must map to one stable
 * free_tier_instance_id across page loads — a MemoryStore regenerates it per load
 * and inflates device counts. Deno can still use FsStore explicitly with a
 * node:fs/promises-compatible fs. localStorage stays first so the client's
 * in-memory cache hydrates from a fast synchronous-backed store.
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
  // Browser without usable localStorage: probe IndexedDB (must actually open —
  // some privacy modes expose the API but fail the open asynchronously).
  if (typeof indexedDB !== "undefined") {
    try {
      const s = new IndexedDbStore(indexedDB, namespace);
      await s.ready();
      return s;
    } catch { /* fall through */ }
  }
  // Cookie fallback: verify cookies are actually writable (a probe round-trip),
  // since document.cookie silently no-ops when cookies are blocked.
  if (typeof document !== "undefined" && typeof document.cookie === "string") {
    try {
      const s = new CookieStore(document, `${namespace}_`);
      const probeKey = "__probe";
      await s.set(probeKey, "1");
      const ok = (await s.get(probeKey)) === "1";
      await s.remove(probeKey);
      if (ok) return s;
    } catch { /* fall through */ }
  }
  return new MemoryStore();
}
