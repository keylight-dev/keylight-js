import { test, expect } from "vitest";
import { parseKeyset } from "../src/keyset.js";

test("parses the well-known keyset shape", () => {
  const json = `{"primary_kid":"k1","keys":[{"kid":"k1","alg":"ed25519","public_key":"AAAA"}]}`;
  const r = parseKeyset(json);
  expect(r).not.toBeNull();
  expect(r!.primaryKid).toBe("k1");
  expect(r!.keys["k1"]).toBe("AAAA");
});

test("invalid json -> null", () => {
  expect(parseKeyset("nope")).toBeNull();
});
