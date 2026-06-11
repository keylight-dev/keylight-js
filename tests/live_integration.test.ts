// Run with: npm run test:live   (requires KEYLIGHT_LIVE=1 and network access)
// Mirrors the Rust live test at keylight-rust/keylight/tests/live_integration.rs
import { test, expect, describe, beforeAll } from "vitest";
import { Keylight, fetchKeyset, FetchTransport, MemoryStore } from "../src/index.js";

const LIVE = process.env.KEYLIGHT_LIVE === "1";
const d = LIVE ? describe : describe.skip;

const BASE = "https://api.keylight.dev";
const TENANT = "keylight-notes-demo";
const PRODUCT = "notes";
// The Rust live test uses no SDK key — keyset fetch and activate/deactivate are
// public endpoints on the demo tenant. Mirrors Rust exactly.

d("live: keylight-notes-demo", () => {
  let trustedKeys: Record<string, string> = {};

  beforeAll(async () => {
    const ks = await fetchKeyset(new FetchTransport(), BASE, TENANT);
    expect(ks, "keyset must be fetchable from demo tenant").not.toBeNull();
    if (ks) trustedKeys = ks.keys;
  });

  function client() {
    // Explicit MemoryStore per-test: avoids makeDefaultStore() picking the Node
    // test environment's stub localStorage (which lacks working getItem/setItem).
    // Each test gets a clean, isolated in-memory store — mirrors Rust's temp-dir-per-test.
    return new Keylight({
      baseUrl: BASE,
      tenantId: TENANT,
      productId: PRODUCT,
      keyPrefix: "NOTES",
      trustedKeys,
      store: new MemoryStore(),
    });
  }

  test("activate the active pro key returns a verifiable lease + pro entitlement", async () => {
    const kl = client();
    await kl.load();
    const r = await kl.activate("NOTES-PRO0-0000-0001");
    expect(r.activated, `error: ${r.error}`).toBe(true);
    expect(r.lease).not.toBeNull();
    expect(kl.hasEntitlement("pro")).toBe(true);
    await kl.deactivate(); // clean up the seat
  });

  test("revoked key does not activate", async () => {
    const kl = client();
    await kl.load();
    const r = await kl.activate("NOTES-REVK-0000-0002");
    expect(r.activated).toBe(false);
  });

  test("expired key yields no pro entitlement", async () => {
    const kl = client();
    await kl.load();
    await kl.activate("NOTES-EXPD-0000-0003");
    expect(kl.hasEntitlement("pro")).toBe(false);
  });
});
