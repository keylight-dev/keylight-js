/** The signed `v3` lease (offline artifact). JSON keys match the wire format. */
export interface Lease {
  kid: string;
  licenseKeyHash: string;
  instanceId: string;
  issuedAt: number;
  expiresAt: number;
  status: string;
  signature: string;
  entitlements: string[];
}

/** Exact UTF-8 preimage that was signed (entitlements re-sorted ascending). */
export function leasePayload(lease: Lease): string {
  const ents = [...lease.entitlements].sort();
  return `v3|${lease.kid}|${lease.licenseKeyHash}|${lease.instanceId}|${lease.issuedAt}|${lease.expiresAt}|${lease.status}|${ents.join(",")}`;
}
