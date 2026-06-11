import { test, expect } from "vitest";
import { SDK_VERSION } from "../src/index.js";
test("package loads", () => { expect(SDK_VERSION).toBe("0.1.0"); });
