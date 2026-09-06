import type { Transport } from "./transport.js";
import type { LicenseStore } from "./store.js";

export interface KeylightOptions {
  tenantId: string;
  productId: string;
  sdkKey?: string;
  baseUrl?: string;
  trustedKeys?: Record<string, string>; // kid -> raw ed25519 pub (base64)
  /** Days a license may run offline (since the last successful online validation)
   *  before it is treated as non-entitled. Defaults to 15. Pass `null` explicitly
   *  to disable the cap (uncapped offline use, e.g. air-gapped consumers). */
  maxOfflineDays?: number | null;
  trialDurationDays?: number;
  freeTierEnabled?: boolean;
  /**
   * Require server-owned product settings to carry a valid Ed25519 signature
   * before they are cached. Defaults to `false`.
   *
   * Off by default on purpose: the worker signs a product's settings only once
   * that product has a trial length configured, and every other product is
   * served unsigned. Turning this on for one of those would reject legitimate
   * responses and pin the install to its compiled-in seed.
   *
   * Trust is rooted in `trustedKeys`, which you ship with your app. The SDK
   * deliberately does not fetch a keyset at runtime: keys fetched over the same
   * channel that serves the config would let anyone able to forge one forge the
   * other. The cost is that rotating to a new `kid` leaves already-shipped
   * builds on their last cached settings until they update — a freeze, not a
   * failure.
   */
  requireSignedConfig?: boolean;
  appVersion?: string;
  keyPrefix?: string;
  deviceId?: string;        // overrides the persisted free-tier/keyless instance id
  transport?: Transport;    // injectable
  store?: LicenseStore;     // injectable
  /** Test seam for the OS/hardware machine id used to derive `machine_hash` on the
   *  keyless heartbeat, activate, and validate. Not part of the normalized config —
   *  defaults to `readMachineId`. */
  machineId?: () => string | null | Promise<string | null>;
  /** App-supplied stable identifier used to derive `machine_hash` when no OS/hardware
   *  machine id is available (browser/Deno/Workers). Provide a value that is stable for
   *  the device/user — a user account id is typical. It is never sent raw: it is hashed
   *  with the same tenant/product-scoped material as the hardware machine id. A hardware
   *  machine id (Node/Bun) always takes precedence. A null/empty value (or function
   *  result) behaves as if unset — `machine_hash` is omitted. NOTE: changing the supplied
   *  value changes the device identity server-side (it counts as a new device). Not part
   *  of the normalized config. */
  stableDeviceId?: string | (() => string | null | Promise<string | null>);
  /** How often, in ms, a keyless device (trial / free tier / expired) re-reports
   *  itself while the host process keeps running. Defaults to 6 hours; pass
   *  `null` to opt out and drive `reportKeylessState` yourself.
   *
   *  Without a cadence the beacon goes out once at startup, so a resident host —
   *  an Electron app, a tray app, a long-lived service — reports itself once and
   *  then looks dead to the dashboard for as long as it runs. `reportKeylessState`
   *  still debounces to one request per 24h, so a tighter interval here costs
   *  nothing on the wire. Not part of the normalized config. */
  keylessHeartbeatMs?: number | null;
}

export interface KeylightConfig {
  tenantId: string;
  productId: string;
  sdkKey?: string;
  baseUrl: string;
  trustedKeys: Record<string, string>;
  /** `null` means the offline cap is disabled. Always defined after normalization
   *  (defaults to 15 when the caller omits it). */
  maxOfflineDays: number | null;
  trialDurationDays: number;
  freeTierEnabled: boolean;
  requireSignedConfig: boolean;
  appVersion?: string;
  keyPrefix?: string;
  deviceId?: string;
}

export function normalizeConfig(o: KeylightOptions): KeylightConfig {
  return {
    tenantId: o.tenantId,
    productId: o.productId,
    sdkKey: o.sdkKey,
    baseUrl: o.baseUrl ?? "https://api.keylight.dev",
    trustedKeys: o.trustedKeys ?? {},
    // Default 15 days (cross-SDK parity); explicit `null` disables the cap.
    maxOfflineDays: o.maxOfflineDays === undefined ? 15 : o.maxOfflineDays,
    trialDurationDays: o.trialDurationDays ?? 14, // Rust builder default; harmless until startTrial() is called
    freeTierEnabled: o.freeTierEnabled ?? false,
    requireSignedConfig: o.requireSignedConfig ?? false,
    appVersion: o.appVersion,
    keyPrefix: o.keyPrefix,
    deviceId: o.deviceId,
  };
}

/** Mirrors Rust validate_key_format: trims, enforces optional (case-insensitive) prefix, alphanumeric+hyphen. */
export function validateKeyFormat(key: string, keyPrefix: string | undefined): boolean {
  const k = key.trim();
  if (k.length === 0) return false;
  // Rust compares prefixes case-insensitively (to_uppercase on both sides).
  if (keyPrefix && !k.toUpperCase().startsWith(keyPrefix.toUpperCase())) return false;
  return /^[A-Za-z0-9-]+$/.test(k);
}
