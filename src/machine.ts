import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/** Deterministic tenant/product-scoped machine hash (parity across SDKs). */
export function machineHash(tenantId: string, productId: string, stableId: string): string {
  const material = `keylight-keyless-machine-v1|${tenantId}|${productId}|${stableId}`;
  return bytesToHex(sha256(utf8ToBytes(material)));
}

/** True OS/hardware machine ID on Node/Bun only; null in browser/Deno/Workers or on any
 *  failure. Never a random fallback (absence => omit machine_hash). Cached after first read. */
let cachedId: string | null | undefined;
export async function readMachineId(): Promise<string | null> {
  if (cachedId !== undefined) return cachedId;
  cachedId = await resolveMachineId();
  return cachedId;
}
async function resolveMachineId(): Promise<string | null> {
  const isNodeLike = (typeof process !== "undefined" && !!process.versions?.node) || ("Bun" in globalThis);
  if (!isNodeLike) return null;
  try {
    const plat = process.platform;
    if (plat === "linux") {
      const fs = await import("node:fs/promises");
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try { const s = (await fs.readFile(p, "utf8")).trim(); if (s) return s; } catch { /* next */ }
      }
      return null;
    }
    if (plat === "darwin") {
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
      const line = out.split("\n").find((l) => l.includes("IOPlatformUUID"));
      const parts = line?.split('"');
      return parts && parts[3] ? parts[3] : null;   // parity with Rust's split('"').nth(3)
    }
    if (plat === "win32") {
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8" });
      const tok = out.trim().split(/\s+/).pop();
      return tok && tok.length > 0 ? tok : null;
    }
    return null;
  } catch { return null; }
}
