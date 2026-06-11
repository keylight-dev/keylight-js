import { test, expect } from "vitest";
import { SDK_VERSION } from "../src/version.js";
import pkg from "../package.json" with { type: "json" };

test("SDK_VERSION matches package.json version (no drift)", () => {
  expect(SDK_VERSION).toBe((pkg as { version: string }).version);
});
