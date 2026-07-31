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

// Backend zod caps (activate/validate/keyless routes): app_version & sdk_version <= 64, platform <= 32, sdk <= 16.
// Clamp client-side so an over-long value is recorded (truncated) instead of failing the request with a 400.
export const APP_VERSION_MAX = 64;
export const PLATFORM_MAX = 32;
export const SDK_ID_MAX = 16;

/** Inject telemetry fields into a request body map (parity with Rust telemetry::apply), clamped to backend limits. */
export function applyTelemetry(map: Record<string, unknown>, appVersion: string | undefined): void {
  map.sdk_version = SDK_VERSION.slice(0, APP_VERSION_MAX);
  map.platform = detectPlatform().slice(0, PLATFORM_MAX);
  // `platform` alone no longer identifies the SDK now that it carries the OS
  // like every other SDK's does — say so explicitly instead.
  map.sdk = SDK_ID.slice(0, SDK_ID_MAX);
  if (appVersion) map.app_version = appVersion.slice(0, APP_VERSION_MAX);
}
