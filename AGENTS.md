# Agent Notes

## Gates (all must pass before commit/land)

- `pnpm check` — assets, TypeScript, oxlint, oxfmt. `pnpm format` first if line positions shifted.
- `pnpm test` — Worker + browser (node:test).
- `pnpm macos:test` — vendored RoyalVNCKit fork first, then the app package.
- macOS tests need the full Xcode toolchain. If `xcode-select -p` shows CommandLineTools, swift-testing macros fail ("TestingMacros plugin not found"): `export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` (or the installed Xcode) before `pnpm macos:test`.
- Do not trust a worker/agent self-report that gates pass; re-run them.

## macOS app: signing + TCC (IMPORTANT)

- ALWAYS sign the app with a real Developer ID — never ad-hoc. macOS TCC keys Screen Recording/Accessibility/mic grants to the code signature; ad-hoc or changing identities wreck permissions and every rebuild re-prompts or silently loses grants.
  - Build: `CODE_SIGN_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)" pnpm macos:bundle` → `macos/CrabfleetMac/.build/Crabfleet.app`.
- ALWAYS run/test from a stable path: install to `/Applications/Crabfleet.app` and overwrite in place on redeploy. TCC grants also key on bundle path — launching from per-build `.build/` paths wrecks permissions the same way.
- `pnpm macos:run` (swift run) is for logic-only dev; anything touching ScreenCaptureKit/input needs the signed bundle at the stable path.

## Wire protocol invariants

- Big-endian integers; strict bounds validation on all inbound payloads (malformed input fails the session, never traps).
- New behavior only behind explicit negotiation (pseudo-encodings / capability messages); rolling upgrades: old peers keep working on both sides.
- Media sends are deadline-bounded and drop non-fatally; queues/buffers are bounded; teardown is fenced and idempotent.
- Only relay-published sessions may bypass listener RFB auth (`.relay` security is constructed solely in `RelayHostPublisher`).

## Layout

- `macos/CrabfleetMac` — Swift package (host + native viewer); `Vendor/RoyalVNCKit` — vendored fork, zero third-party deps (OS crypto + in-fork BigNum).
- `src/` — Cloudflare Worker + browser app (from-scratch TS RFB client in `src/app/rfb/`).
- `migrations/` — D1; additive/rolling-safe only.
- Changelog: one dense line per user-visible change under `Unreleased`.
