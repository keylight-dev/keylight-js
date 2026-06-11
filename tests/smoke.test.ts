import { test, expect } from "vitest";
import { SDK_NAME } from "../src/index.js";
test("package loads", () => { expect(SDK_NAME).toBe("@keylight/js"); });
