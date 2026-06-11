import { test, expect } from "vitest";
import { verifyLease, SKEW_SECONDS } from "../src/verifier.js";
import type { Lease } from "../src/lease.js";

const lease: Lease = { kid: "k9", licenseKeyHash: "a", instanceId: "i", issuedAt: 0, expiresAt: 1000, status: "active", signature: "x", entitlements: [] };

test("unknown kid short-circuits, expired still computed", () => {
  const r = verifyLease(lease, {}, 50, SKEW_SECONDS);
  expect(r).toEqual({ kidKnown: false, signatureValid: false, expired: false });
});

test("expiry uses skew", () => {
  expect(verifyLease(lease, {}, 1000 + SKEW_SECONDS + 1).expired).toBe(true);
  expect(verifyLease(lease, {}, 1000 + SKEW_SECONDS).expired).toBe(false);
});
