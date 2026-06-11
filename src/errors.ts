export type KeylightErrorCode =
  | "client_error" | "server_error" | "rate_limited" | "timeout"
  | "network_failure" | "invalid_response" | "lease_verification_failed"
  | "storage" | "no_stored_license" | "config";

/**
 * Base class for every error the SDK throws. Branch on `.code` (stable, minify-safe)
 * or `instanceof`. `.name` is set per subclass so logs / stack traces / error
 * aggregators (Sentry, Datadog) identify the specific error type — names are written
 * as literals so they survive minification in the IIFE build.
 */
export class KeylightError extends Error {
  constructor(public readonly code: KeylightErrorCode, message: string) {
    super(message);
    this.name = "KeylightError";
  }
}
export class ClientError extends KeylightError {
  constructor(public readonly status: number, message: string) { super("client_error", message); this.name = "ClientError"; }
}
export class ServerError extends KeylightError {
  constructor(public readonly status: number) { super("server_error", `Server error (HTTP ${status})`); this.name = "ServerError"; }
}
export class RateLimited extends KeylightError {
  /** @param retryAfter seconds the caller should wait before retrying */
  constructor(public readonly retryAfter: number) { super("rate_limited", "Rate limited"); this.name = "RateLimited"; }
}
export class TimeoutError extends KeylightError { constructor() { super("timeout", "Request timed out"); this.name = "TimeoutError"; } }
export class NetworkError extends KeylightError { constructor(m: string) { super("network_failure", m); this.name = "NetworkError"; } }
export class InvalidResponse extends KeylightError { constructor() { super("invalid_response", "Invalid response"); this.name = "InvalidResponse"; } }
export class LeaseVerificationFailed extends KeylightError { constructor() { super("lease_verification_failed", "Lease verification failed"); this.name = "LeaseVerificationFailed"; } }
export class StorageError extends KeylightError { constructor(m: string) { super("storage", m); this.name = "StorageError"; } }
export class NoStoredLicense extends KeylightError { constructor() { super("no_stored_license", "No stored license"); this.name = "NoStoredLicense"; } }
export class ConfigError extends KeylightError { constructor(m: string) { super("config", m); this.name = "ConfigError"; } }
