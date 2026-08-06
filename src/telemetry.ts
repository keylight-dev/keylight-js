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

/**
 * The host OS's release version, where a host OS exists to ask. On macOS this
 * is the Darwin kernel version (e.g. `24.5.0`), not the marketing version —
 * reading the latter would cost a child process (`sw_vers`), which telemetry
 * does not get to spend.
 *
 * Browser/edge runtimes return undefined: no OS to report, and nothing
 * non-fingerprinty to read one from.
 */
async function readOsRelease(): Promise<string | undefined> {
  const g = globalThis as Record<string, unknown>;

  // Deno's own accessor first (permission-gated behind --allow-sys).
  const deno = g.Deno as { osRelease?: () => string } | undefined;
  if (deno?.osRelease) {
    try { return deno.osRelease(); } catch { return undefined; }
  }
  // Node, Electron's main process, Bun. Guarded dynamic import, the same
  // pattern store.ts and machine.ts use — never reached in a browser bundle.
  if (typeof process !== "undefined" && typeof process.platform === "string" && process.platform) {
    try {
      const os = await import("node:os");
      return os.release();
    } catch { return undefined; }
  }
  return undefined;
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
}
