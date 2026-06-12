import { test, expect } from "vitest";
import { applyTelemetry, detectPlatform, APP_VERSION_MAX, PLATFORM_MAX } from "../src/telemetry.js";

test("applies sdk_version + platform; app_version only when provided", () => {
  const m: Record<string, unknown> = {};
  applyTelemetry(m, "1.2.3");
  expect(typeof m.sdk_version).toBe("string");
  expect(typeof m.platform).toBe("string");
  expect(m.app_version).toBe("1.2.3");

  const m2: Record<string, unknown> = {};
  applyTelemetry(m2, undefined);
  expect("app_version" in m2).toBe(false);

  // Empty string is falsy -> omitted, matching Rust's Option::None.
  const m3: Record<string, unknown> = {};
  applyTelemetry(m3, "");
  expect("app_version" in m3).toBe(false);
});

test("detectPlatform returns a known token", () => {
  expect(["web", "node", "deno", "bun", "workers", "unknown"]).toContain(detectPlatform());
});

test("app_version is clamped to the backend limit (64) so it can't trigger a 400", () => {
  const m: Record<string, unknown> = {};
  applyTelemetry(m, "v".repeat(200));
  expect((m.app_version as string).length).toBe(APP_VERSION_MAX);
  // sdk_version and platform also respect their caps
  expect((m.sdk_version as string).length).toBeLessThanOrEqual(APP_VERSION_MAX);
  expect((m.platform as string).length).toBeLessThanOrEqual(PLATFORM_MAX);
});

test("normal-length app_version is unchanged by the clamp", () => {
  const m: Record<string, unknown> = {};
  applyTelemetry(m, "1.2.3");
  expect(m.app_version).toBe("1.2.3");
});
