import { test, expect, describe, afterEach, vi } from "vitest";
import {
  applyTelemetry, detectPlatform, detectArch, normalizeOsVersion, SDK_ID,
  APP_VERSION_MAX, PLATFORM_MAX, SDK_ID_MAX,
} from "../src/telemetry.js";

test("applies sdk_version + platform + sdk; app_version only when provided", async () => {
  const m: Record<string, unknown> = {};
  await applyTelemetry(m, "1.2.3");
  expect(typeof m.sdk_version).toBe("string");
  expect(typeof m.platform).toBe("string");
  expect(m.sdk).toBe("js");
  expect(m.app_version).toBe("1.2.3");

  const m2: Record<string, unknown> = {};
  await applyTelemetry(m2, undefined);
  expect("app_version" in m2).toBe(false);

  // Empty string is falsy -> omitted, matching Rust's Option::None.
  const m3: Record<string, unknown> = {};
  await applyTelemetry(m3, "");
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

test("app_version is clamped to the backend limit (64) so it can't trigger a 400", async () => {
  const m: Record<string, unknown> = {};
  await applyTelemetry(m, "v".repeat(200));
  expect((m.app_version as string).length).toBe(APP_VERSION_MAX);
  // sdk_version, platform and sdk also respect their caps
  expect((m.sdk_version as string).length).toBeLessThanOrEqual(APP_VERSION_MAX);
  expect((m.platform as string).length).toBeLessThanOrEqual(PLATFORM_MAX);
  expect((m.sdk as string).length).toBeLessThanOrEqual(SDK_ID_MAX);
});

test("normal-length app_version is unchanged by the clamp", async () => {
  const m: Record<string, unknown> = {};
  await applyTelemetry(m, "1.2.3");
  expect(m.app_version).toBe("1.2.3");
});

describe("device dimensions (Phase 3): arch + os_version", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const realArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    Object.defineProperty(process, "arch", realArch);
    vi.unstubAllGlobals();
  });
  const setNode = (platform: string, arch: string) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    Object.defineProperty(process, "arch", { value: arch, configurable: true });
  };

  test("Node arch maps onto the canonical spellings the backend allow-lists", () => {
    setNode("darwin", "arm64");
    expect(detectArch()).toBe("arm64");
    setNode("win32", "x64");
    expect(detectArch()).toBe("x86_64");
  });

  test("an arch off the allow-list is omitted, not passed through", () => {
    // 32-bit and exotic ISAs would mint one-off breakdown buckets server-side;
    // the backend would null them anyway — never send junk.
    setNode("win32", "ia32");
    expect(detectArch()).toBeUndefined();
    setNode("linux", "riscv64");
    expect(detectArch()).toBeUndefined();
  });

  test("Deno's own arch accessor is preferred and canonicalized", () => {
    vi.stubGlobal("Deno", { build: { os: "darwin", arch: "aarch64" } });
    expect(detectArch()).toBe("arm64");
  });

  test("os_version keeps only a leading dotted-numeric prefix", () => {
    // A Linux kernel release is not a dotted-numeric version as-is; the worker
    // would null it wholesale, so we strip to the numeric prefix client-side.
    expect(normalizeOsVersion("6.8.0-45-generic")).toBe("6.8.0");
    expect(normalizeOsVersion("24.5.0")).toBe("24.5.0");
    expect(normalizeOsVersion(" 14.5 ")).toBe("14.5");
  });

  test("a release with no dotted-numeric prefix is omitted entirely", () => {
    expect(normalizeOsVersion("Sonoma")).toBeUndefined();
    expect(normalizeOsVersion("v14.5")).toBeUndefined();
    expect(normalizeOsVersion("")).toBeUndefined();
    expect(normalizeOsVersion(undefined)).toBeUndefined();
  });

  test("under Node both fields ride the body with canonical values", async () => {
    // Real machine, real os.release(): darwin/linux both report dotted-numeric.
    const m: Record<string, unknown> = {};
    await applyTelemetry(m, "1.2.3");
    expect(m.arch).toMatch(/^(arm64|x86_64)$/);
    expect(m.os_version).toMatch(/^\d+(\.\d+)*$/);
  });

  test("browser/edge runtimes send neither field", async () => {
    // No reliable, non-fingerprinty source exists there; the worker treats
    // absence as absent.
    setNode("", "arm64");
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const m: Record<string, unknown> = {};
    await applyTelemetry(m, "1.2.3");
    expect(m.platform).toBe("web");
    expect("arch" in m).toBe(false);
    expect("os_version" in m).toBe(false);
  });

  test("device_class is never sent — the worker only honors it from iOS SDKs", async () => {
    const m: Record<string, unknown> = {};
    await applyTelemetry(m, "1.2.3");
    expect("device_class" in m).toBe(false);
  });
});
