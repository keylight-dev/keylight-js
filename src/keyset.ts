export interface Keyset { primaryKid: string; keys: Record<string, string>; }

export function parseKeyset(json: string): Keyset | null {
  try {
    const r = JSON.parse(json) as { primary_kid: string; keys: { kid: string; public_key: string }[] };
    if (!r || typeof r.primary_kid !== "string" || !Array.isArray(r.keys)) return null;
    const keys: Record<string, string> = {};
    for (const k of r.keys) keys[k.kid] = k.public_key;
    return { primaryKid: r.primary_kid, keys };
  } catch {
    return null;
  }
}
