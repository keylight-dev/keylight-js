import { test, expect } from "vitest";
import { KeylightError, ClientError, ServerError, RateLimited, NetworkError, LeaseVerificationFailed, NoStoredLicense } from "../src/errors.js";

test("subclasses carry a stable code and instanceof base", () => {
  const e = new NetworkError("boom");
  expect(e).toBeInstanceOf(KeylightError);
  expect(e.code).toBe("network_failure");
  expect(new LeaseVerificationFailed().code).toBe("lease_verification_failed");
  expect(new NoStoredLicense().code).toBe("no_stored_license");
});

test("status- and retryAfter-carrying errors expose their fields", () => {
  const c = new ClientError(404, "not found");
  expect(c).toBeInstanceOf(ClientError);
  expect(c.status).toBe(404);
  expect(c.code).toBe("client_error");
  expect(new ServerError(503).status).toBe(503);
  expect(new RateLimited(30).retryAfter).toBe(30);
});

test("each subclass sets its own .name (for logs / aggregators)", () => {
  expect(new ClientError(400, "x").name).toBe("ClientError");
  expect(new RateLimited(1).name).toBe("RateLimited");
  expect(new NoStoredLicense().name).toBe("NoStoredLicense");
});
