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

/** Inject telemetry fields into a request body map (parity with Rust telemetry::apply). */
export function applyTelemetry(map: Record<string, unknown>, appVersion: string | undefined): void {
  map.sdk_version = SDK_VERSION;
  map.platform = detectPlatform();
  if (appVersion) map.app_version = appVersion;
}
