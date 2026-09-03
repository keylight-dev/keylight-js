# Changelog

All notable changes to the Keylight JavaScript/TypeScript SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-04

### Added

- **A keyless heartbeat, on by default.** `reportKeylessState` used to go out
  only when the app called it, which in practice is once at startup — so an
  Electron app or a resident Node service reported itself once and then looked
  dead to the dashboard for as long as it ran: `last_seen` never moved past
  `first_seen`, and the reported app version froze at whatever shipped that day.

  `checkOnLaunch()` now starts a cadence (`keylessHeartbeatMs`, default 6h to
  match the Worker's server-side gate on keyless writes); `startKeylessHeartbeat()`
  is public for apps that never call `checkOnLaunch`. Each tick beacons only
  when the device is keyless — a licensed device sends nothing and reports
  liveness through `/validate` — and the timer keeps running across that
  boundary so a lapsed license resumes on its own.

  Nothing to change in your app. `reportKeylessState` still debounces to one
  request per 24h, so the cadence costs nothing extra on the wire. The timer is
  `unref`'d on Node/Bun so a six-hour interval can't keep a one-shot script
  alive, and `stopKeylessHeartbeat()` disposes it. Pass
  `keylessHeartbeatMs: null` to opt out.

- **Device dimensions on the telemetry fields: `arch` and `os_version`.**
  Requests that already carry telemetry (`activate`, `validate`, the keyless
  beacon) now also report the CPU architecture as a canonical token (`arm64` /
  `x86_64`; anything else is omitted) and the host OS's release version reduced
  to its dotted-numeric form (a Linux kernel release like `6.8.0-45-generic` is
  sent as `6.8.0`; on macOS it is the marketing version from `sw_vers`, e.g.
  `26.1`, matching what the Swift and Rust SDKs report — not the Darwin kernel
  version, which would place the same macOS release in a different bucket. The
  `sw_vers` call runs at most once per process, and where it cannot run the
  version is omitted rather than reported in the other vocabulary). Both fields
  are optional on the wire and only sent where a host OS exists to ask: under
  Node, Bun, Electron and Deno — on Deno the macOS version needs `--allow-run`,
  and is omitted rather than prompting for it. Browser pages and edge isolates
  send neither — there
  is no reliable source there that isn't also a fingerprinting surface, and
  this SDK keeps its stance of not reading one. `device_class` is never sent;
  the backend derives it from the OS. No app code changes.

- **Coarse device capacity on the same telemetry fields: `cpu_cores` and
  `memory`.** Requests that already carry telemetry report which *bucket* the
  machine falls in — `1-2`, `3-4`, `5-8`, `9-16`, `17+` cores, and `<4GB`,
  `4-8GB`, `8-16GB`, `16-32GB`, `32-64GB`, `64GB+` of RAM. The exact core count
  and the exact byte figure never leave the machine: a licensing SDK reporting
  precise hardware specs reads as fingerprinting, so only the bucket is sent.
  Bucket edges match the other SDKs exactly, so one machine population never
  splits across two buckets. Both fields are optional on the wire and only sent
  where a host OS exists to ask (Node, Bun, Electron, Deno). Browser pages and
  edge isolates send neither: `navigator.hardwareConcurrency` and
  `navigator.deviceMemory` are documented fingerprinting surfaces and this SDK
  declines to read them, the same stance it takes on `arch`. No app code
  changes.

## [0.1.6] - 2026-08-01

### Changed

- **`platform` now reports the operating system, not the JavaScript runtime.**
  It previously sent `node` / `deno` / `bun` / `web`, which meant every Electron
  app reported `node` no matter which OS it ran on — so a dashboard could not
  tell a Windows install base from a macOS one, and the breakdown was not
  comparable with the Swift, Rust, C++ and C# SDKs, all of which report the OS.
  It now sends the same canonical tokens they do: `macos`, `windows`, `linux`
  (and an unmapped `process.platform` value verbatim, e.g. `freebsd`).

  Where there is genuinely no host OS to report — a page in a browser, an
  isolate on the edge — the runtime token is still the honest answer and is
  kept: `web`, `workers`, `unknown`. The SDK deliberately does **not** read
  `navigator.userAgentData.platform` to guess a browser's OS; it is
  Chromium-only and a fingerprinting surface, and this SDK avoids the
  User-Agent for the same reason it avoids it in `instance_name`.

  No app code changes. If you have been reading the platform breakdown, expect
  `node` to stop growing and `macos` / `windows` / `linux` to start; historical
  rows keep their old token.

### Added

- **`sdk` field identifying this SDK on activate/validate/keyless calls.**
  Sends `js`. Keylight used to work out which SDK a device ran from the *shape*
  of its `platform` token — feasible only while each SDK had its own
  vocabulary, which the change above ends. Exported as `SDK_ID`. Requires no
  action from you; older SDK versions keep working, and the server falls back to
  the previous inference when the field is absent.

### Added

- **`activeRevalidate()` — forced, 60 s-debounced revalidation for active use.**
  Call it when the user brings the app forward (window focus, popover open,
  route change) so a dashboard revoke lands within a minute instead of waiting
  for the next launch. It bypasses `refreshIfNeeded`'s staleness gates
  (5 min / 6 h / 24 h) and shares `checkOnLaunch`'s reconciliation: a definitive
  server rejection downgrades immediately, a network blip never downgrades a
  live session, and it never throws. The debounce is held in memory only, so a
  process restart or page reload always revalidates. Mirrors the Swift SDK's
  `activeRevalidate()`.

### Fixed

- **The `activeRevalidate()` debounce no longer follows the wall clock.** It now
  measures elapsed time with `performance.now()`. Because the debounce
  *suppresses* revalidation, a system clock moved backwards previously
  suppressed revocation enforcement for the size of the jump — indefinitely, if
  the clock stayed back. Falls back to the previous behaviour only where
  `performance` is unavailable.

## [0.1.4] - 2026-07-17

### Added

- **`stableDeviceId` option for browser-like environments.** When no
  OS/hardware machine id is available (browser, Deno, Workers), a host app can
  now supply its own stable identifier — typically a user/account id — as a
  string or (async) function. It is never sent raw: it is hashed with the same
  tenant/product-scoped material as the hardware machine id, and a hardware id
  (Node/Bun) always takes precedence. A null/empty value behaves as unset.
  Note: changing the supplied value changes the device identity server-side.
- **`machine_hash` on activate and validate.** The same cross-SDK device hash
  the keyless beacon sends now accompanies `activate` and `validate`, so a
  device that converts from keyless to licensed (or keeps validating) counts
  as **one** daily-active device instead of two.
- **Durable browser storage fallbacks: `IndexedDbStore` and `CookieStore`.**
  `makeDefaultStore` now layers localStorage → fs (Node/Bun) → IndexedDB
  (probed with a real open) → cookies (probed with a write round-trip) →
  memory, so one browser profile keeps one stable `free_tier_instance_id`
  across page loads even where localStorage is unavailable (sandboxed iframes,
  some privacy modes). Both stores are also exported for explicit use.

### Changed

- **`reportKeylessState` (and `reportFreeTier`) now return a boolean** — `true`
  when the state is considered reported (HTTP 200, or a still-fresh <24h
  debounce for an unchanged state), `false` when the send failed. They still
  never throw, and the debounce state is persisted only on a successful 200,
  so a transient failure no longer suppresses re-sends for a day.

## [0.1.3] - 2026-07-09

### Added

- **Privacy-safe machine identity on keyless beacons.** The keyless/free-tier
  heartbeat now sends a one-way `machine_hash` derived from a stable hardware
  identifier — `/etc/machine-id` (Linux), `IOPlatformUUID` (macOS), or
  `MachineGuid` (Windows) — namespaced to your tenant and product, so the
  dashboard counts one device per physical machine instead of per install (a
  reinstall updates the same free-tier row instead of creating a duplicate).
  Read lazily on Node/Bun only, with no new dependency; omitted in the browser,
  Deno, and Workers, where the SDK keeps using its per-install id. Only the
  SHA-256 hash is transmitted — the raw identifier never leaves the machine.
  Byte-for-byte identical to the Swift and Rust SDKs for the same inputs. Inject
  a custom resolver via the `machineId` option for tests.

## [0.1.2] - 2026-07-08

- Enforce revocation on launch; deny on tampered or malformed leases while
  keeping access through transient failures and signing-key rotation.

## [0.1.1] - 2026-06-12

- Documentation and release-tooling fixes.

## [0.1.0] - 2026-06-12

- Initial release: online activation, offline Ed25519 lease verification,
  trials, free-tier/keyless beacon, entitlements, and the cross-SDK conformance
  vectors — full parity with the Swift and Rust SDKs.

[0.1.4]: https://github.com/keylight-dev/keylight-js/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/keylight-dev/keylight-js/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/keylight-dev/keylight-js/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/keylight-dev/keylight-js/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/keylight-dev/keylight-js/releases/tag/v0.1.0
