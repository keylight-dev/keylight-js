import { test, expect } from "vitest";
import { resolveState, lifecycleEvent } from "../src/state.js";

test("active + current lease -> Licensed", () => {
  expect(resolveState("active", true, true, { kind: "not_started" }, false)).toEqual({ kind: "Licensed" });
});
test("fallback -> Limited", () => {
  expect(resolveState("fallback", true, true, { kind: "not_started" }, false)).toEqual({ kind: "Limited" });
});
test("no lease, no license, free tier on -> FreeTier", () => {
  expect(resolveState(null, false, false, { kind: "not_started" }, true)).toEqual({ kind: "FreeTier" });
});
test("Licensed -> Expired emits Cancelled", () => {
  expect(lifecycleEvent({ kind: "Licensed" }, { kind: "Expired" }, false)).toBe("Cancelled");
});
test("Licensed -> Licensed with later expiry emits Renewed", () => {
  expect(lifecycleEvent({ kind: "Licensed" }, { kind: "Licensed" }, true)).toBe("Renewed");
});

// Additional parity tests — mirrors Rust state.rs tests exactly
test("no license, trial active -> Trial", () => {
  expect(resolveState(null, false, false, { kind: "active", daysLeft: 5 }, false)).toEqual({ kind: "Trial", daysLeft: 5 });
});
test("nothing -> Invalid", () => {
  expect(resolveState(null, false, false, { kind: "not_started" }, false)).toEqual({ kind: "Invalid" });
});
test("expired lease -> Expired", () => {
  expect(resolveState("expired", false, false, { kind: "not_started" }, false)).toEqual({ kind: "Expired" });
});
test("had_license + no valid lease -> Expired (had_license gate)", () => {
  // stale active (leaseCurrent=false) falls through to had_license -> Expired
  expect(resolveState("active", false, true, { kind: "not_started" }, false)).toEqual({ kind: "Expired" });
});

// lifecycle_event parity
test("Licensed -> Limited emits Cancelled", () => {
  expect(lifecycleEvent({ kind: "Licensed" }, { kind: "Limited" }, false)).toBe("Cancelled");
});
test("Expired -> Licensed emits Restored", () => {
  expect(lifecycleEvent({ kind: "Expired" }, { kind: "Licensed" }, false)).toBe("Restored");
});
test("Limited -> Licensed emits Restored", () => {
  expect(lifecycleEvent({ kind: "Limited" }, { kind: "Licensed" }, false)).toBe("Restored");
});
test("Invalid -> Licensed emits Restored", () => {
  expect(lifecycleEvent({ kind: "Invalid" }, { kind: "Licensed" }, false)).toBe("Restored");
});
test("Trial -> Expired emits Expired", () => {
  expect(lifecycleEvent({ kind: "Trial", daysLeft: 1 }, { kind: "Expired" }, false)).toBe("Expired");
});
test("Expired -> Expired emits null (no duplicate event)", () => {
  expect(lifecycleEvent({ kind: "Expired" }, { kind: "Expired" }, false)).toBeNull();
});
test("Licensed -> Licensed without later expiry emits null", () => {
  expect(lifecycleEvent({ kind: "Licensed" }, { kind: "Licensed" }, false)).toBeNull();
});
test("Trial tick (no boundary) emits null", () => {
  expect(lifecycleEvent({ kind: "Trial", daysLeft: 3 }, { kind: "Trial", daysLeft: 2 }, false)).toBeNull();
});
