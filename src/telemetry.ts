import { SDK_VERSION } from "./version.js";

/** Identifies this SDK to the backend, sent as `sdk`. */
export const SDK_ID = "js";

/**
 * Map a Node-style `process.platform` value onto the canonical OS token the
 * other Keylight SDKs send (`macos` / `windows` / `linux`).
 */
function osFromNodePlatform(p: string): string {
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  if (p === "linux") return "linux";
  return p; // freebsd, aix, sunos… pass through rather than losing it
}

/**
 * The OS this app is running on, as a canonical token.
 *
 * Until 0.1.6 this reported the *runtime* — `node`, `deno`, `bun`, `web` — which
 * meant every Electron app on every OS reported `node`, and the platform
 * breakdown could not tell a Windows install base from a macOS one. The other
 * SDKs all report the OS, so JS was the odd one out and the breakdown was
 * incomparable across SDKs.
 *
 * Where no OS exists to report — a page in a browser, an isolate on the edge —
 * the runtime token is still the honest answer, and is kept. We deliberately do
 * NOT read `navigator.userAgentData.platform` to guess the OS in a browser: it
 * is a fingerprinting surface, it is Chromium-only, and this SDK's stated
 * position is to avoid the User-Agent for privacy (see `machineName`).
 */
export function detectPlatform(): string {
  const g = globalThis as Record<string, unknown>;

  // Deno exposes the OS directly and does not always populate `process`.
  const deno = g.Deno as { build?: { os?: string } } | undefined;
  if (deno?.build?.os) return osFromNodePlatform(deno.build.os);

  // Node, Electron's main process, and Bun all populate `process.platform`.
  if (typeof process !== "undefined" && typeof process.platform === "string" && process.platform) {
    return osFromNodePlatform(process.platform);
  }

  // No OS to report from here on.
  if ("WorkerGlobalScope" in g && "caches" in g && !("window" in g)) return "workers";
  if (typeof window !== "undefined" || typeof document !== "undefined") return "web";
  return "unknown";
}

// Backend zod caps (activate/validate/keyless routes): app_version & sdk_version <= 64, platform <= 32, sdk <= 16, os_version <= 32.
// Clamp client-side so an over-long value is recorded (truncated) instead of failing the request with a 400.
export const APP_VERSION_MAX = 64;
export const PLATFORM_MAX = 32;
export const SDK_ID_MAX = 16;
export const OS_VERSION_MAX = 32;

// Canonical CPU-architecture spellings, shared with the other SDKs. Only the
// two families on the backend's allow-list are ever sent — 32-bit and exotic
// ISAs would be nulled server-side anyway, so they are omitted at the source
// rather than shipped as junk.
const ARCH_CANONICAL: Record<string, string> = {
  arm64: "arm64", // Node/Bun spelling
  aarch64: "arm64", // Deno spelling
  x64: "x86_64", // Node/Bun spelling
  x86_64: "x86_64", // Deno spelling
};

/**
 * The CPU architecture as a canonical token (`arm64` / `x86_64`), or undefined.
 *
 * Browsers and edge isolates report nothing: there is no reliable,
 * non-fingerprinty source for the architecture there (same stance as
 * `detectPlatform`, which refuses `navigator.userAgentData`), and the backend
 * treats absence as absent.
 */
export function detectArch(): string | undefined {
  const g = globalThis as Record<string, unknown>;

  // Deno reports the target triple's arch spelling directly.
  const deno = g.Deno as { build?: { arch?: string } } | undefined;
  if (deno?.build?.arch) return ARCH_CANONICAL[deno.build.arch];

  // Same guard as detectPlatform: a populated process.platform is the signal
  // we're really in Node/Bun/Electron rather than looking at a browser shim.
  if (
    typeof process !== "undefined" && typeof process.platform === "string" && process.platform &&
    typeof process.arch === "string"
  ) {
    return ARCH_CANONICAL[process.arch];
  }
  return undefined;
}

/**
 * Reduce a raw OS release string to the dotted-numeric shape the backend
 * accepts (it nulls anything else). A Linux kernel release like
 * `6.8.0-45-generic` is stripped to its leading `6.8.0`; a string with no
 * dotted-numeric prefix at all ("Sonoma") is omitted rather than sent as junk.
 */
export function normalizeOsVersion(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d+(?:\.\d+)*)/.exec(raw.trim());
  if (!m || m[1].length > OS_VERSION_MAX) return undefined;
  return m[1];
}

/** One `sw_vers` child process per process lifetime; concurrent callers share the promise. */
let macProductVersion: Promise<string | undefined> | undefined;

/**
 * macOS's *marketing* version (`26.1`), via `sw_vers -productVersion`.
 *
 * `os.release()` returns the Darwin kernel version (`25.1.0`) instead, which is
 * a different vocabulary from the one Swift (`ProcessInfo`) and Rust (`sw_vers`)
 * report. Sending it would split every macOS install across two families of
 * bucket in the same `osVersion` breakdown — the same OS counted twice under
 * two names. One child process, once per process, is the price of a number
 * that can be compared across SDKs.
 */
function readMacProductVersion(): Promise<string | undefined> {
  macProductVersion ??= (async () => {
    try {
      const { execFile } = await import("node:child_process");
      return await new Promise<string | undefined>((resolve) => {
        // Timed out so a wedged binary can never hold up an activation.
        execFile("sw_vers", ["-productVersion"], { timeout: 2000 }, (err, stdout) => {
          resolve(err ? undefined : stdout.trim() || undefined);
        });
      });
    } catch { return undefined; }
  })();
  return macProductVersion;
}

/**
 * The host OS's release version, where a host OS exists to ask: the marketing
 * version on macOS, the kernel release on Linux, the build on Windows — matching
 * what the Swift and Rust SDKs send for each.
 *
 * On macOS it is `sw_vers` or nothing. The kernel version is not a fallback:
 * it is true but in the wrong vocabulary, and a wrong-vocabulary value mints a
 * phantom bucket that looks like a real macOS release. An absent row is the
 * honest failure.
 *
 * Browser/edge runtimes return undefined: no OS to report, and nothing
 * non-fingerprinty to read one from.
 */
export async function readOsRelease(): Promise<string | undefined> {
  const g = globalThis as Record<string, unknown>;

  // Deno's own accessor first (permission-gated behind --allow-sys).
  const deno = g.Deno as {
    build?: { os?: string };
    osRelease?: () => string;
    permissions?: { query?: (d: unknown) => Promise<{ state?: string }> };
  } | undefined;
  if (deno?.osRelease) {
    if (deno.build?.os === "darwin") {
      // Deno reaches `sw_vers` only by spawning, which needs --allow-run. The
      // query itself never prompts, so a run that wasn't granted it simply
      // reports no OS version — a telemetry field does not get to raise a
      // permission dialog at the user.
      let granted = false;
      try {
        granted = (await deno.permissions?.query?.({ name: "run", command: "sw_vers" }))?.state === "granted";
      } catch { granted = false; }
      return granted ? readMacProductVersion() : undefined;
    }
    try { return deno.osRelease(); } catch { return undefined; }
  }
  // Node, Electron's main process, Bun. Guarded dynamic import, the same
  // pattern store.ts and machine.ts use — never reached in a browser bundle.
  if (typeof process !== "undefined" && typeof process.platform === "string" && process.platform) {
    if (process.platform === "darwin") return readMacProductVersion();
    try {
      const os = await import("node:os");
      return os.release();
    } catch { return undefined; }
  }
  return undefined;
}

/**
 * Bucket a CPU core count into the shared cross-SDK vocabulary.
 *
 * The bucket, never the number. A developer proxying their own app must not
 * see a licensing SDK report their exact core count — that reads as
 * fingerprinting — so the precise value never crosses the wire.
 *
 * Ranges are inclusive of both endpoints: 4 cores is the top of `3-4`, 5 the
 * bottom of `5-8`. The other four SDKs draw the lines in the same places; a
 * boundary that disagrees splits one machine population across two buckets.
 */
export function bucketCpuCores(cores: number | undefined): string | undefined {
  if (typeof cores !== "number" || !Number.isInteger(cores) || cores < 1) return undefined;
  if (cores <= 2) return "1-2";
  if (cores <= 4) return "3-4";
  if (cores <= 8) return "5-8";
  if (cores <= 16) return "9-16";
  return "17+";
}

const GIB = 1024 ** 3;

/**
 * Bucket physical RAM, taken as a raw byte count, into the shared cross-SDK
 * vocabulary.
 *
 * Buckets are lower-inclusive and upper-exclusive — `4-8GB` means
 * 4GiB <= x < 8GiB — so exactly 8GiB lands in `8-16GB`. The comparison is
 * against the raw bytes with GiB = 1024^3 and no pre-rounding: an OS reports
 * physical RAM a hair under the round figure often enough that rounding first
 * would push a 16GB machine down a bucket.
 */
export function bucketMemoryBytes(bytes: number | undefined): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 4 * GIB) return "<4GB";
  if (bytes < 8 * GIB) return "4-8GB";
  if (bytes < 16 * GIB) return "8-16GB";
  if (bytes < 32 * GIB) return "16-32GB";
  if (bytes < 64 * GIB) return "32-64GB";
  return "64GB+";
}

/**
 * True where a host OS exists to ask about hardware — Node, Bun, Electron's
 * main process, Deno. False in a browser page or an edge isolate.
 */
function hasHostOs(): boolean {
  const g = globalThis as Record<string, unknown>;
  const deno = g.Deno as { build?: { os?: string } } | undefined;
  if (deno?.build?.os) return true;
  return typeof process !== "undefined" && typeof process.platform === "string" && !!process.platform;
}

/**
 * The number of logical CPUs, or undefined where there is no host OS to ask.
 *
 * Browsers and edge isolates report nothing: `navigator.hardwareConcurrency`
 * is a documented fingerprinting surface, and this SDK refuses it for the same
 * reason `detectArch` refuses `navigator.userAgentData`.
 */
export async function readCpuCores(): Promise<number | undefined> {
  if (!hasHostOs()) return undefined;
  try {
    // Guarded dynamic import, the same pattern readOsRelease uses — never
    // reached in a browser bundle.
    const os = await import("node:os");
    const n = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

/**
 * Total physical memory in bytes, or undefined where there is no host OS.
 *
 * Browsers and edge isolates report nothing: `navigator.deviceMemory` is a
 * fingerprinting surface, same stance as above.
 */
export async function readTotalMemoryBytes(): Promise<number | undefined> {
  if (!hasHostOs()) return undefined;
  try {
    const os = await import("node:os");
    const bytes = os.totalmem();
    return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  } catch { return undefined; }
}

/**
 * Inject telemetry fields into a request body map (parity with Rust
 * telemetry::apply), clamped to backend limits. Every field is optional on the
 * wire; whatever cannot be read cleanly is omitted, never approximated.
 *
 * `device_class` is deliberately never sent: the worker only honors it from
 * iOS SDKs and derives every other platform's class from the OS token.
 */
export async function applyTelemetry(map: Record<string, unknown>, appVersion: string | undefined): Promise<void> {
  map.sdk_version = SDK_VERSION.slice(0, APP_VERSION_MAX);
  map.platform = detectPlatform().slice(0, PLATFORM_MAX);
  // `platform` alone no longer identifies the SDK now that it carries the OS
  // like every other SDK's does — say so explicitly instead.
  map.sdk = SDK_ID.slice(0, SDK_ID_MAX);
  if (appVersion) map.app_version = appVersion.slice(0, APP_VERSION_MAX);

  const arch = detectArch();
  if (arch) map.arch = arch;
  const osVersion = normalizeOsVersion(await readOsRelease());
  if (osVersion) map.os_version = osVersion;

  // Coarse capacity buckets only — the exact core count and byte figure are
  // deliberately never put on the wire.
  const cpuCores = bucketCpuCores(await readCpuCores());
  if (cpuCores) map.cpu_cores = cpuCores;
  const memory = bucketMemoryBytes(await readTotalMemoryBytes());
  if (memory) map.memory = memory;
}
