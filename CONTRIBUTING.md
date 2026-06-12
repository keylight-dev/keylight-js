# Contributing

## Development

```bash
npm install
npm run typecheck
npm test          # unit suite (live integration tests are skipped unless KEYLIGHT_LIVE=1)
npm run build     # ESM + CJS + IIFE + .d.ts
```

The security-critical lease verifier is gated by Keylight's frozen **cross-SDK conformance vectors**
(`tests/conformance.test.ts`, vendored from the canonical Rust SDK). Don't loosen or skip them — a
failing vector means the verifier has diverged from the rest of the SDK family.

## Releasing (maintainers)

Versions are published via tag-triggered CI (`.github/workflows/release.yml`) using **tokenless
OIDC trusted publishing** — no npm token in the repo.

```bash
# 1. Bump the version in BOTH package.json and src/version.ts (a test guards drift).
# 2. Verify locally:
npm run typecheck
npm test
npm run build

# 3. Commit, then tag — the tag fires the release workflow:
git commit -am "Release vX.Y.Z"
git push origin main
git tag -a vX.Y.Z -m "@keylight-dev/js vX.Y.Z"
git push origin vX.Y.Z
```

The workflow upgrades npm (OIDC trusted publishing needs npm ≥ 11.5.1), then publishes
`@keylight-dev/js` to npm with provenance.
