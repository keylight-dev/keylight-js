import { test, expect } from "vitest";
import { machineHash } from "../src/machine.js";

test("machineHash matches the canonical cross-SDK test vector", () => {
  expect(machineHash("testco", "testapp", "hardware-1")).toBe(
    "8e8871112f28cabda180ada131d0b4f4f07c72fb47c5d884edbe32812885b22a",
  );
});
