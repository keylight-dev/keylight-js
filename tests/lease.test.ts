import { test, expect } from "vitest";
import { leasePayload, type Lease } from "../src/lease.js";

const base: Lease = {
  kid: "k1", licenseKeyHash: "h", instanceId: "i",
  issuedAt: 10, expiresAt: 20, status: "active",
  signature: "sig", entitlements: ["pro", "addon"],
};

test("payload sorts entitlements ascending and uses v3 pipe format", () => {
  expect(leasePayload(base)).toBe("v3|k1|h|i|10|20|active|addon,pro");
});

test("empty entitlements -> trailing empty field", () => {
  expect(leasePayload({ ...base, entitlements: [] })).toBe("v3|k1|h|i|10|20|active|");
});
