import { test, expect } from "vitest";
import { KeylightError, NetworkError, LeaseVerificationFailed, NoStoredLicense } from "../src/errors.js";

test("subclasses carry a stable code and instanceof base", () => {
  const e = new NetworkError("boom");
  expect(e).toBeInstanceOf(KeylightError);
  expect(e.code).toBe("network_failure");
  expect(new LeaseVerificationFailed().code).toBe("lease_verification_failed");
  expect(new NoStoredLicense().code).toBe("no_stored_license");
});
