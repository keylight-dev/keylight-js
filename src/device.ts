import type { LicenseStore } from "./store.js";

/** RFC4122 v4 UUID. Uses Web Crypto when available, else getRandomValues/Math.random. */
export function randomUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const b = new Uint8Array(16);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gcr = typeof crypto !== "undefined" && (crypto as any).getRandomValues as ((a: Uint8Array) => void) | undefined;
  if (gcr) gcr(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

/** Get the persisted instance id under `key`, generating + storing one on first use. */
export async function ensureInstanceId(store: LicenseStore, key: string, override?: string): Promise<string> {
  if (override) { await store.set(key, override); return override; }
  const existing = await store.get(key);
  if (existing) return existing;
  const id = randomUuid();
  await store.set(key, id);
  return id;
}
