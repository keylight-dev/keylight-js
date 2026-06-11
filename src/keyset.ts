import type { Transport } from "./transport.js";

export interface Keyset { primaryKid: string; keys: Record<string, string>; }

export function parseKeyset(json: string): Keyset | null {
  try {
    const r = JSON.parse(json) as { primary_kid: string; keys: { kid: string; public_key: string }[] };
    if (!r || typeof r.primary_kid !== "string" || !Array.isArray(r.keys)) return null;
    const keys: Record<string, string> = {};
    for (const k of r.keys) {
      // Reject malformed entries rather than poisoning the map with `undefined`
      // (parity with Rust serde, which fails to deserialize a key missing public_key).
      if (!k || typeof k.kid !== "string" || typeof k.public_key !== "string") return null;
      keys[k.kid] = k.public_key;
    }
    return { primaryKid: r.primary_kid, keys };
  } catch {
    return null;
  }
}

/** Fetch `{base}/{tenant}/.well-known/keylight-keys`. */
export async function fetchKeyset(transport: Transport, baseUrl: string, tenantId: string): Promise<Keyset | null> {
  const url = `${baseUrl}/${tenantId}/.well-known/keylight-keys`;
  const out = await transport.get(url, []);
  if (out.kind === "response" && out.status === 200) return parseKeyset(out.body);
  return null;
}
