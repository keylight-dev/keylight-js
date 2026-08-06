import { test, expect } from "vitest";
import { Keylight } from "../src/client.js";
import { MemoryStore } from "../src/store.js";
import type { Transport, TransportOutcome } from "../src/transport.js";

function recordingTransport(outcome: TransportOutcome) {
  const calls: { url: string; headers: [string, string][]; body: string }[] = [];
  const t: Transport = {
    async postJson(url, headers, body) { calls.push({ url, headers, body }); return outcome; },
    async get() { return { kind: "terminal", error: "n/a" }; },
  };
  return { t, calls };
}

test("apiUrl + headers + telemetry are built correctly", async () => {
  const { t, calls } = recordingTransport({ kind: "response", status: 200, body: "{}" });
  const kl = new Keylight({ tenantId: "acme", productId: "notes", sdkKey: "sk-1", appVersion: "9.9.9", transport: t, store: new MemoryStore() });
  await kl._postForTest("validate", { license_key: "K", instance_id: "i" }, [422]);

  expect(calls[0].url).toBe("https://api.keylight.dev/acme/notes/validate");
  const hk = Object.fromEntries(calls[0].headers);
  expect(hk["X-Keylight-SDK-Key"]).toBe("sk-1");
  expect(hk["X-Keylight-Request-Id"]).toBeTruthy();
  const body = JSON.parse(calls[0].body);
  expect(body.sdk_version).toBeTruthy();
  expect(body.app_version).toBe("9.9.9");
  // Phase 3 device dimensions ride the same body under Node (never device_class).
  expect(body.arch).toMatch(/^(arm64|x86_64)$/);
  expect(body.os_version).toMatch(/^\d+(\.\d+)*$/);
  expect("device_class" in body).toBe(false);
});
