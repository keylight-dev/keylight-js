import { test, expect } from "vitest";
import { normalizeConfig, validateKeyFormat } from "../src/config.js";

test("defaults base url and trial duration (Rust parity)", () => {
  const c = normalizeConfig({ tenantId: "t", productId: "p" });
  expect(c.baseUrl).toBe("https://api.keylight.dev");
  expect(c.trialDurationDays).toBe(14); // Rust builder default
  expect(c.freeTierEnabled).toBe(false);
  expect(normalizeConfig({ tenantId: "t", productId: "p", trialDurationDays: 7 }).trialDurationDays).toBe(7);
});

test("maxOfflineDays defaults to 15; explicit number is kept; explicit null disables the cap", () => {
  expect(normalizeConfig({ tenantId: "t", productId: "p" }).maxOfflineDays).toBe(15);
  expect(normalizeConfig({ tenantId: "t", productId: "p", maxOfflineDays: 7 }).maxOfflineDays).toBe(7);
  expect(normalizeConfig({ tenantId: "t", productId: "p", maxOfflineDays: null }).maxOfflineDays).toBeNull();
});

test("validateKeyFormat enforces prefix + charset", () => {
  expect(validateKeyFormat("ABCD-1234", undefined)).toBe(true);
  expect(validateKeyFormat("ABCD_1234", undefined)).toBe(false);
  expect(validateKeyFormat("PRO-1", "PRO-")).toBe(true);
  expect(validateKeyFormat("LITE-1", "PRO-")).toBe(false);
  expect(validateKeyFormat("", undefined)).toBe(false);
  // Prefix match is case-insensitive (Rust to_uppercase on both sides).
  expect(validateKeyFormat("pro-1", "PRO-")).toBe(true);
  expect(validateKeyFormat("PRO-1", "pro-")).toBe(true);
});
