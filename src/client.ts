import { type KeylightOptions, type KeylightConfig, normalizeConfig, validateKeyFormat } from "./config.js";
import { type LicenseStore, MemoryStore, ACCOUNT, makeDefaultStore } from "./store.js";
import { type Transport, type Header, FetchTransport } from "./transport.js";
import { verifyLease, isTrusted, SKEW_SECONDS, type VerifyResult } from "./verifier.js";
import { type Lease } from "./lease.js";
import { randomUuid } from "./device.js";
import { applyTelemetry } from "./telemetry.js";
import { decide, backoffMs, clampSleepMs, jitterMs, MAX_ATTEMPTS } from "./retry.js";
import { ClientError, ServerError, RateLimited, TimeoutError, NetworkError, InvalidResponse, LeaseVerificationFailed, NoStoredLicense } from "./errors.js";
import { lifecycleEvent, resolveState, type LicenseState, type LicenseLifecycleEvent, type TrialStatus, type KeylessState } from "./state.js";
import { clockManipulated } from "./clock.js";
import { machineHash, readMachineId } from "./machine.js";

export interface ActivationResult {
  activated: boolean;
  instanceId: string | null;
  lease: Lease | null;
  licenseExpiresAt: number | null;
  error: string | null;
}

interface ActivateResp {
  activated: boolean;
  instance_id?: string | null;
  license_expires_at?: number | null;
  lease?: Lease | null;
  error?: string | null;
}

export interface ValidationResult { valid: boolean; lease: Lease | null; licenseExpiresAt: number | null; error: string | null; }
interface ValidateResp { valid: boolean; license_expires_at?: number | null; lease?: Lease | null; error?: string | null; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSecs = () => Math.floor(Date.now() / 1000);

/** Debounce window for `activeRevalidate` (parity with Swift `activeRevalidateDebounce`). */
const ACTIVE_REVALIDATE_DEBOUNCE_MS = 60_000;

/**
 * Monotonic milliseconds, for measuring elapsed time rather than telling it.
 *
 * Deliberately not `Date.now()`: the debounce SUPPRESSES revalidation, so a
 * wall clock that moves backwards suppresses revocation enforcement for the
 * size of the jump. On a licensing SDK that is an adversarial move, not just an
 * NTP correction. `performance.now()` cannot be steered this way. It is present
 * in every browser and in Node >= 16; the fallback exists only for exotic
 * embedders, where the old (steerable) behaviour is still better than throwing.
 */
const monotonicNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export class Keylight {
  private readonly cfg: KeylightConfig;
  private store: LicenseStore;
  private readonly transport: Transport;
  /** In-memory snapshot of ACCOUNT keys, hydrated once; backs synchronous reads. */
  private cache = new Map<string, string>();
  private hydrated: Promise<void> | null = null;
  private readonly storeOption?: LicenseStore;
  private readonly machineId: () => string | null | Promise<string | null>;
  private readonly stableDeviceId?: string | (() => string | null | Promise<string | null>);
  /** `activeRevalidate` debounce stamp (monotonic ms; null = never run). IN MEMORY BY
   *  DESIGN — never written to the store, so a process restart / page reload always
   *  revalidates. Null rather than 0 because `monotonicNow()` starts near zero, so 0
   *  would read as "just ran" and swallow the very first call of the process. */
  private lastActiveRevalidateAt: number | null = null;

  constructor(options: KeylightOptions) {
    this.cfg = normalizeConfig(options);
    this.transport = options.transport ?? new FetchTransport();
    this.storeOption = options.store;
    this.store = options.store ?? new MemoryStore(); // replaced during hydrate() if no store given
    this.machineId = options.machineId ?? readMachineId;
    this.stableDeviceId = options.stableDeviceId;
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

  async activate(key: string): Promise<ActivationResult> {
    await this.ensureHydrated();
    const fail = (error: string): ActivationResult => ({ activated: false, instanceId: null, lease: null, licenseExpiresAt: null, error });
    if (!validateKeyFormat(key, this.cfg.keyPrefix)) return fail("Invalid license key format");

    const map: Record<string, unknown> = { license_key: key, instance_name: machineName() };
    const ft = this.getStr(ACCOUNT.FREE_TIER_INSTANCE_ID);
    if (ft) map.free_tier_instance_id = ft;
    const mh = await this.currentMachineHash();
    if (mh) map.machine_hash = mh;

    let res: { status: number; body: string };
    try {
      res = await this.post("activate", this.bodyWithTelemetry(map));
    } catch (e) {
      if (e instanceof ClientError) return fail(e.message || `Activation failed (HTTP ${e.status})`);
      throw e;
    }
    let resp: ActivateResp;
    try { resp = JSON.parse(res.body); } catch { throw new InvalidResponse(); }
    if (!resp.activated) return fail(resp.error ?? "Activation failed");

    if (resp.lease) this.verifyOrReject(resp.lease);
    await this.setStr(ACCOUNT.LICENSE_KEY, key);
    if (resp.instance_id) await this.setStr(ACCOUNT.INSTANCE_ID, resp.instance_id);
    if (resp.lease) await this.setStr(ACCOUNT.LEASE, JSON.stringify(resp.lease));
    await this.saveExpiry(resp.license_expires_at ?? null);
    await this.touchLastSeen();
    await this.touchValidatedOnline();
    return { activated: true, instanceId: resp.instance_id ?? null, lease: resp.lease ?? null, licenseExpiresAt: resp.license_expires_at ?? null, error: null };
  }

  async validate(): Promise<ValidationResult> {
    await this.ensureHydrated();
    const key = this.getStr(ACCOUNT.LICENSE_KEY);
    const instance = this.getStr(ACCOUNT.INSTANCE_ID);
    if (!key || !instance) throw new NoStoredLicense();
    const prevState = this.state();
    const prevExpiry = this.getNum(ACCOUNT.LICENSE_EXPIRES_AT);

    const map: Record<string, unknown> = { license_key: key, instance_id: instance };
    const mh = await this.currentMachineHash();
    if (mh) map.machine_hash = mh;
    let res: { status: number; body: string };
    try { res = await this.post("validate", this.bodyWithTelemetry(map), [422]); }
    catch (e) { if (e instanceof ClientError) return { valid: false, lease: null, licenseExpiresAt: null, error: e.message || `Validation failed (HTTP ${e.status})` }; throw e; }

    let resp: ValidateResp;
    try { resp = JSON.parse(res.body); } catch { throw new InvalidResponse(); }
    if (resp.lease) this.verifyOrReject(resp.lease);

    if (!resp.valid) {
      // Definitive rejection: persist whatever lease the server sent (e.g. "expired"/
      // "fallback"), or clear the cached one when it sent none at all — the real worker's
      // revoked/instance-not-active responses are `{error: "..."}` with no `lease` field,
      // so leaving the old (still "active") lease in place would let state() keep
      // reporting Licensed off stale data. Either way this is a definitive deny, not a
      // transient failure, so the store must always reflect it.
      if (resp.lease) await this.setStr(ACCOUNT.LEASE, JSON.stringify(resp.lease));
      else await this.del(ACCOUNT.LEASE);
      await this.saveExpiry(resp.license_expires_at ?? null);
      this.emitLifecycle(prevState, prevExpiry);
      return { valid: false, lease: resp.lease ?? null, licenseExpiresAt: resp.license_expires_at ?? null, error: resp.error ?? null };
    }
    if (resp.lease) await this.setStr(ACCOUNT.LEASE, JSON.stringify(resp.lease));
    await this.saveExpiry(resp.license_expires_at ?? null);
    await this.touchLastSeen();
    await this.touchValidatedOnline();
    this.emitLifecycle(prevState, prevExpiry);
    return { valid: true, lease: resp.lease ?? null, licenseExpiresAt: resp.license_expires_at ?? null, error: null };
  }

  async deactivate(): Promise<void> {
    await this.ensureHydrated();
    const key = this.getStr(ACCOUNT.LICENSE_KEY);
    const instance = this.getStr(ACCOUNT.INSTANCE_ID);
    let netErr: unknown = null;
    if (key && instance) {
      // deactivate carries NO telemetry (parity with Rust).
      try { await this.post("deactivate", JSON.stringify({ license_key: key, instance_id: instance })); }
      catch (e) { netErr = e; }
    }
    for (const k of [ACCOUNT.LICENSE_KEY, ACCOUNT.INSTANCE_ID, ACCOUNT.LEASE, ACCOUNT.LICENSE_EXPIRES_AT, ACCOUNT.LAST_VALIDATED_ONLINE, ACCOUNT.LAST_SEEN]) {
      await this.del(k);
    }
    if (netErr) throw netErr;
  }

  private emitLifecycle(prevState: LicenseState, prevExpiry: number | null) {
    const next = this.state();
    const curExpiry = this.getNum(ACCOUNT.LICENSE_EXPIRES_AT);
    // None < Some ordering: later-or-newly-present expiry.
    const expiryMovedLater = (curExpiry ?? -Infinity) > (prevExpiry ?? -Infinity);
    const ev = lifecycleEvent(prevState, next, expiryMovedLater);
    if (ev) this.fire(ev);
  }

  /** Raw parsed lease from the cache — NO trust/expiry/offline gating. Used by state(),
   *  which needs lease.status even for untrusted/expired leases to resolve Limited/Expired. */
  private rawLease(): Lease | null {
    const s = this.getStr(ACCOUNT.LEASE);
    if (!s) return null;
    try { return JSON.parse(s) as Lease; } catch { return null; }
  }

  /**
   * True once the license has gone longer than `maxOfflineDays` without a successful
   * online validation (`maxOfflineDays === null` disables the cap). Shared by
   * `cachedLease` and `state()` so a validated license can't run offline forever —
   * before this gate existed, `state()` bypassed the cap entirely (it read the raw
   * lease directly), so only `cachedLease`/`hasEntitlement` were bounded.
   */
  private offlineCapExceeded(): boolean {
    if (this.cfg.maxOfflineDays == null) return false;
    const last = this.getNum(ACCOUNT.LAST_VALIDATED_ONLINE);
    if (last === null) return true;
    return nowSecs() - last > this.cfg.maxOfflineDays * 86400;
  }

  /**
   * The usable cached lease, or null. Gated exactly like Rust `cached_lease()`:
   * enforces `maxOfflineDays` (since last online validation), then requires a
   * signature-trusted, unexpired lease whose status is not "expired".
   */
  get cachedLease(): Lease | null {
    if (this.offlineCapExceeded()) return null;
    const lease = this.rawLease();
    if (!lease) return null;
    const r = this.verify(lease);
    return isTrusted(r) && !r.expired && lease.status !== "expired" ? lease : null;
  }
  hasStoredLicense(): boolean { return this.getStr(ACCOUNT.LICENSE_KEY) !== null; }
  get cachedLicenseKey(): string | null { return this.getStr(ACCOUNT.LICENSE_KEY); }
  get cachedLicenseExpiresAt(): number | null { return this.getNum(ACCOUNT.LICENSE_EXPIRES_AT); }

  /** Entitlement check via the gated cachedLease (parity with Rust has_entitlement). */
  hasEntitlement(feature: string): boolean {
    const lease = this.cachedLease;
    return lease ? lease.entitlements.includes(feature) : false;
  }

  state(): LicenseState {
    // Gated by the same maxOfflineDays cap as cachedLease() (G2): past the cap, a
    // signed-and-current lease is treated as absent so state() denies rather than
    // trusting a once-validated license forever offline.
    const lease = this.offlineCapExceeded() ? null : this.rawLease();
    let status: string | null = null, current = false;
    if (lease) { const r = this.verify(lease); status = isTrusted(r) ? lease.status : null; current = !r.expired; }
    return resolveState(status, current, this.hasStoredLicense(), this.checkTrial(), this.cfg.freeTierEnabled);
  }
  getState(): LicenseState { return this.state(); }

  async refreshIfNeeded(): Promise<ValidationResult | null> {
    await this.ensureHydrated();
    if (!this.hasStoredLicense()) return null;
    const last = this.getNum(ACCOUNT.LAST_VALIDATED_ONLINE);
    if (last !== null) {
      const now = nowSecs();
      if (now - last < 300) return null; // debounce 5m
      const exp = this.getNum(ACCOUNT.LICENSE_EXPIRES_AT);
      const nearExpiry = exp !== null && exp - now < 86400; // 24h
      if (now - last < 21600 && !nearExpiry) return null; // stale 6h
    }
    return this.validate();
  }

  /**
   * Always perform a server `validate` round-trip on launch — no staleness gating —
   * so a dashboard revoke or expiry lands on the very next launch instead of lagging
   * behind `refreshIfNeeded`'s debounce (5m) / stale (6h) / near-expiry (24h) windows
   * (G1). `refreshIfNeeded`'s cadence is unchanged and still governs long-running
   * hosts between launches. Never throws; see `forcedRevalidate` for the deny/keep
   * triage it shares with `activeRevalidate`.
   */
  async checkOnLaunch(): Promise<void> {
    await this.ensureHydrated();
    if (!this.hasStoredLicense()) return;
    await this.forcedRevalidate();
  }

  /**
   * One forced `validate()` round-trip, never throwing. Shared by `checkOnLaunch`
   * (launch) and `activeRevalidate` (foreground/active use) so both paths reconcile
   * identically — callers own the hydrate + `hasStoredLicense` guard.
   *
   * A server-side definitive rejection (`!resp.valid`) is reconciled into the store by
   * `validate()` itself, so `state()` denies immediately after this returns.
   *
   * A thrown error is triaged rather than blanket-swallowed (G5):
   *  - GENUINELY TRANSIENT (`NetworkError` / `TimeoutError` / `ServerError` 5xx /
   *    `RateLimited`) ⇒ keep the last-known-good cached lease, still bounded by
   *    `maxOfflineDays` via `state()`/`cachedLease` (G4).
   *  - `InvalidResponse` (malformed body) ⇒ DENY. The trusted worker has no legitimate
   *    reason to send garbage, and `validate()` throws it BEFORE its own store
   *    reconciliation, so the stale still-"active" cached lease would otherwise survive.
   *  - `LeaseVerificationFailed` with a KNOWN kid ⇒ DENY. A trusted signing key produced
   *    a bad signature over this payload ⇒ the served lease is tampered/forged; a forged
   *    lease must never silently keep the user entitled off the old cached lease.
   *  - `LeaseVerificationFailed` with an UNKNOWN kid ⇒ KEEP. Indistinguishable from a
   *    legitimate server-side signing-key rotation; denying here would lock out paying
   *    users the moment the worker rotates keys. Treated as transient.
   *
   * The deny path uses the SAME mechanism as `validate()`'s no-lease `!resp.valid`
   * branch — drop the cached lease so `state()` stops reporting Licensed — then fires
   * the lifecycle transition so subscribers see the change.
   */
  private async forcedRevalidate(): Promise<void> {
    try {
      await this.validate();
      return; // validate() reconciles the store and fires its own lifecycle event.
    } catch (e) {
      if (!isDefinitiveLaunchDeny(e)) return; // transient — keep last-known-good, bounded by maxOfflineDays.
    }
    // Read the "previous" snapshot HERE, not before the call: every path on which
    // validate() throws does so before it writes anything (post() failure, JSON.parse,
    // verifyOrReject), so this is still the pre-call state — and skipping it on the
    // success path avoids a redundant state() (lease JSON.parse + ed25519 verify) on
    // what is a per-window-focus hot path for activeRevalidate.
    const prevState = this.state();
    const prevExpiry = this.getNum(ACCOUNT.LICENSE_EXPIRES_AT);
    await this.del(ACCOUNT.LEASE);
    this.emitLifecycle(prevState, prevExpiry);
  }

  /**
   * Force a re-validation on active use (window focus / popover open / route change),
   * debounced to 60s. Mirrors Swift `activeRevalidate()`.
   *
   * This is the CADENCE primitive `refreshIfNeeded` can't be: with multi-day leases a
   * long-running app would otherwise sit inside `refreshIfNeeded`'s debounce (5m) /
   * stale (6h) / near-expiry (24h) gates and not notice a dashboard revoke until the
   * next launch. Call it whenever the user brings the app forward.
   *
   * Semantics:
   *  - No stored license key ⇒ no-op, no network call (and the debounce clock is NOT
   *    started, matching Swift's guard-then-debounce order).
   *  - Debounced at 60s, held in memory ONLY (never persisted), so a process restart or
   *    page reload always revalidates — a reload is exactly when you want a fresh check.
   *  - Bypasses every staleness gate: it goes straight to `validate()`.
   *  - A definitive rejection (`valid:false`, e.g. the worker's HTTP 422 revoke) is
   *    reconciled into the store by `validate()` itself, so `state()` denies as soon as
   *    this resolves.
   *  - A transient failure leaves state untouched — never downgrade a live session on a
   *    network blip. Never throws.
   *
   * Runs through `forcedRevalidate`, so it shares `checkOnLaunch`'s deny/keep triage
   * (documented there) rather than blanket-catching like Swift does.
   */
  async activeRevalidate(): Promise<void> {
    await this.ensureHydrated();
    if (!this.hasStoredLicense()) return;
    const now = monotonicNow();
    if (
      this.lastActiveRevalidateAt !== null &&
      now - this.lastActiveRevalidateAt < ACTIVE_REVALIDATE_DEBOUNCE_MS
    )
      return;
    this.lastActiveRevalidateAt = now;
    await this.forcedRevalidate();
  }

  get upgradeUrl(): string | null {
    const key = this.cachedLicenseKey;
    if (!key) return null;
    return `https://portal.keylight.dev/p/${this.cfg.tenantId}/upgrade/${this.cfg.productId}?key=${encodeURIComponent(key)}`;
  }

  /** Trial status from the persisted trial-start timestamp (parity with Rust check_trial). */
  checkTrial(): TrialStatus {
    const s = this.getNum(ACCOUNT.TRIAL_START);
    if (s === null) return { kind: "not_started" };
    const left = this.cfg.trialDurationDays - Math.floor((nowSecs() - s) / 86400);
    return left > 0 ? { kind: "active", daysLeft: left } : { kind: "expired" };
  }

  private listeners = new Map<LicenseLifecycleEvent, Set<() => void>>();
  private subscribers = new Set<(s: LicenseState) => void>();

  on(event: LicenseLifecycleEvent, fn: () => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.listeners.get(event)!.delete(fn);
  }
  subscribe(fn: (s: LicenseState) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  protected fire(ev: LicenseLifecycleEvent) {
    this.listeners.get(ev)?.forEach((fn) => { try { fn(); } catch { /* listener errors are non-fatal */ } });
    const s = this.state();
    this.subscribers.forEach((fn) => { try { fn(s); } catch { /* non-fatal */ } });
  }

  async startTrial(): Promise<void> {
    await this.ensureHydrated();
    if (this.getStr(ACCOUNT.TRIAL_START) === null) await this.setStr(ACCOUNT.TRIAL_START, String(nowSecs()));
    // Parity with Rust start_trial: seed a stable free-tier instance id so a later
    // activate forwards it for free-tier -> paid conversion linking.
    await this.freeTierInstanceId();
  }

  isClockManipulated(): boolean {
    const last = this.getNum(ACCOUNT.LAST_SEEN);
    if (last === null) return false;
    const manipulated = clockManipulated(last, nowSecs());
    // Best-effort touch; swallow rejection so an unawaited store error can't crash the process.
    if (!manipulated) this.touchLastSeen().catch(() => {});
    return manipulated;
  }

  async freeTierInstanceId(): Promise<string> {
    await this.ensureHydrated();
    const existing = this.getStr(ACCOUNT.FREE_TIER_INSTANCE_ID);
    if (existing) return existing;
    const id = this.cfg.deviceId ?? randomUuid();
    await this.setStr(ACCOUNT.FREE_TIER_INSTANCE_ID, id);
    return id;
  }

  /** Tenant/product-scoped machine hash for the current host, or null when neither an
   *  OS machine id (browser/Deno/Workers) nor an app-supplied `stableDeviceId` is
   *  available. The hardware machine id wins over `stableDeviceId`. Shared by activate/
   *  validate/keyless so all three send the same cross-SDK `machine_hash`. */
  private async currentMachineHash(): Promise<string | null> {
    const hw = await this.machineId();
    const stable = hw || await this.resolveStableDeviceId();
    return stable ? machineHash(this.cfg.tenantId, this.cfg.productId, stable) : null;
  }
  private async resolveStableDeviceId(): Promise<string | null> {
    const v = typeof this.stableDeviceId === "function" ? await this.stableDeviceId() : this.stableDeviceId;
    return v ? v : null; // null/empty behaves as unset
  }

  /**
   * Report the keyless/free-tier beacon. Never throws; returns `true` when the state
   * is considered reported (a 200 from the server, or a still-fresh <24h debounce for
   * an unchanged state) and `false` when the send failed. The debounce state
   * (last state + ping time) is persisted only on a successful 200.
   */
  async reportKeylessState(state: KeylessState): Promise<boolean> {
    await this.ensureHydrated();
    const lastState = this.getStr(ACCOUNT.KEYLESS_LAST_STATE);
    const lastPing = this.getNum(ACCOUNT.LAST_KEYLESS_PING_AT);
    const changed = lastState !== state;
    const within = lastPing !== null && nowSecs() - lastPing < 86400;
    if (!changed && within) return true; // already reported within the debounce window
    const instance = await this.freeTierInstanceId();
    const map: Record<string, unknown> = { instance_id: instance, state };
    const mh = await this.currentMachineHash();
    if (mh) map.machine_hash = mh;
    const body = this.bodyWithTelemetry(map);
    const out = await this.post("keyless", body).catch(() => null);
    // post() returns only on 200; on success record state + ping (parity with Rust).
    if (out) { await this.setStr(ACCOUNT.KEYLESS_LAST_STATE, state); await this.setStr(ACCOUNT.LAST_KEYLESS_PING_AT, String(nowSecs())); }
    return out !== null;
  }

  // --- Swift-parity convenience aliases (thin wrappers over the methods above) ---

  /** `true` when actively entitled: Licensed, or a Trial with days remaining. Mirrors Swift `isEntitled`. */
  get isEntitled(): boolean {
    const s = this.state();
    return s.kind === "Licensed" || (s.kind === "Trial" && s.daysLeft > 0);
  }

  /** Whether the product has the free tier enabled. Mirrors Swift `productFreeTierEnabled()`. */
  productFreeTierEnabled(): boolean { return this.cfg.freeTierEnabled; }

  /** Instance-method form of key-format validation (uses the configured keyPrefix). Mirrors Swift `isValidKeyFormat`. */
  isValidKeyFormat(key: string): boolean { return validateKeyFormat(key, this.cfg.keyPrefix); }

  /** Force a validation (default) or fall back to the debounced path. Mirrors Swift `refresh(force:)`. */
  async refresh(force = true): Promise<ValidationResult | null> {
    if (!force) return this.refreshIfNeeded();
    await this.ensureHydrated();
    if (!this.hasStoredLicense()) return null;
    return this.validate();
  }

  /** The persisted free-tier/keyless instance id WITHOUT creating one. Mirrors Swift `freeTierInstanceIdIfPresent()`. */
  async freeTierInstanceIdIfPresent(): Promise<string | null> {
    await this.ensureHydrated();
    return this.getStr(ACCOUNT.FREE_TIER_INSTANCE_ID);
  }

  /** Report the anonymous free-tier beacon. Mirrors Swift `reportFreeTier()`.
   *  Never throws; returns whether the beacon is reported (see reportKeylessState). */
  async reportFreeTier(): Promise<boolean> { return this.reportKeylessState("free_tier"); }

  protected verifyOrReject(lease: Lease) {
    const r = this.verify(lease);
    // Carry kidKnown so callers (checkOnLaunch) can tell tampering (known kid, bad
    // signature) from a possible signing-key rotation (unknown kid). isTrusted() is
    // kidKnown && signatureValid, so a thrown error always means "not both".
    if (!isTrusted(r)) throw new LeaseVerificationFailed(r.kidKnown);
  }
  protected async saveExpiry(exp: number | null) {
    if (exp === null) await this.del(ACCOUNT.LICENSE_EXPIRES_AT);
    else await this.setStr(ACCOUNT.LICENSE_EXPIRES_AT, String(exp));
  }
  protected async touchLastSeen() { await this.setStr(ACCOUNT.LAST_SEEN, String(nowSecs())); }
  protected async touchValidatedOnline() { await this.setStr(ACCOUNT.LAST_VALIDATED_ONLINE, String(nowSecs())); }
}

/**
 * Whether an error thrown out of `validate()` on the launch path is a DEFINITIVE deny
 * (drop the cached lease) rather than a genuinely transient failure (keep last-known-good).
 *
 *  - `InvalidResponse` (malformed body) ⇒ deny: the trusted worker never sends garbage.
 *  - `LeaseVerificationFailed` with a KNOWN kid ⇒ deny: a trusted key signed a bad payload
 *    ⇒ tampering/forgery.
 *  - `LeaseVerificationFailed` with an UNKNOWN kid ⇒ NOT a deny: indistinguishable from a
 *    legitimate signing-key rotation; keep access so a rotation can't lock out users.
 *  - Everything else (NetworkError / TimeoutError / ServerError / RateLimited / …) ⇒ NOT a
 *    deny: transient, keep last-known-good.
 */
function isDefinitiveLaunchDeny(e: unknown): boolean {
  if (e instanceof InvalidResponse) return true;
  if (e instanceof LeaseVerificationFailed) return e.kidKnown;
  return false;
}

// Short opaque correlation id for the X-Keylight-Request-Id header.
// Reuses the SDK's UUID generator (incl. its getRandomValues fallback) — DRY.
function randomId(): string {
  return randomUuid().slice(0, 8);
}

/**
 * A human-readable device label sent as `instance_name` (display only; the seat
 * identity is the server-issued `instance_id`). We deliberately avoid sending the
 * full User-Agent (privacy) and instead prefer a hostname (Node, parity with the
 * Rust SDK) or the coarse platform (browser).
 */
function machineName(): string {
  if (typeof process !== "undefined" && process.env) {
    // Parity with Rust machine_name(): prefer the OS hostname env vars.
    const host = process.env.HOSTNAME || process.env.COMPUTERNAME || process.env.HOST;
    if (host) return host;
    if (process.platform) return `${process.platform}-${process.arch}`;
  }
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { userAgentData?: { platform?: string } }) : undefined;
  if (nav?.userAgentData?.platform) return nav.userAgentData.platform; // e.g. "macOS" — no UA fingerprint
  if (nav) return "browser";
  return "unknown-device";
}
