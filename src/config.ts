import type { Transport } from "./transport.js";
import type { LicenseStore } from "./store.js";

export interface KeylightOptions {
  tenantId: string;
  productId: string;
  sdkKey?: string;
  baseUrl?: string;
  trustedKeys?: Record<string, string>; // kid -> raw ed25519 pub (base64)
  maxOfflineDays?: number;
  trialDurationDays?: number;
  freeTierEnabled?: boolean;
  appVersion?: string;
  keyPrefix?: string;
  deviceId?: string;        // overrides the persisted free-tier/keyless instance id
  transport?: Transport;    // injectable
  store?: LicenseStore;     // injectable
}

export interface KeylightConfig {
  tenantId: string;
  productId: string;
  sdkKey?: string;
  baseUrl: string;
  trustedKeys: Record<string, string>;
  maxOfflineDays?: number;
  trialDurationDays: number;
  freeTierEnabled: boolean;
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
    maxOfflineDays: o.maxOfflineDays,
    trialDurationDays: o.trialDurationDays ?? 14, // Rust builder default; harmless until startTrial() is called
    freeTierEnabled: o.freeTierEnabled ?? false,
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
