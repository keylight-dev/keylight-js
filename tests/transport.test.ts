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

test("AbortError maps to timeout", async () => {
  const fakeFetch = vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
  const t = new FetchTransport(fakeFetch as unknown as typeof fetch);
  expect((await t.postJson("https://x/api", [], "{}")).kind).toBe("timeout");
});

test("TypeError maps to terminal", async () => {
  const fakeFetch = vi.fn(async () => { throw new TypeError("Invalid URL"); });
  const t = new FetchTransport(fakeFetch as unknown as typeof fetch);
  expect((await t.postJson("https://x/api", [], "{}")).kind).toBe("terminal");
});

test("get() issues a GET and maps 200", async () => {
  const fakeFetch = vi.fn(async () => new Response("ok", { status: 200 }));
  const t = new FetchTransport(fakeFetch as unknown as typeof fetch);
  const out = await t.get("https://x/keys", []);
  expect(out).toEqual({ kind: "response", status: 200, body: "ok", retryAfter: undefined });
  expect((fakeFetch.mock.calls[0] as unknown[])[1]).toMatchObject({ method: "GET" });
});

test("Retry-After: 0 is honored (not dropped)", async () => {
  const fakeFetch = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "0" } }));
  const t = new FetchTransport(fakeFetch as unknown as typeof fetch);
  const out = await t.postJson("https://x/api", [], "{}");
  expect(out).toMatchObject({ kind: "response", status: 429, retryAfter: 0 });
});

test("Retry-After HTTP-date form -> undefined", async () => {
  const fakeFetch = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "Wed, 12 Jun 2026 00:00:00 GMT" } }));
  const t = new FetchTransport(fakeFetch as unknown as typeof fetch);
  const out = await t.postJson("https://x/api", [], "{}");
  expect((out as { retryAfter?: number }).retryAfter).toBeUndefined();
});

// Regression: native browser/Worker `fetch` must NOT be invoked as a method of
// the transport instance (`this.fetchImpl(...)`) — browsers throw "fetch called
// on an object that does not implement interface Window". It must be bound to
// the global. A regular function (not an arrow) captures the real `this`.
test("invokes fetch bound to the global, not the transport instance", async () => {
  let capturedThis: unknown = "unset";
  const fakeFetch = function (this: unknown) {
    capturedThis = this;
    return Promise.resolve(new Response("ok", { status: 200 }));
  } as unknown as typeof fetch;
  const t = new FetchTransport(fakeFetch);
  await t.get("https://x/keys", []);
  expect(capturedThis).not.toBe(t);
  expect(capturedThis).toBe(globalThis);
});
