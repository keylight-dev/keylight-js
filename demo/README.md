# Keylight Notes — Demo

Keylight Notes is a minimal example app that shows the `@keylight-dev/js` SDK in action. On the free tier, users can store up to 3 notes. Activating a `pro` license key unlocks unlimited notes and the export feature. The demo runs against the live `keylight-notes-demo` tenant on `api.keylight.dev`.

## Usage

```sh
# from the repo root

npx tsx demo/notes.ts                       # free tier (3-note limit)
npx tsx demo/notes.ts NOTES-PRO0-0000-0001  # pro (unlimited + export) — requires network
```

The free-tier run works fully offline — the keyset fetch is best-effort and `freeTierEnabled` yields `FreeTier` even when the network is unavailable. The pro run activates against the live demo tenant and requires a network connection.
