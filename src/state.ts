/**
 * License state, trial/keyless status, lifecycle events, and the pure state resolver.
 *
 * Mirrors Rust `keylight::state` and Swift `LicenseManager` exactly.
 * Pure module — no I/O.
 */

export type LicenseState =
  | { kind: "Trial"; daysLeft: number }
  | { kind: "Licensed" }
  | { kind: "Limited" }
  | { kind: "FreeTier" }
  | { kind: "Expired" }
  | { kind: "Invalid" };

export type TrialStatus =
  | { kind: "not_started" }
  | { kind: "active"; daysLeft: number }
  | { kind: "expired" };

/** Wire strings match Rust `KeylessState::wire()`. */
export type KeylessState = "trial" | "free_tier" | "expired";

export type LicenseLifecycleEvent = "Renewed" | "Cancelled" | "Expired" | "Restored";

/**
 * Pure state resolver — mirrors Rust `resolve_state` / Swift `LicenseManager`.
 *
 * Arms and their order match the Rust match exactly:
 *   1. ("active", true)  -> Licensed
 *   2. ("fallback", _)   -> Limited      (ignores leaseCurrent)
 *   3. ("expired", _)    -> Expired
 *   4. stale active / other falls through
 *   5. hadLicense        -> Expired
 *   6. trial active      -> Trial
 *   7. freeTierEnabled   -> FreeTier
 *   8. else              -> Invalid
 */
export function resolveState(
  leaseStatus: string | null,
  leaseCurrent: boolean,
  hadLicense: boolean,
  trial: TrialStatus,
  freeTierEnabled: boolean,
): LicenseState {
  if (leaseStatus !== null) {
    if (leaseStatus === "active" && leaseCurrent) return { kind: "Licensed" };
    if (leaseStatus === "fallback") return { kind: "Limited" };
    if (leaseStatus === "expired") return { kind: "Expired" };
    // stale active (or anything else) falls through to offline/expired handling
  }
  if (hadLicense) return { kind: "Expired" };
  if (trial.kind === "active") return { kind: "Trial", daysLeft: trial.daysLeft };
  if (freeTierEnabled) return { kind: "FreeTier" };
  return { kind: "Invalid" };
}

/**
 * Pure lifecycle transition — mirrors Rust `lifecycle_event`.
 *
 * Arms and their order match the Rust match exactly:
 *   1. Licensed -> Licensed (expiryMovedLater)  => Renewed
 *   2. Licensed -> Expired | Limited             => Cancelled
 *   3. Expired | Limited | Invalid -> Licensed   => Restored
 *   4. _ -> Expired (prev !== Expired)           => Expired
 *   5. else                                      => null
 */
export function lifecycleEvent(
  prev: LicenseState,
  next: LicenseState,
  expiryMovedLater: boolean,
): LicenseLifecycleEvent | null {
  const p = prev.kind, n = next.kind;
  if (p === "Licensed" && n === "Licensed" && expiryMovedLater) return "Renewed";
  if (p === "Licensed" && (n === "Expired" || n === "Limited")) return "Cancelled";
  if ((p === "Expired" || p === "Limited" || p === "Invalid") && n === "Licensed") return "Restored";
  if (n === "Expired" && p !== "Expired") return "Expired";
  return null;
}
