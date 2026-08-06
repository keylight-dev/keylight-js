import { test, expect, describe, afterEach, vi } from "vitest";
import {
  applyTelemetry, detectPlatform, detectArch, normalizeOsVersion, readOsRelease, SDK_ID,
  APP_VERSION_MAX, PLATFORM_MAX, SDK_ID_MAX,
  bucketCpuCores, bucketMemoryBytes, readCpuCores, readTotalMemoryBytes,
} from "../src/telemetry.js";
import { execFileSync } from "node:child_process";
import { release } from "node:os";

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

  const onMac = process.platform === "darwin";
  test.runIf(onMac)("macOS reports the marketing version, not the Darwin kernel version", async () => {
    // The bucket-parity check: Swift (ProcessInfo) and Rust (sw_vers) both send
    // the marketing version, so `os.release()` here would split one macOS
    // release across two names in the same osVersion breakdown.
    const marketing = execFileSync("sw_vers", ["-productVersion"]).toString().trim();
    expect(await readOsRelease()).toBe(marketing);

    const m: Record<string, unknown> = {};
    await applyTelemetry(m, "1.2.3");
    expect(m.os_version).toBe(normalizeOsVersion(marketing));
    // Same machine, and the two vocabularies really do disagree — otherwise
    // this test would pass on a coincidence rather than on the fix.
    expect(release()).not.toBe(marketing);
  });

  test("Deno on macOS omits the version unless --allow-run was already granted", async () => {
    // Querying never prompts; spawning without the grant would. A telemetry
    // field does not get to raise a permission dialog, so it reports nothing —
    // and never the kernel version, which would mint a phantom bucket.
    vi.stubGlobal("Deno", {
      build: { os: "darwin", arch: "aarch64" },
      osRelease: () => "25.1.0",
      permissions: { query: async () => ({ state: "prompt" }) },
    });
    expect(await readOsRelease()).toBeUndefined();
  });

  test("Deno off macOS still uses its own osRelease accessor", async () => {
    vi.stubGlobal("Deno", { build: { os: "linux", arch: "x86_64" }, osRelease: () => "6.8.0-45-generic" });
    expect(await readOsRelease()).toBe("6.8.0-45-generic");
  });

  test("device_class is never sent — the worker only honors it from iOS SDKs", async () => {
    const m: Record<string, unknown> = {};
    await applyTelemetry(m, "1.2.3");
    expect("device_class" in m).toBe(false);
  });
});

describe("device capacity buckets: cpu_cores + memory", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    vi.unstubAllGlobals();
  });

  const GiB = 1024 ** 3;

  test("core buckets are inclusive of both endpoints", () => {
    // Cross-SDK contract: 4 cores is the TOP of "3-4", 5 the BOTTOM of "5-8".
    // A boundary that disagrees with Swift/Rust/C#/C++ splits one machine
    // population across two buckets — the bug just fixed for macOS os_version.
    expect(bucketCpuCores(1)).toBe("1-2");
    expect(bucketCpuCores(2)).toBe("1-2");
    expect(bucketCpuCores(3)).toBe("3-4");
    expect(bucketCpuCores(4)).toBe("3-4");
    expect(bucketCpuCores(5)).toBe("5-8");
    expect(bucketCpuCores(8)).toBe("5-8");
    expect(bucketCpuCores(9)).toBe("9-16");
    expect(bucketCpuCores(16)).toBe("9-16");
    expect(bucketCpuCores(17)).toBe("17+");
    expect(bucketCpuCores(256)).toBe("17+");
  });

  test("a nonsense core count is omitted, never bucketed", () => {
    expect(bucketCpuCores(0)).toBeUndefined();
    expect(bucketCpuCores(-4)).toBeUndefined();
    expect(bucketCpuCores(2.5)).toBeUndefined();
    expect(bucketCpuCores(Number.NaN)).toBeUndefined();
    expect(bucketCpuCores(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("memory buckets are lower-inclusive and upper-exclusive, in GiB", () => {
    // "4-8GB" means 4GiB <= x < 8GiB, so exactly 8GiB lands in "8-16GB".
    expect(bucketMemoryBytes(3.9 * GiB)).toBe("<4GB");
    expect(bucketMemoryBytes(4 * GiB)).toBe("4-8GB");
    expect(bucketMemoryBytes(7.9 * GiB)).toBe("4-8GB");
    expect(bucketMemoryBytes(8 * GiB)).toBe("8-16GB");
    expect(bucketMemoryBytes(16 * GiB)).toBe("16-32GB");
    expect(bucketMemoryBytes(32 * GiB)).toBe("32-64GB");
    expect(bucketMemoryBytes(64 * GiB)).toBe("64GB+");
    expect(bucketMemoryBytes(128 * GiB)).toBe("64GB+");
  });

  test("real-world RAM that never lands on a power of two still buckets right", () => {
    // Physical RAM is reported in raw bytes and comes up a hair short; rounding
    // first would push a 16GB Mac down into "8-16GB".
    expect(bucketMemoryBytes(17_179_869_184)).toBe("16-32GB"); // 16 GiB exactly
    expect(bucketMemoryBytes(16_000_000_000)).toBe("8-16GB"); // 16 GB decimal < 16 GiB
    expect(bucketMemoryBytes(8_589_934_592)).toBe("8-16GB"); // 8 GiB exactly
  });

  test("a nonsense byte count is omitted, never bucketed", () => {
    expect(bucketMemoryBytes(0)).toBeUndefined();
    expect(bucketMemoryBytes(-1)).toBeUndefined();
    expect(bucketMemoryBytes(Number.NaN)).toBeUndefined();
    expect(bucketMemoryBytes(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(bucketMemoryBytes(undefined)).toBeUndefined();
  });

  test("the raw value never crosses the wire — only the bucket string", async () => {
    const m: Record<string, unknown> = {};
    await applyTelemetry(m, "1.2.3");
    expect(m.cpu_cores).toMatch(/^(1-2|3-4|5-8|9-16|17\+)$/);
    expect(m.memory).toMatch(/^(<4GB|4-8GB|8-16GB|16-32GB|32-64GB|64GB\+)$/);
    // No exact count or byte figure anywhere in the body: every value is a
    // string, and neither raw number appears among them.
    expect(Object.values(m).every((v) => typeof v === "string")).toBe(true);
    expect(JSON.stringify(m)).not.toContain(String(await readTotalMemoryBytes()));
    expect(Object.values(m)).not.toContain(String(await readCpuCores()));
  });

  test("browser/edge runtimes send neither field", async () => {
    // navigator.hardwareConcurrency and navigator.deviceMemory are documented
    // fingerprinting surfaces; this SDK refuses them, as it refuses
    // navigator.userAgentData for arch.
    Object.defineProperty(process, "platform", { value: "", configurable: true });
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { hardwareConcurrency: 8, deviceMemory: 8 });
    const m: Record<string, unknown> = {};
    await applyTelemetry(m, "1.2.3");
    expect(m.platform).toBe("web");
    expect("cpu_cores" in m).toBe(false);
    expect("memory" in m).toBe(false);
    expect(await readCpuCores()).toBeUndefined();
    expect(await readTotalMemoryBytes()).toBeUndefined();
  });
});
