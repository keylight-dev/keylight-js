export type KeylightErrorCode =
  | "client_error" | "server_error" | "rate_limited" | "timeout"
  | "network_failure" | "invalid_response" | "lease_verification_failed"
  | "storage" | "no_stored_license" | "config";

export class KeylightError extends Error {
  constructor(public readonly code: KeylightErrorCode, message: string) {
    super(message);
    this.name = "KeylightError";
  }
}
export class ClientError extends KeylightError {
  constructor(public readonly status: number, message: string) { super("client_error", message); }
}
export class ServerError extends KeylightError {
  constructor(public readonly status: number) { super("server_error", `Server error (HTTP ${status})`); }
}
export class RateLimited extends KeylightError {
  constructor(public readonly retryAfter: number) { super("rate_limited", "Rate limited"); }
}
export class TimeoutError extends KeylightError { constructor() { super("timeout", "Request timed out"); } }
export class NetworkError extends KeylightError { constructor(m: string) { super("network_failure", m); } }
export class InvalidResponse extends KeylightError { constructor() { super("invalid_response", "Invalid response"); } }
export class LeaseVerificationFailed extends KeylightError { constructor() { super("lease_verification_failed", "Lease verification failed"); } }
export class StorageError extends KeylightError { constructor(m: string) { super("storage", m); } }
export class NoStoredLicense extends KeylightError { constructor() { super("no_stored_license", "No stored license"); } }
export class ConfigError extends KeylightError { constructor(m: string) { super("config", m); } }
