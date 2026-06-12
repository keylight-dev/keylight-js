import { SDK_VERSION } from "./version.js";

export function detectPlatform(): string {
  const g = globalThis as Record<string, unknown>;
  if ("Deno" in g) return "deno";
  if ("Bun" in g) return "bun";
  if (typeof process !== "undefined" && (process as { versions?: { node?: string } }).versions?.node) return "node";
  if ("WorkerGlobalScope" in g && "caches" in g && !("window" in g)) return "workers";
  if (typeof window !== "undefined" || typeof document !== "undefined") return "web";
  return "unknown";
}

// Backend zod caps (activate/validate/keyless routes): app_version & sdk_version <= 64, platform <= 32.
// Clamp client-side so an over-long value is recorded (truncated) instead of failing the request with a 400.
export const APP_VERSION_MAX = 64;
export const PLATFORM_MAX = 32;

/** Inject telemetry fields into a request body map (parity with Rust telemetry::apply), clamped to backend limits. */
export function applyTelemetry(map: Record<string, unknown>, appVersion: string | undefined): void {
  map.sdk_version = SDK_VERSION.slice(0, APP_VERSION_MAX);
  map.platform = detectPlatform().slice(0, PLATFORM_MAX);
  if (appVersion) map.app_version = appVersion.slice(0, APP_VERSION_MAX);
}
