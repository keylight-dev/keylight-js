# Keylight SDK for JavaScript

The official JavaScript/TypeScript SDK for [Keylight](https://keylight.dev) licensing. Activate license keys, validate offline leases, manage trials, and react to license lifecycle events — from any JS runtime.

```
npm i @keylight/js
```

## Runtime support

Universal: **browser**, **Node ≥ 18**, **Deno**, **Bun**, **edge / Cloudflare Workers**. The SDK requires only `fetch` and [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) (bundled as a dependency) — no Node-specific APIs in the core path.

## Quick start

```ts
import { Keylight } from "@keylight/js";

// 1. Construct the client.
const kl = new Keylight({
  tenantId: "your-tenant",
  productId: "your-product",
  appVersion: "1.0.0",
});

// 2. Hydrate the in-memory cache from the persistent store (async, idempotent).
await kl.load();

// 3. Activate a license key (first launch or after a user enters their key).
const result = await kl.activate("XXXX-XXXX-XXXX-XXXX");
if (!result.activated) {
  console.error(result.error);
}

// 4. Check entitlements synchronously (no await — reads from the cached lease).
if (kl.hasEntitlement("pro")) {
  // unlock pro feature
}

// 5. Re-validate against the server (e.g. on app focus / periodic refresh).
await kl.validate();

// 6. React to lifecycle events.
kl.on("Cancelled", () => {
  // license was cancelled; show upgrade prompt
});
```

## API reference

### `new Keylight(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `tenantId` | `string` | required | Your Keylight tenant ID |
| `productId` | `string` | required | Your product ID |
| `appVersion` | `string` | — | Reported as telemetry on activate/validate |
| `sdkKey` | `string` | — | Optional SDK key (sent as `X-Keylight-SDK-Key`) |
| `trustedKeys` | `Record<string, string>` | `{}` | `kid → base64 ed25519 public key` for offline lease verification |
| `maxOfflineDays` | `number` | — | Gate `cachedLease` after N days without online validation |
| `trialDurationDays` | `number` | `14` | Trial length used by `checkTrial()` |
| `freeTierEnabled` | `boolean` | `false` | Include free-tier state in `state()` resolution |
| `keyPrefix` | `string` | — | Enforce a key prefix (e.g. `"KL"`) in `validateKeyFormat` |
| `transport` | `Transport` | `FetchTransport` | Injectable HTTP transport |
| `store` | `LicenseStore` | auto-detected | Injectable persistence layer |

### Core methods

| Method | Description |
|---|---|
| `load()` | Hydrate the in-memory cache from the store. Call once on startup; idempotent. |
| `activate(key)` | Activate a license key. Returns `ActivationResult`. Fails fast on invalid format. |
| `validate()` | Re-validate the stored key+instance against the server. Returns `ValidationResult`. |
| `deactivate()` | Release the activation seat on the server and clear all local state. |

### State & entitlements

| Method / getter | Description |
|---|---|
| `state()` | Synchronous `LicenseState` (a discriminated union on `.kind`) — `"Licensed"`, `"Limited"`, `"FreeTier"`, `"Trial"` (carries `daysLeft`), `"Expired"`, `"Invalid"`. |
| `hasEntitlement(feature)` | `true` if the cached lease contains `feature` in its entitlements list. |
| `cachedLease` | The trust-gated, unexpired cached lease (`Lease | null`). Enforces `maxOfflineDays`. |
| `cachedLicenseKey` | The stored raw license key string, or `null`. |
| `cachedLicenseExpiresAt` | Epoch-seconds subscription expiry, or `null`. |
| `hasStoredLicense()` | `true` when a license key is persisted locally. |

### Smart refresh

| Method | Description |
|---|---|
| `checkOnLaunch()` | Call on app start: validates online if a key is stored and the cache is stale. |
| `refreshIfNeeded()` | Validates only when stale (debounce 5 min; refresh threshold 6 h; near-expiry override). |

### Trials & free tier

| Method | Description |
|---|---|
| `startTrial()` | Record a trial start timestamp. No-op if already started. |
| `checkTrial()` | Returns `TrialStatus`: `{ kind: "not_started" | "active", daysLeft } | { kind: "expired" }`. |
| `reportKeylessState(state)` | Ping the server with keyless/free-tier state (debounced to once/day per state). |
| `freeTierInstanceId()` | Returns the stable persisted free-tier instance UUID (creates one on first call). |

### Events & subscriptions

| Method | Description |
|---|---|
| `on(event, fn)` | Subscribe to a `LicenseLifecycleEvent` — one of `"Renewed"`, `"Cancelled"`, `"Expired"`, `"Restored"`. Returns an unsubscribe function. |
| `subscribe(fn)` | Subscribe to every state change. Callback receives the new `LicenseState`. Returns unsubscribe. |

### Utilities

| Export | Description |
|---|---|
| `upgradeUrl` | Getter returning the hosted upgrade portal URL (requires a stored license key). |
| `isClockManipulated()` | Heuristic — `true` if the system clock moved backward since `last_seen`. |

### Swift-parity convenience aliases

Thin wrappers matching the Swift SDK's method names, for teams porting between platforms:

| Alias | Equivalent to |
|---|---|
| `isEntitled` (getter) | `true` when `state()` is `Licensed` or an active `Trial`. |
| `productFreeTierEnabled()` | The configured `freeTierEnabled` flag. |
| `isValidKeyFormat(key)` | `validateKeyFormat(key, keyPrefix)` as an instance method. |
| `refresh(force?)` | `force` (default) → `validate()`; otherwise `refreshIfNeeded()`. |
| `freeTierInstanceIdIfPresent()` | The persisted free-tier id, or `null` — without creating one. |
| `reportFreeTier()` | `reportKeylessState("free_tier")`. |

## Standalone offline verification

Verify a lease without a `Keylight` client instance — useful in server-side middleware or CI tooling:

```ts
import { verifyLease, isTrusted, SKEW_SECONDS } from "@keylight/js";

const result = verifyLease(lease, { [kid]: base64PubKey }, Math.floor(Date.now() / 1000));
if (!isTrusted(result)) throw new Error("Untrusted lease");
if (result.expired) throw new Error("Lease expired");
```

`SKEW_SECONDS` (300) is the built-in clock-skew tolerance applied to `expiresAt`.

## Pluggable transport and storage

### Transport

Implement `Transport` to swap out the HTTP layer (mock in tests, add headers, proxy through a service worker, etc.):

```ts
import type { Transport, TransportOutcome, Header } from "@keylight/js";

class MyTransport implements Transport {
  async postJson(url: string, headers: Header[], body: string): Promise<TransportOutcome> { ... }
}

const kl = new Keylight({ ..., transport: new MyTransport() });
```

### LicenseStore

Implement `LicenseStore` (three async methods: `get`, `set`, `remove`) to back the SDK with any persistence layer:

```ts
import { MemoryStore, LocalStorageStore, FsStore, makeDefaultStore } from "@keylight/js";
```

| Store | Runtime | Notes |
|---|---|---|
| `MemoryStore` | All | In-process only; state lost on reload |
| `LocalStorageStore` | Browser | Namespaced under `keylight_` prefix by default |
| `FsStore` | Node / Bun | One JSON file at `~/.keylight.json` by default |
| `makeDefaultStore()` | All | Auto-selects: `LocalStorageStore` → `FsStore` → `MemoryStore` |

## Security and storage notes

The at-rest license cache is **plaintext** (JSON in localStorage or a home-directory file). The security boundary is the **Ed25519-signed lease**: the SDK verifies the server signature on every lease it stores and on every `cachedLease` access. A tampered or forged lease cannot pass `isTrusted()` without the private key.

Device identity is a stable UUID persisted in the same store under a `free_tier_instance_id` key. It is used only for seat management and free-tier reporting — it is not tied to any personally identifying information.

See [docs.keylight.dev](https://docs.keylight.dev) for the lease format, key rotation, and security model.

## Keylight SDK family

| Platform | Package |
|---|---|
| JavaScript / TypeScript | `@keylight/js` (this package) |
| Rust | [`keylight`](https://crates.io/crates/keylight) crate |
| Swift | `KeylightSDK` (Swift Package Manager) |

All three SDKs implement the same SP-0 conformance surface and share the same lease format and Ed25519 verification semantics.

## License

MIT. See [LICENSE](./LICENSE).
