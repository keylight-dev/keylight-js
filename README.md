# Keylight JavaScript SDK

[![npm](https://img.shields.io/npm/v/@keylight-dev/js.svg)](https://www.npmjs.com/package/@keylight-dev/js)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Types](https://img.shields.io/npm/types/@keylight-dev/js.svg)](https://www.npmjs.com/package/@keylight-dev/js)
[![Runtimes](https://img.shields.io/badge/runtimes-browser%20%C2%B7%20node%20%C2%B7%20deno%20%C2%B7%20bun%20%C2%B7%20workers-success.svg)](#runtime-support)
[![Conformance](https://img.shields.io/badge/conformance-cross--SDK%20vectors-success.svg)](#conformance)

Open-source JavaScript/TypeScript SDK for [Keylight](https://keylight.dev) — license your web,
Node, Electron, and edge apps with online activation and offline Ed25519 license verification, from
any JavaScript runtime.

> **In one line:** a software-licensing SDK for JavaScript/TypeScript — license-key activation and
> validation, entitlement/feature gating, trials and free tiers, and tamper-resistant **offline
> license verification** (signed `v3` lease, Ed25519 + clock-skew tolerance) for the browser, Node,
> Deno, Bun, and edge/Workers. Universal, dependency-light, and fully typed.

## Why Keylight

Licensing shouldn't mean bolting a heavyweight, phone-home-or-die SDK onto your app.

- **Works offline.** The license is a signed lease your app verifies locally with Ed25519 — no
  network round-trip to gate a feature, no lockout when the user is offline.
- **Tamper-resistant by design.** Entitlements live *inside* the signature; a forged or hand-edited
  lease can't pass verification without the tenant's private key.
- **One SDK, every runtime.** The same package runs in the browser, Node, Deno, Bun, and edge — and
  verifies licenses identically to the Swift and Rust SDKs (proven by shared conformance vectors).
- **Small and explicit.** A handful of methods, no background daemons, no magic — you decide when to
  check in.

## Table of Contents

- [Why Keylight](#why-keylight)
- [Features](#features)
- [Runtime support](#runtime-support)
- [Quick Start](#quick-start)
- [License Lifecycle](#license-lifecycle)
- [License States](#license-states)
- [Entitlements](#entitlements)
- [Offline Validation](#offline-validation)
- [Refresh, Trials & Free Tier](#refresh-trials--free-tier)
- [Lifecycle Events](#lifecycle-events)
- [Configuration Reference](#configuration-reference)
- [Pluggable Transport & Storage](#pluggable-transport--storage)
- [Demo](#demo)
- [Conformance](#conformance)
- [Documentation](#documentation)
- [Other SDKs](#other-sdks)
- [License](#license)

## Features

- **License Lifecycle** — Activate, validate, and deactivate license keys with a small, explicit API.
- **Offline Verification** — The single offline artifact is a signed `v3` **lease**, verified with
  **Ed25519** (`@noble/ed25519`) and a 300-second clock-skew tolerance. An optional `maxOfflineDays`
  grace caps how long a device may run without checking in.
- **Universal** — One package for **browser**, **Node ≥ 18**, **Deno**, **Bun**, and
  **edge / Cloudflare Workers**. Uses only `fetch` + `@noble/*` — no Node-specific APIs in the core.
- **Synchronous reads** — Network calls are `async`, but `state()`, `hasEntitlement()`, and the
  cached getters are **synchronous** (backed by an in-memory cache hydrated by `load()`).
- **Entitlements** — Feature gating from the cached lease: `hasEntitlement("pro")`.
- **Trials & Free Tier** — Built-in local trial timer, free-tier mode, and an anonymous "keyless"
  usage beacon.
- **Lifecycle Events** — `on(event, fn)` for `Renewed` / `Cancelled` / `Expired` / `Restored`, plus
  `subscribe(fn)` for any state change.
- **Clock-Manipulation Detection** — Flags backward/forward system-clock tampering.
- **Device Telemetry** — Auto-attaches `sdk_version`, `platform`, and (optional) `app_version`
  (clamped to the backend's limits).
- **Network Resilience** — Automatic retry with exponential backoff + jitter; honors `Retry-After`.
- **Pluggable** — Swap the storage backend (`LicenseStore`) or HTTP transport (`Transport`) via
  interfaces for tests or custom platforms.
- **Fully typed** — Ships ESM, CJS, an IIFE browser bundle, and complete `.d.ts`.

## Runtime support

Universal: **browser**, **Node ≥ 18**, **Deno**, **Bun**, **edge / Cloudflare Workers**. The SDK
requires only `fetch` and [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) +
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes) (bundled dependencies). Ed25519 verify
is synchronous, so license state can be read without `await`.

## Quick Start

```bash
npm install @keylight-dev/js
```

```ts
import { Keylight, fetchKeyset, FetchTransport } from "@keylight-dev/js";

// Optionally fetch the tenant's trusted Ed25519 keyset so leases verify offline.
// (You can also pin keys explicitly via `trustedKeys`.)
const ks = await fetchKeyset(new FetchTransport(), "https://api.keylight.dev", "your-tenant");

const kl = new Keylight({
  tenantId: "your-tenant",
  productId: "your-product",
  appVersion: "1.0.0",
  maxOfflineDays: 7,            // optional offline grace window
  trustedKeys: ks?.keys ?? {},  // for offline lease verification
});

// Hydrate the in-memory cache from the persistent store (async, idempotent).
await kl.load();

// Activate a license key (online). The returned lease is Ed25519-verified
// *before* anything is persisted.
const res = await kl.activate("USER-LICENSE-KEY");
if (!res.activated) console.error(res.error);

// Gate features on entitlements — synchronous, from the cached lease.
if (kl.hasEntitlement("pro")) {
  // unlock pro features
}

// Release the seat when uninstalling / switching devices.
await kl.deactivate();
```

> Call `await kl.load()` once at startup — it hydrates the cache that backs the synchronous reads
> (`state()`, `hasEntitlement()`, `cached*`). The licensing methods also await it internally.

For a browser `<script>` tag, the IIFE bundle exposes the namespace as `window.KeylightSDK`
(`new KeylightSDK.Keylight({ … })`).

## License Lifecycle

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  activate   │────▶│  validate   │────▶│  deactivate  │
└─────────────┘     └─────────────┘     └──────────────┘
                          ▲
                          │ on launch / on events (no background timers)
                  ┌────────────────────┐
                  │  refreshIfNeeded   │
                  └────────────────────┘
```

| Method | Description |
|--------|-------------|
| `activate(key) → ActivationResult` | Activates a key on this device. Verifies the returned lease before persisting; returns `instanceId`, the lease, and expiry. |
| `validate() → ValidationResult` | Re-checks the stored license online. Decodes hard-expiry (`422`) responses and preserves fallback/expired leases so state can resolve. |
| `deactivate()` | Releases the seat and clears local license state (even if the network call fails). Call on uninstall or device switch. |
| `refreshIfNeeded() → ValidationResult \| null` | Validates only if due (debounce 5 min, stale 6 h, or within 24 h of expiry). Safe to call often. |
| `checkOnLaunch()` | Always validates when a license is stored, else no-op. Never throws: a definitive rejection downgrades, a network blip keeps last-known-good. |
| `activeRevalidate()` | Same forced check for active use (focus / popover open), debounced 60 s in memory. Call it so a revoke lands in a long-running app without a relaunch. |

## License States

`state()` resolves a single high-level status from the cached lease, trial, and free-tier config
(no network). It is a discriminated union on `.kind`:

| State | Meaning |
|-------|---------|
| `Licensed` | Current, signature-valid `active` lease. |
| `Limited` | Signature-valid `fallback` lease (grace mode). |
| `Trial` (carries `daysLeft`) | No license, but a local trial is active. |
| `FreeTier` | No license, free tier enabled. |
| `Expired` | Lease expired, or a license was stored but is no longer current. |
| `Invalid` | No license, no trial, no free tier. |

```ts
const s = kl.state();
if (s.kind === "Trial") console.log(`${s.daysLeft} days left`);
```

## Entitlements

Entitlements are feature keys carried inside the signed lease and checked offline:

```ts
if (kl.hasEntitlement("cloud-sync")) {
  enableCloudSync();
}
```

`hasEntitlement` returns `true` only when the cached lease is signature-valid, unexpired, not
`expired`-status, and within `maxOfflineDays` — so offline feature gating never disagrees with the
resolved `Expired` state.

## Offline Validation

The offline artifact is a signed **`v3` lease** issued by the Keylight API. The SDK reconstructs
the exact signed payload (entitlements sorted, pipe-delimited) and verifies it with **Ed25519**
against the tenant's trusted keyset, applying a **300-second clock-skew** tolerance.

```ts
import { Keylight } from "@keylight-dev/js";

const kl = new Keylight({
  tenantId: "your-tenant",
  productId: "your-product",
  // Pin trusted keys explicitly instead of fetching them:
  trustedKeys: { k1: "<raw ed25519 public key, base64>" },
  maxOfflineDays: 7, // omit to run offline as long as the lease itself is current
});
```

- The trusted keyset can be fetched once from `GET /{tenant}/.well-known/keylight-keys`
  (`fetchKeyset`) or pinned at construction time.
- `cachedLease` returns the lease only when it is `kid`-known, signature-valid, unexpired, and
  (if set) within `maxOfflineDays` of the last online validation.
- You can verify a lease standalone (e.g. in server middleware) without a client instance:

```ts
import { verifyLease, isTrusted, SKEW_SECONDS } from "@keylight-dev/js";

const r = verifyLease(lease, { [kid]: base64PubKey }, Math.floor(Date.now() / 1000));
if (!isTrusted(r)) throw new Error("Untrusted lease");
if (r.expired) throw new Error("Lease expired");
```

> **Storage & security note:** the at-rest license cache is **plaintext** (localStorage in the
> browser, a JSON file in Node). The security boundary is the **Ed25519-signed lease**, not at-rest
> secrecy — a tampered or forged lease cannot pass `isTrusted()` without the tenant's private key.
> In a browser, any key the SDK could use to "encrypt" the cache would have to live next to it, so
> encryption there would be theater; integrity (the signature) is what protects you.

## Refresh, Trials & Free Tier

There are **no background timers**. The host drives refresh on launch and on meaningful events:

```ts
await kl.checkOnLaunch();     // always validate, on startup
await kl.activeRevalidate();  // on focus / popover open — forced, debounced 60 s
await kl.refreshIfNeeded();   // cheap catch-all after purchase / resume
```

Trials and free tier are local and offline-first:

```ts
await kl.startTrial();        // begins the trial clock once
const t = kl.checkTrial();    // { kind: "not_started" | "active", daysLeft } | { kind: "expired" }
if (t.kind === "active") console.log(`${t.daysLeft} days left`);

// Anonymous, debounced usage beacon for trial / free-tier / expired devices:
await kl.reportKeylessState("trial");

// Tamper check and a pre-filled hosted upgrade link:
const tampered = kl.isClockManipulated();
if (kl.upgradeUrl) console.log(`Upgrade: ${kl.upgradeUrl}`);
```

## Lifecycle Events

Subscribe to react when the resolved state crosses a transition. `on(event, fn)` targets a specific
event; `subscribe(fn)` fires on every state change with the new `LicenseState`. Both return an
unsubscribe function.

```ts
const off = kl.on("Cancelled", () => showUpgradePrompt());
kl.subscribe((state) => render(state));
// ...later
off();
```

| Event | Fires when |
|-------|-----------|
| `Renewed` | Stayed `Licensed` and the expiry moved later. |
| `Cancelled` | `Licensed` → `Limited` or `Expired`. |
| `Expired` | Any state → `Expired`. |
| `Restored` | `Expired`/`Limited`/`Invalid` → `Licensed`. |

Events are evaluated during `validate()` and re-derive the previous state from the persisted lease,
so a transition won't re-fire across restarts.

## Configuration Reference

Pass `KeylightOptions` to `new Keylight({ … })`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tenantId` | `string` | — | Your Keylight tenant (required). |
| `productId` | `string` | — | Your product (required). |
| `sdkKey` | `string` | — | Optional SDK key, sent as `X-Keylight-SDK-Key`. |
| `trustedKeys` | `Record<string,string>` | `{}` | Trusted Ed25519 public keys (`kid → base64`) for offline verification. |
| `maxOfflineDays` | `number` | — | Offline grace window since last online validation. Omit = until the lease itself expires. |
| `trialDurationDays` | `number` | `14` | Local trial length. |
| `freeTierEnabled` | `boolean` | `false` | Resolve to `FreeTier` when there's no license/trial. |
| `appVersion` | `string` | — | Reported in telemetry. |
| `baseUrl` | `string` | `https://api.keylight.dev` | API base URL. |
| `keyPrefix` | `string` | — | Client-side key-format check (e.g. `"PROD"`). |
| `deviceId` | `string` | generated | Override the persisted free-tier/keyless instance id. |
| `transport` | `Transport` | `FetchTransport` | Injectable HTTP transport. |
| `store` | `LicenseStore` | auto-detected | Injectable persistence layer. |

> A small set of **Swift-parity aliases** is also available for teams porting between platforms:
> `isEntitled`, `productFreeTierEnabled()`, `isValidKeyFormat(key)`, `refresh(force?)`,
> `freeTierInstanceIdIfPresent()`, `reportFreeTier()`.

## Pluggable Transport & Storage

Implement `Transport` to swap the HTTP layer (mock in tests, add headers, proxy through a service
worker). Implement `LicenseStore` (`get`/`set`/`remove`, all async) to back the SDK with any
persistence layer:

```ts
import { MemoryStore, LocalStorageStore, FsStore, makeDefaultStore } from "@keylight-dev/js";
```

| Store | Runtime | Notes |
|-------|---------|-------|
| `MemoryStore` | All | In-process only; state lost on reload. |
| `LocalStorageStore` | Browser | Namespaced under a `keylight_` prefix by default. |
| `FsStore` | Node / Bun | One JSON file at `~/.keylight.json` by default. |
| `makeDefaultStore()` | All | Auto-selects: `LocalStorageStore` → `FsStore` → `MemoryStore`. |

## Demo

The [`demo/`](./demo) "Keylight Notes" app shows entitlement gating end-to-end (free = 3 notes; the
`pro` entitlement unlocks unlimited notes + export) against the live public demo tenant:

```bash
npx tsx demo/notes.ts                       # free tier (3-note limit) — works offline
npx tsx demo/notes.ts NOTES-PRO0-0000-0001  # pro (unlimited + export) — activates online
```

## Conformance

The security-critical lease verifier is gated by Keylight's frozen **cross-SDK conformance vectors**
(`tests/conformance.test.ts`). The JavaScript verifier must agree with every vector on
`{ kidKnown, signatureValid, expired }`, which keeps offline verification behavior identical across
the Keylight SDK family (Swift, Rust, JavaScript, …).

```bash
npm test                                  # full suite (live tests skipped)
npx vitest run tests/conformance.test.ts  # just the conformance vectors
KEYLIGHT_LIVE=1 npm run test:live         # opt-in live tests vs the demo tenant
```

## Documentation

- **Platform docs:** [docs.keylight.dev](https://docs.keylight.dev)
- **Website:** [keylight.dev](https://keylight.dev)
- **API host:** `https://api.keylight.dev`

## Other SDKs

| Platform | Status | Repository |
|----------|--------|------------|
| Swift (macOS/iOS) | Available | [keylight-swift](https://github.com/keylight-dev/keylight-swift) |
| Rust (CLIs/daemons/Tauri) | Available | [keylight-rust](https://github.com/keylight-dev/keylight-rust) |
| JavaScript (this repo) | Available | [keylight-js](https://github.com/keylight-dev/keylight-js) |
| C# · C++ | Planned | unified by the same cross-SDK conformance vectors |

## About Keylight

Keylight is the licensing layer for desktop apps. You keep your own Stripe account,
your own pricing, and your own customers — Keylight issues the licenses and tells your
app who is allowed to run it.

- **License keys** issued automatically when a payment completes
- **Device activations** with limits you set, and self-serve deactivation
- **Offline validation** — signed Ed25519 leases your app verifies locally
- **Feature entitlements** signed into the lease, so tiers work offline too

[keylight.dev](https://keylight.dev) · [Documentation](https://docs.keylight.dev) · [Pricing](https://keylight.dev/pricing)

### Further reading

- [How to Add License Keys to an Electron App](https://keylight.dev/blog/add-license-keys-electron-app)
- [How to Add License Keys to a Tauri App](https://keylight.dev/blog/add-license-keys-tauri-app)
- [Tauri vs Electron for Licensed Desktop Apps](https://keylight.dev/blog/tauri-vs-electron-licensed-desktop-apps)

## License

MIT License. See [LICENSE](LICENSE) for details.

---

<sub>Keylight JavaScript SDK — software licensing for JS/TS: license-key activation & validation,
offline Ed25519 lease verification, entitlement/feature gating, trials and free tiers, lifecycle
events, and pluggable storage/transport — for the browser, Node, Deno, Bun, and edge runtimes.</sub>
