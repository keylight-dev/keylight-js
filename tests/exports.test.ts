import { test, expect } from "vitest";
import * as KL from "../src/index.js";

test("public surface is exported", () => {
  for (const name of ["Keylight", "verifyLease", "SKEW_SECONDS", "parseKeyset", "KeylightError", "MemoryStore", "SDK_VERSION"]) {
    expect(name in KL, name).toBe(true);
  }
});
