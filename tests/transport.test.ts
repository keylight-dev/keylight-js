import { test, expect, vi } from "vitest";
import { FetchTransport } from "../src/transport.js";

test("postJson maps a 200 to a response outcome", async () => {
  const fakeFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  const t = new FetchTransport(fakeFetch as unknown as typeof fetch);
  const out = await t.postJson("https://x/api", [["X-A", "1"]], "{}");
  expect(out).toEqual({ kind: "response", status: 200, body: '{"ok":true}', retryAfter: undefined });
});

test("network throw maps to transient", async () => {
  const fakeFetch = vi.fn(async () => { throw new Error("ECONNRESET"); });
  const t = new FetchTransport(fakeFetch as unknown as typeof fetch);
  const out = await t.postJson("https://x/api", [], "{}");
  expect(out.kind).toBe("transient");
});
