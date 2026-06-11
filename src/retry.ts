export const MAX_ATTEMPTS = 3;
const BASE_MS = 500, CAP_MS = 4000, MAX_SLEEP_MS = 3_600_000;

export type RetryDecision = { kind: "retry"; ms: number } | { kind: "stop" };

export function backoffMs(attempt: number): number {
  return Math.min(BASE_MS * 2 ** (Math.max(attempt, 1) - 1), CAP_MS);
}
export function clampSleepMs(ms: number): number { return Math.min(ms, MAX_SLEEP_MS); }
export function statusRetryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}
export function jitterMs(): number { return Math.floor(Math.random() * 250); }

export function decide(status: number, attempt: number, retryAfterSecs?: number): RetryDecision {
  if (attempt >= MAX_ATTEMPTS || !statusRetryable(status)) return { kind: "stop" };
  const raw = status === 429 && retryAfterSecs != null ? retryAfterSecs * 1000 : backoffMs(attempt);
  return { kind: "retry", ms: clampSleepMs(raw) };
}
