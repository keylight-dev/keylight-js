import { test, expect, describe, afterEach, vi } from "vitest";
import {
  applyTelemetry, detectPlatform, SDK_ID,
  APP_VERSION_MAX, PLATFORM_MAX, SDK_ID_MAX,
} from "../src/telemetry.js";

test("applies sdk_version + platform + sdk; app_version only when provided", () => {
  const m: Record<string, unknown> = {};
  applyTelemetry(m, "1.2.3");
  expect(typeof m.sdk_version).toBe("string");
  expect(typeof m.platform).toBe("string");
  expect(m.sdk).toBe("js");
  expect(m.app_version).toBe("1.2.3");

  const m2: Record<string, unknown> = {};
  applyTelemetry(m2, undefined);
  expect("app_version" in m2).toBe(false);

  // Empty string is falsy -> omitted, matching Rust's Option::None.
  const m3: Record<string, unknown> = {};
  applyTelemetry(m3, "");
  expect("app_version" in m3).toBe(false);
});

describe("detectPlatform reports the OS, not the runtime", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    vi.unstubAllGlobals();
  });

  const setNodePlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value, configurable: true });

  test("maps process.platform onto the canonical tokens the other SDKs send", () => {
    // The bug: every Electron app reported "node" regardless of OS, so the
    // platform breakdown could not separate Windows installs from macOS ones.
    setNodePlatform("darwin");
    expect(detectPlatform()).toBe("macos");
    setNodePlatform("win32");
    expect(detectPlatform()).toBe("windows");
    setNodePlatform("linux");
    expect(detectPlatform()).toBe("linux");
  });

  test("passes an unmapped OS through rather than losing it", () => {
    setNodePlatform("freebsd");
    expect(detectPlatform()).toBe("freebsd");
  });

  test("never reports a bare runtime token when an OS is available", () => {
    setNodePlatform("darwin");
    expect(["node", "bun", "deno"]).not.toContain(detectPlatform());
  });

  test("prefers Deno's own OS accessor", () => {
    vi.stubGlobal("Deno", { build: { os: "darwin" } });
    expect(detectPlatform()).toBe("macos");
  });

  test("returns a runtime token only where there is genuinely no OS", () => {
    // A browser page has no host OS we're willing to read — we deliberately do
    // not sniff navigator.userAgentData, which is Chromium-only and a
    // fingerprinting surface.
    setNodePlatform("");
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(detectPlatform()).toBe("web");
  });

  test("always returns something within the backend cap", () => {
    expect(detectPlatform().length).toBeGreaterThan(0);
    expect(detectPlatform().length).toBeLessThanOrEqual(PLATFORM_MAX);
  });
});

test("sdk identifies this SDK and fits the backend cap", () => {
  expect(SDK_ID).toBe("js");
  expect(SDK_ID.length).toBeLessThanOrEqual(SDK_ID_MAX);
});

test("app_version is clamped to the backend limit (64) so it can't trigger a 400", () => {
  const m: Record<string, unknown> = {};
  applyTelemetry(m, "v".repeat(200));
  expect((m.app_version as string).length).toBe(APP_VERSION_MAX);
  // sdk_version, platform and sdk also respect their caps
  expect((m.sdk_version as string).length).toBeLessThanOrEqual(APP_VERSION_MAX);
  expect((m.platform as string).length).toBeLessThanOrEqual(PLATFORM_MAX);
  expect((m.sdk as string).length).toBeLessThanOrEqual(SDK_ID_MAX);
});

test("normal-length app_version is unchanged by the clamp", () => {
  const m: Record<string, unknown> = {};
  applyTelemetry(m, "1.2.3");
  expect(m.app_version).toBe("1.2.3");
});
