import { test, expect } from "vitest";
import { SDK_VERSION } from "../src/index.js";
// Smoke: the entry point loads and exports a semver string. The exact value is
// guarded against package.json drift in version.test.ts — don't hardcode it here.
test("package loads", () => { expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/); });
