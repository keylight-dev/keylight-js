import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { leasePayload, type Lease } from "./lease.js";

// Wire a synchronous SHA-512 so ed.verify() is synchronous (Rust parity: verify is sync).
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
