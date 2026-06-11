import { test, expect } from "vitest";
import { applyTelemetry, detectPlatform } from "../src/telemetry.js";

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
