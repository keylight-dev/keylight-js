import { type KeylightOptions, type KeylightConfig, normalizeConfig } from "./config.js";
import { type LicenseStore, MemoryStore, ACCOUNT, makeDefaultStore } from "./store.js";
import { type Transport, type Header, FetchTransport } from "./transport.js";
import { verifyLease, isTrusted, SKEW_SECONDS, type VerifyResult } from "./verifier.js";
import { type Lease } from "./lease.js";
import { randomUuid } from "./device.js";
import { applyTelemetry } from "./telemetry.js";
import { decide, backoffMs, clampSleepMs, jitterMs, MAX_ATTEMPTS } from "./retry.js";
import { ClientError, ServerError, RateLimited, TimeoutError, NetworkError } from "./errors.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSecs = () => Math.floor(Date.now() / 1000);

export class Keylight {
  private readonly cfg: KeylightConfig;
  private store: LicenseStore;
  private readonly transport: Transport;
  /** In-memory snapshot of ACCOUNT keys, hydrated once; backs synchronous reads. */
  private cache = new Map<string, string>();
  private hydrated: Promise<void> | null = null;
  private readonly storeOption?: LicenseStore;

  constructor(options: KeylightOptions) {
    this.cfg = normalizeConfig(options);
    this.transport = options.transport ?? new FetchTransport();
    this.storeOption = options.store;
    this.store = options.store ?? new MemoryStore(); // replaced during hydrate() if no store given
  }

  /** Hydrate the in-memory cache from the (possibly async) store. Idempotent. */
  async load(): Promise<void> {
    if (!this.hydrated) this.hydrated = this.doHydrate();
    return this.hydrated;
  }
  private async doHydrate(): Promise<void> {
    if (!this.storeOption) this.store = await makeDefaultStore();
    for (const key of Object.values(ACCOUNT)) {
      const v = await this.store.get(key);
      if (v !== null) this.cache.set(key, v);
    }
  }
  private async ensureHydrated() { await this.load(); }

  // --- cache-backed sync accessors (write-through to the store) ---
  protected getStr(key: string): string | null { return this.cache.has(key) ? this.cache.get(key)! : null; }
  protected getNum(key: string): number | null { const v = this.getStr(key); return v === null ? null : Number(v); }
  protected async setStr(key: string, value: string) { this.cache.set(key, value); await this.store.set(key, value); }
  protected async del(key: string) { this.cache.delete(key); await this.store.remove(key); }

  // --- request plumbing ---
  private apiUrl(path: string): string {
    return `${this.cfg.baseUrl}/${this.cfg.tenantId}/${this.cfg.productId}/${path}`;
  }
  private headers(): Header[] {
    const h: Header[] = [["X-Keylight-Request-Id", randomId()]];
    if (this.cfg.sdkKey) h.push(["X-Keylight-SDK-Key", this.cfg.sdkKey]);
    return h;
  }
  private bodyWithTelemetry(map: Record<string, unknown>): string {
    applyTelemetry(map, this.cfg.appVersion);
    return JSON.stringify(map);
  }

  /** POST with retry/backoff. `decodable4xx` opts a 4xx body in (validate's 422). */
  protected async post(path: string, body: string, decodable4xx: number[] = []): Promise<{ status: number; body: string }> {
    const url = this.apiUrl(path);
    const headers = this.headers();
    let attempt = 0;
    for (;;) {
      attempt++;
      const out = await this.transport.postJson(url, headers, body);
      if (out.kind === "response") {
        if (out.status === 200 || decodable4xx.includes(out.status)) return { status: out.status, body: out.body };
        const d = decide(out.status, attempt, out.retryAfter);
        if (d.kind === "retry") { await sleep(d.ms + jitterMs()); continue; }
        if (out.status === 429) throw new RateLimited(out.retryAfter ?? 0);
        if ((out.status >= 500 && out.status <= 599) || out.status === 408) throw new ServerError(out.status);
        let msg = "";
        try { msg = (JSON.parse(out.body) as { error?: string }).error ?? ""; } catch { /* ignore */ }
        throw new ClientError(out.status, msg);
      }
      if (out.kind === "transient" && attempt < MAX_ATTEMPTS) { await sleep(clampSleepMs(backoffMs(attempt)) + jitterMs()); continue; }
      if (out.kind === "transient" || out.kind === "terminal") throw new NetworkError(out.error);
      throw new TimeoutError();
    }
  }

  /**
   * Test-only passthrough to exercise the plumbing (URL/headers/telemetry) before the
   * real licensing methods exist. Not part of the public API.
   * @internal
   */
  async _postForTest(path: string, map: Record<string, unknown>, decodable4xx: number[] = []) {
    return this.post(path, this.bodyWithTelemetry(map), decodable4xx);
  }

  // --- verification helpers ---
  protected verify(lease: Lease): VerifyResult {
    return verifyLease(lease, this.cfg.trustedKeys, nowSecs(), SKEW_SECONDS);
  }
  protected config(): KeylightConfig { return this.cfg; }
  protected bodyTelemetry(map: Record<string, unknown>): string { return this.bodyWithTelemetry(map); }
}

// Short opaque correlation id for the X-Keylight-Request-Id header.
// Reuses the SDK's UUID generator (incl. its getRandomValues fallback) — DRY.
function randomId(): string {
  return randomUuid().slice(0, 8);
}
