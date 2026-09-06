import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { leasePayload, type Lease } from "./lease.js";
import type { ProductConfigFields } from "./productConfig.js";

// @noble/ed25519 v2 has no built-in hashing; it requires the host to inject SHA-512.
// We inject a SYNCHRONOUS implementation so `ed.verify()` runs synchronously — this is
// what lets the SDK's `state`/`hasEntitlement` reads stay sync (Rust parity: verify is sync).
//
// This MUST stay at module scope: it runs once when this module is imported (and
// `sideEffects: false` in package.json scopes the effect to that import). It is
// idempotent — re-assigning the same function is safe even if the host app also uses
// @noble/ed25519. Do not move it into the function, conditionalize it, or remove it:
// without it, `ed.verify()` throws "sha512Sync not set" and verification breaks.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export const SKEW_SECONDS = 300;

export interface VerifyResult {
  kidKnown: boolean;
  signatureValid: boolean;
  expired: boolean;
}

/** A lease is trusted when signed by a known key (independent of expiry). */
export function isTrusted(r: VerifyResult): boolean {
  return r.kidKnown && r.signatureValid;
}

/** Decode standard or url-safe base64, tolerating missing padding/whitespace. */
function b64decode(s: string): Uint8Array | null {
  const norm = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4));
  try {
    const bin = typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Verify a lease against trusted `kid -> raw ed25519 pub (base64)`. Byte-exact to Rust. */
export function verifyLease(
  lease: Lease,
  trustedKeys: Record<string, string>,
  nowSeconds: number,
  skewSeconds: number = SKEW_SECONDS,
): VerifyResult {
  const expired = nowSeconds > lease.expiresAt + skewSeconds;
  const pubB64 = trustedKeys[lease.kid];
  if (pubB64 === undefined) return { kidKnown: false, signatureValid: false, expired };

  let signatureValid = false;
  try {
    const pk = b64decode(pubB64);
    const sig = b64decode(lease.signature);
    if (pk && pk.length === 32 && sig) {
      const msg = new TextEncoder().encode(leasePayload(lease));
      signatureValid = ed.verify(sig, msg, pk);
    }
  } catch {
    signatureValid = false;
  }
  return { kidKnown: true, signatureValid, expired };
}

/**
 * The canonical preimage for a signed product config.
 *
 * Frozen across every SDK. Once a verifying client is in the wild these bytes
 * cannot change: every shipped client would reject valid configs, and it cannot
 * be fixed from the server. `freeTierEnabled` is the literal `true`/`false`.
 */
export function configPayload(
  kid: string,
  tenantId: string,
  productId: string,
  issuedAt: number,
  expiresAt: number,
  trialDurationDays: number,
  freeTierEnabled: boolean,
): string {
  return `cfg1|${kid}|${tenantId}|${productId}|${issuedAt}|${expiresAt}|${trialDurationDays}|${freeTierEnabled ? "true" : "false"}`;
}

/**
 * Verify the Ed25519 signature over a set of server-owned product settings.
 * Byte-exact to Rust, Swift, C# and C++.
 *
 * `tenantId` and `productId` come from the caller's own configuration, never
 * from the body — that is what makes a config signed for another product fail
 * rather than validate against its own claim.
 *
 * Freshness applies to the wire, not to the cache: a response fetched outside
 * its own window is rejected here, while a config already cached stays usable
 * past that window, because expiring it would cut an offline user's trial short
 * for no security gain.
 */
export function verifyConfig(
  fields: ProductConfigFields,
  tenantId: string,
  productId: string,
  trustedKeys: Record<string, string>,
  nowSeconds: number,
  skewSeconds: number = SKEW_SECONDS,
): boolean {
  const { issued_at: issuedAt, expires_at: expiresAt, kid, signature } = fields;
  // The four fields arrive together or not at all, so a partial set is unsigned
  // rather than malformed.
  if (typeof issuedAt !== "number" || typeof expiresAt !== "number") return false;
  if (typeof kid !== "string" || typeof signature !== "string" || signature === "") return false;

  if (nowSeconds + skewSeconds < issuedAt) return false;
  if (expiresAt + skewSeconds < nowSeconds) return false;

  // The worker signs a complete pair or sends the response unsigned, so a
  // partial config was never signable and must not be treated as if it were.
  const days = fields.trial_duration_days;
  const freeTier = fields.free_tier_enabled;
  if (typeof days !== "number" || typeof freeTier !== "boolean") return false;

  const pubB64 = trustedKeys[kid];
  if (pubB64 === undefined) return false;

  try {
    const pk = b64decode(pubB64);
    const sig = b64decode(signature);
    if (!pk || pk.length !== 32 || !sig) return false;
    const msg = new TextEncoder().encode(
      configPayload(kid, tenantId, productId, issuedAt, expiresAt, days, freeTier),
    );
    return ed.verify(sig, msg, pk);
  } catch {
    return false;
  }
}
