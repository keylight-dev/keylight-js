import { test, expect } from "vitest";
import { normalizeConfig, validateKeyFormat } from "../src/config.js";

test("defaults base url and trial duration", () => {
  const c = normalizeConfig({ tenantId: "t", productId: "p" });
  expect(c.baseUrl).toBe("https://api.keylight.dev");
  expect(c.trialDurationDays).toBe(0);
  expect(c.freeTierEnabled).toBe(false);
});

test("validateKeyFormat enforces prefix + charset", () => {
  expect(validateKeyFormat("ABCD-1234", undefined)).toBe(true);
  expect(validateKeyFormat("ABCD_1234", undefined)).toBe(false);
  expect(validateKeyFormat("PRO-1", "PRO-")).toBe(true);
  expect(validateKeyFormat("LITE-1", "PRO-")).toBe(false);
  expect(validateKeyFormat("", undefined)).toBe(false);
});
