# Crabfleet Spec v2

Status: implementation plan plus shipped v2 slice.

Canonical app/API URL: <https://crabfleet.openclaw.ai>

Product page URL: <https://crabfleet.ai>

## Goal

Crabfleet v2 is the OpenClaw fleet control plane for Codex crabboxes.

It must answer one operational question quickly: what Codex instances exist across the fleet, who owns them, what runtime backs them, whether they are attachable, what logs/checkpoints exist, and whether their sandbox egress policy is registered.

Cloudsail showed useful primitives: CLI-first lifecycle, Worker-owned credential injection, project/session registry, short-lived attach URLs, explicit egress allowlists, and cost/lifecycle visibility. Crabfleet keeps those ideas but applies them to OpenClaw’s multi-operator Codex fleet instead of a single project sandbox.

## Scope

This v2 slice ships:

- Public docs route for this plan at `/docs/spec-v2` and `/docs/spec-v2.md`.
- Authenticated fleet state in `/api/state`.
- Dedicated authenticated fleet endpoint at `/api/fleet`.
- Redacted SessionControl Durable Object policy inventory.
- Fleet dashboard control-plane summary.
- Per-crabbox policy/log/archive hints in the Fleet page.
- Unit tests for fleet aggregation and sandbox lease parsing.
- Changelog entry for the user-visible surface.

Out of scope for this slice:

- New runtime provider.
- New pricing model.
- New GitHub App permission set.
- Direct ClawSweeper merge orchestration.
- Cross-host remote process discovery outside the sessions already registered in Crabfleet.

## Control Plane Model

Crabfleet has three live truth sources:

- D1 `interactive_sessions`: session identity, repo, branch, owner, runtime, status, lease, attach URLs, last event, sharing, and timestamps.
- D1/R2 session logs: recent log lines in D1 and durable archives in R2.
- `SessionControlDO`: sandbox credential and checkpoint metadata for Cloudflare Sandbox-backed sessions.

The v2 fleet state joins those sources into one redacted registry.

Fleet state shape:

```json
{
  "canonicalUrl": "https://crabfleet.openclaw.ai",
  "productUrl": "https://crabfleet.ai",
  "generatedAt": 1770000000000,
  "registryAvailable": true,
  "egress": {
    "defaultHostCount": 13,
    "policyCount": 2,
    "sessionsWithPolicy": 2
  },
  "totals": {
    "sessions": 4,
    "active": 2,
    "ready": 2,
    "provisioning": 0,
    "failed": 1,
    "stopped": 1,
    "attachable": 2,
    "archived": 3,
    "vnc": 1,
    "byRuntime": { "crabbox": 1, "container": 3 },
    "byStatus": {
      "provisioning": 0,
      "pending_adapter": 0,
      "ready": 2,
      "attached": 0,
      "detached": 0,
      "stopped": 1,
      "expired": 0,
      "failed": 1
    }
  },
  "sessions": []
}
```

Per-session summary:

- `id`
- `repo`
- `branch`
- `runtime`
- `owner`
- `status`
- `active`
- `attachable`
- `vnc`
- `archived`
- `logEvents`
- `leaseId`
- `sandboxId`
- `lastEvent`
- `createdAt`
- `updatedAt`
- `lastSeenAt`
- `stoppedAt`
- `policy.present`
- `policy.allowedHostCount`
- `policy.githubCredentialSource`
- `policy.githubRepo`
- `policy.hasGithubToken`
- `policy.openAIBaseUrlHost`

## Security

The fleet endpoint must never return raw secrets.

Allowed fields from `SessionControlDO`:

- sandbox ID
- session ID
- owner
- GitHub repo
- allowed host names
- allowed host count
- OpenAI base URL host only
- credential source enum: `none`, `session`, or `worker`
- booleans for GitHub token presence, repo node ID presence, and OpenAI org presence

Forbidden fields:

- encrypted GitHub token ciphertext
- decrypted GitHub token
- OpenAI API key
- OpenAI org ID value
- internal auth tokens
- arbitrary Durable Object storage keys

## UI

Fleet is the default application page.

The v2 page must show:

- Running crabboxes.
- Visible people.
- Total crabboxes.
- Ready sessions.
- Provisioning sessions.
- Archived sessions.
- Sessions with registered sandbox policies.
- Registry availability.
- Default egress host count.
- Allowed repo count.
- Link to this spec.
- Per-crabbox status, runtime, log count, VNC hint, and egress policy count.

## API

`GET /api/state`

- Requires signed-in user.
- Includes `fleet`.
- Keeps existing cards, interactive sessions, workflows, and settings unchanged.

`GET /api/fleet`

- Requires viewer role.
- Returns `{ "fleet": FleetState }`.
- Uses same aggregation as `/api/state`.

`GET /api/session-control/policies`

- Internal Durable Object endpoint.
- Called only from Worker code.
- Returns redacted policy summaries.
- Deduplicates lookup aliases for the same session.

## Lifecycle

Session states:

- `provisioning`: requested, not ready.
- `pending_adapter`: backend route live but runtime adapter unavailable.
- `ready`: attachable.
- `attached`: attachable and observed attached.
- `detached`: attachable but not currently attached.
- `stopped`: intentionally stopped.
- `expired`: lease expired.
- `failed`: provision/run failed.

Active sessions are every state except `stopped`, `expired`, and `failed`.

Attachable sessions require an attach URL and an active state.

Archived sessions have R2 log archive metadata or archived event counts.

## Implementation Plan

- [x] Inspect existing fleet/session/runtime/docs architecture.
- [x] Add pure fleet-state aggregation helper.
- [x] Add redacted sandbox policy summaries.
- [x] Add authenticated `/api/fleet`.
- [x] Include fleet state in `/api/state`.
- [x] Serve `/docs/spec-v2` and `/docs/spec-v2.md`.
- [x] Add Fleet dashboard control-plane summary.
- [x] Show per-crabbox egress policy hints.
- [x] Add unit tests for aggregation and sandbox lease parsing.
- [x] Add changelog entry.
- [x] Run local checks.
- [x] Run autoreview and fix accepted findings.
- [x] Open PR.
- [x] Merge PR.
- [x] Verify production deployment.
- [x] Live test canonical URL and v2 docs/API routes.

## Test Plan

Local:

- `pnpm test`
- `pnpm check`
- `go test ./...`
- `pnpm exec wrangler deploy --dry-run`

Local result:

- `pnpm test`: passed.
- `pnpm check`: passed.
- `go test ./...`: passed.
- `pnpm exec wrangler deploy --dry-run`: passed.
- PR: <https://github.com/openclaw/crabfleet/pull/15>.
- Landed: `72f205b`.
- Deploy workflow: `deploy-worker` run `26694996052` passed.
- Pages workflow: run `26694996080` passed.
- Live smoke: `https://crabfleet.openclaw.ai/healthz` returned `200`.
- Live smoke: `https://crabfleet.openclaw.ai/docs/spec-v2` returned this spec.
- Live smoke: unauthenticated `https://crabfleet.openclaw.ai/api/fleet` returned `401`.
- Product split: `https://crabfleet.ai/` stayed independent as the product-page host.

Autoreview:

- Run the local autoreview skill.
- Fix accepted actionable findings.
- Repeat until clean.

PR:

- Push branch.
- Open PR.
- Wait for required GitHub checks.
- Merge once green.

Deploy:

- Confirm Worker deploy workflow for merged commit.
- Confirm `https://crabfleet.openclaw.ai/healthz` returns `200`.
- Confirm `https://crabfleet.openclaw.ai/docs/spec-v2` returns HTML.
- Confirm `https://crabfleet.openclaw.ai/docs/spec-v2.md` returns Markdown.
- Confirm unauthenticated `https://crabfleet.openclaw.ai/api/fleet` is rejected.
- Confirm `https://crabfleet.ai` stays product-page host, not the app/API host.

## Future Work

- Add ClawSweeper handoff state into fleet cards.
- Add provider-level remote worker discovery for Hetzner-hosted crabboxes.
- Add sandbox sleep/idle policy display after provider billing semantics are finalized.
- Add checkpoint counts to the fleet registry.
- Add operator takeover audit summaries to fleet cards.
- Add Prometheus-style fleet export for ClawSweeper.
