import { test, expect } from "vitest";
import vectors from "./fixtures/vectors.json";
import { verifyLease } from "../src/verifier.js";

test("SP-0 conformance: all vectors", () => {
  for (const v of vectors.vectors) {
    const r = verifyLease(v.lease, v.trustedKeys, v.now, vectors.skewSeconds);
    expect(r.kidKnown, `${v.name}.kidKnown`).toBe(v.expect.kidKnown);
    expect(r.signatureValid, `${v.name}.signatureValid`).toBe(v.expect.signatureValid);
    expect(r.expired, `${v.name}.expired`).toBe(v.expect.expired);
  }
});
