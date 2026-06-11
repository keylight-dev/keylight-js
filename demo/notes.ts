// Keylight Notes — free tier allows 3 notes; the `pro` entitlement unlocks unlimited + export.
// Run:
//   npx tsx demo/notes.ts                       # free tier (3-note limit), no network for the free path
//   npx tsx demo/notes.ts NOTES-PRO0-0000-0001  # activates pro (unlimited + export), hits api.keylight.dev
import { Keylight, fetchKeyset, FetchTransport, MemoryStore } from "../src/index.js";

const BASE = "https://api.keylight.dev";
const TENANT = "keylight-notes-demo";
const PRODUCT = "notes";

async function main() {
  // Fetch the tenant's trusted keys so an activated pro lease verifies offline.
  const ks = await fetchKeyset(new FetchTransport(), BASE, TENANT).catch(() => null);
  const kl = new Keylight({
    baseUrl: BASE,
    tenantId: TENANT,
    productId: PRODUCT,
    keyPrefix: "NOTES",
    freeTierEnabled: true,
    trustedKeys: ks?.keys ?? {},
    store: new MemoryStore(), // ephemeral on purpose: keeps each demo run stateless (omit to use the default persistent store)
  });
  await kl.load();

  const key = process.argv[2]; // optional license key
  if (key) {
    const r = await kl.activate(key);
    console.log(r.activated ? "Activated." : `Activation failed: ${r.error}`);
  }

  const pro = kl.hasEntitlement("pro");
  const limit = pro ? Infinity : 3;
  console.log(`State:          ${JSON.stringify(kl.state())}`);
  console.log(`Note limit:     ${limit === Infinity ? "unlimited" : limit}`);
  console.log(`Export enabled: ${pro}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
