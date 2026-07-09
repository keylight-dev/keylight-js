# Changelog

All notable changes to the Keylight JavaScript/TypeScript SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.3]: https://github.com/keylight-dev/keylight-js/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/keylight-dev/keylight-js/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/keylight-dev/keylight-js/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/keylight-dev/keylight-js/releases/tag/v0.1.0
