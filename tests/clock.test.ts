import { test, expect } from "vitest";
import { clockManipulated } from "../src/clock.js";

test("normal forward progress is fine", () => { expect(clockManipulated(1000, 1100)).toBe(false); });
test("backward beyond 1h flags", () => { expect(clockManipulated(10_000, 6_000)).toBe(true); });
test("forward beyond 30d flags", () => { expect(clockManipulated(0, 31 * 86400)).toBe(true); });
