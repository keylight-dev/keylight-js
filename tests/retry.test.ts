import { test, expect } from "vitest";
import { backoffMs, statusRetryable, decide } from "../src/retry.js";

test("backoff is capped", () => {
  expect(backoffMs(1)).toBe(500);
  expect(backoffMs(2)).toBe(1000);
  expect(backoffMs(10)).toBe(4000);
});

test("retryable statuses", () => {
  expect(statusRetryable(408)).toBe(true);
  expect(statusRetryable(429)).toBe(true);
  expect(statusRetryable(503)).toBe(true);
  expect(statusRetryable(400)).toBe(false);
});

test("decide stops at max attempts and honors retry-after on 429", () => {
  expect(decide(500, 3, undefined)).toEqual({ kind: "stop" });
  expect(decide(429, 1, 2)).toEqual({ kind: "retry", ms: 2000 });
  expect(decide(503, 1, undefined)).toEqual({ kind: "retry", ms: 500 });
});
