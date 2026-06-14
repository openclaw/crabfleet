---
title: Admin
layout: default
permalink: /admin/
description: "Access control, allowlists, policies, and administration for Crabfleet."
---

# Admin

Admin controls govern access, repos, runtime caps, and merge policies.

## Roles

### Owner

Full administrative access.

**Can:**

- Manage user/team allowlists
- Add/remove repos
- Configure runtime caps
- Set merge policies
- Set log retention
- View audit log
- All maintainer actions

**Use cases:**

- Initial bootstrap admin
- Org admins
- Infrastructure team

### Maintainer

Operational access without policy control.

**Can:**

- Create cards
- Start/stop runs
- Attach to sessions
- Take over runs
- Approve direct merge (if policy allows)
- View board and logs

**Cannot:**

- Manage allowlists
- Add/remove repos
- Change org policies

**Use cases:**

- Active contributors
- Core team members
- Trusted agents

### Viewer

Read-only access.

**Can:**

- View board
- View logs
- Attach in watch mode (read-only)

**Cannot:**

- Create cards
- Start runs
- Take over sessions
- Change anything

**Use cases:**

- Observers
- Stakeholders
- Read-only audit access

## Access Control

### User Allowlist

Add individual GitHub users.

**Format:** `@login`

**Example:**

```
@steipete
@jane
@octocat
```

**How to add:**

1. Admin panel → Users and teams
2. Enter `@login`
3. Select role (viewer, maintainer, owner)
4. Click Add

**Role inheritance:**

- User role determined by strongest match
- Direct user entry overrides team membership

### Team Allowlist

Add GitHub teams (all members inherit access).

**Format:** `@org/team`

**Example:**

```
@openclaw/maintainer
@openclaw/core
```

**How to add:**

1. Admin panel → Users and teams
2. Enter `@org/team`
3. Select role
4. Click Add

**Team membership:**

- Fetched from GitHub on each login
- Team membership changes apply immediately (next session)
- Removing team removes access for all members

### Role Hierarchy

```
owner > maintainer > viewer
```

User's effective role = strongest match across:

- Direct user allowlist entry
- All team allowlist entries

**Examples:**

| User     | Allowlist Entries                                        | Effective Role |
| -------- | -------------------------------------------------------- | -------------- |
| @alice   | `@alice` → maintainer                                    | maintainer     |
| @bob     | `@openclaw/core` → owner                                 | owner          |
| @charlie | `@charlie` → viewer, `@openclaw/maintainer` → maintainer | maintainer     |
| @dave    | (none)                                                   | (blocked)      |

## Repo Allowlist

Only allowlisted repos can be used for cards.

**Format:** `owner/repo`

**Examples:**

```
openclaw/crabbox
openclaw/codex
steipete/PSPDFKit
```

**How to add:**

1. Admin panel → Repos
2. Enter `owner/repo`
3. Click Add

**Effects:**

- Repo appears in card creation dropdown
- Cards can be created for this repo
- Runs can execute against this repo

**How to remove:**

1. Find repo in Repos list
2. Click X button
3. Existing cards preserved
4. New cards blocked until re-added

**Bulk management:**

- No bulk import (yet)
- Add repos one at a time
- Consider scripting via API for large orgs

## Org Policies

### Concurrent Cap

Max number of simultaneous Running cards.

**Default:** 20
**Range:** 1-200

**When cap reached:**

- New cards queue in Todo
- Scheduler claims as capacity frees
- FIFO order (oldest first)

**Planning:**

```
10 users × 2 cards = 20 cap
5 heavy jobs + 15 light = 20 cap
```

**How to set:**

1. Admin panel → Policy
2. Enter new cap (1-200)
3. Click Save policy

**Recommendations:**

- Start with 20
- Monitor "Queue" metric
- Increase if queue consistently >10
- Decrease if costs too high

### Log Retention

Product retention setting for run logs.

**Options:**

- 14 days
- 30 days (default)
- 60 days

**Effects:**

- Current Worker keeps D1 card/run events.
- R2 terminal/artifact lifecycle cleanup is planned for the runtime integration.

**How to set:**

1. Admin panel → Policy
2. Select retention period
3. Click Save policy

**Notes:**

- 30 days is the product default.
- 60 days is reserved for future compliance/audit retention.

### Direct Merge Permission

Configured direct merge policy. The current Worker stores this policy; real merge execution is a planned integration.

**Options:**

**Guarded (default):**

- Intended mode: maintainers can merge if all guardrails pass

**Disabled:**

- No auto-merge intended
- All PRs require manual merge
- Safest option

**Maintainers only:**

- Same as Guarded, explicitly labeled maintainer+

**How to set:**

1. Admin panel → Policy
2. Select direct merge mode
3. Click Save policy

**Recommendations:**

- Start with Disabled for new orgs
- Move to Guarded after testing workflows
- Never merge critical infra repos automatically

## Repo Workflows

Owners can refresh `CRABBOX.md` for enabled repos from Admin → Workflows. For private repos, the Worker needs deployment `GITHUB_TOKEN` access to fetch the file; it does not use the logged-in user's OAuth token for this refresh.

Supported shape:

```yaml
---
runtime:
  default: auto
merge:
  default_policy: open_pr
---
```

What is stored:

- status: `ok`, `missing`, `invalid`, or `error`
- source path and source SHA
- parsed config JSON
- prompt guidance body
- parse/error message

Only runtime and merge defaults in `ok` configs influence card defaults and runtime selection today. `stall_ms`, `cap`, `prompt_prefix`, and the Markdown body are parsed/stored for future policy work. Invalid configs are visible in Admin and ignored.

## Auth

### Trusted Reverse Proxy

Crabfleet can accept identity from an authenticating reverse proxy without a deployment-specific fork. Configure the exact backend `CRABFLEET_TRUSTED_PROXY_ORIGIN` and `CRABFLEET_TRUSTED_PROXY_SECRET`, have the proxy remove caller-supplied identity and secret headers, preserve the browser `Origin`, then inject `X-Authenticated-User` and the same secret as `X-Crabfleet-Proxy-Secret`. Use `CRABFLEET_TRUSTED_USER_HEADER` for a different identity header. When the browser-visible and backend origins differ, set `CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN` to the browser origin.

Proxy authentication does not grant a role. Add the asserted email or login to Crabfleet's existing allowlist with the intended role. Proxy assertions accept only direct email/login syntax and cannot claim a team allowlist entry. A missing or incorrect secret, missing identity, non-allowlisted identity, invalid or partial configuration, wrong backend origin, cross-origin mutation, or partial proxy assertion fails closed. The configured backend origin never falls back to a local cookie; other origins retain GitHub OAuth and break-glass token sessions. Keep the backend inaccessible to untrusted networks. Crabfleet strips the asserted identity, proxy secret, and any local cookie before routing an authenticated proxy request downstream.

The existing SSH gateway, agent, OpenClaw service, and standalone-provision API routes continue to accept their own scoped credentials without a browser proxy assertion. Any partial proxy assertion on those routes still fails closed.

SSH key linking still requires a GitHub-authenticated browser session, not a proxy-only identity. If the gateway is enabled with trusted-proxy mode, set `GITHUB_REDIRECT_URI` to a separate OAuth-capable origin outside the authoritative proxy backend origin; generated SSH onboarding links use that origin.

### GitHub OAuth

Recommended for production.

**Setup:**

1. Create GitHub OAuth app in your org
2. Callback URL: the optional Worker `GITHUB_REDIRECT_URI` value, or the request-origin `/auth/github/callback` URL when the binding is absent
3. Scopes: `read:user`, `read:org`
4. Add secrets to Cloudflare Worker:
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET`
   - `GITHUB_TOKEN` for all enabled repo previews and private repo `CRABBOX.md` refreshes (optional; public/default repo paths work without it)
5. Set `GITHUB_ORG` (`openclaw` by default). For deployments with aliases, proxies, or a fixed OAuth app callback, set `GITHUB_REDIRECT_URI` to the authoritative absolute HTTPS URL with the exact `/auth/github/callback` path and no credentials, query, or fragment.

**Session lifetime:**

- 15 minutes
- Re-login required after expiry

**Benefits:**

- Per-user attribution
- Team membership sync
- No shared tokens

### Bootstrap Token

Owner break-glass access. Normal users should sign in with GitHub OAuth or link through `ssh link@crabd.sh`; do not use the bootstrap token for day-to-day onboarding.

**Setup:**

1. Generate strong random token: `openssl rand -hex 32`
2. Set as `CRABBOX_BOOTSTRAP_TOKEN` secret in Cloudflare only when break-glass recovery is required
3. Store it in 1Password and share only with owners

**Session lifetime:**

- 1 hour (non-refreshing)
- Re-enter token to start new session

**Security:**

- Treat as root password
- Rotate regularly
- Never commit to git
- Use only for initial setup and recovery

**When to use:**

- First-time setup (no users allowlisted yet)
- GitHub OAuth broken
- Emergency access

**Recommended workflow:**

1. Bootstrap admin logs in
   - If GitHub auto-login is active, open `/app?auth=token`.
2. Adds own GitHub user to allowlist as owner
3. Logs out bootstrap
4. Logs in via GitHub OAuth
5. Normal operations use GitHub OAuth only

## Audit Log

All admin actions logged to D1.

**Logged events:**

- User/team allowlist changes
- Repo add/remove
- Policy updates
- Direct merges
- Secret usage (values redacted)
- Takeover events

**Example entries:**

```
2026-05-17 14:32:01 @steipete allowlist updated @jane role=maintainer
2026-05-17 14:35:12 @steipete repo allowlisted openclaw/crabbox
2026-05-17 14:40:00 @steipete policy updated cap=30 retention=30 merge=guarded
2026-05-17 15:10:45 @jane operator takeover granted for CY-101
2026-05-17 15:45:00 @jane merged PR openclaw/crabbox#456 commit=abc123
```

**Retention:**

- Audit log not subject to R2 retention policy
- Kept indefinitely in D1 (until DB size limits)
- Consider periodic export for compliance

**Access:**

- Owner role only
- View in Admin panel → Audit log section (future UI)
- Query D1 directly for now: `SELECT * FROM audit_events ORDER BY created_at DESC`

## Secrets Management

Secrets stored in Cloudflare Worker environment, never in D1/R2.

### Secret Types

**Bootstrap token:**

- `CRABBOX_BOOTSTRAP_TOKEN`
- Admin break-glass access
- Rotate quarterly or after any owner leaves

**GitHub OAuth:**

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_TOKEN` for all enabled repo previews and private repo `CRABBOX.md` refreshes
- Rotate if leaked

**GitHub App (future):**

- Private key for repo operations
- Scoped per repo
- Rotate on security events

**Crabbox credentials (future):**

- API token for Crabbox broker
- Scoped to org
- Rotate monthly

### Secret Access

**At runtime:**

- Worker binds secrets from environment
- Never logged
- Never returned in API responses
- Never stored in D1/R2

**Scoped delivery:**

- Containers/Crabbox receive only scoped session tokens
- No broad credentials passed to runtimes
- Session tokens expire after run

### Secret Rotation

**How to rotate:**

1. Generate new secret value
2. Update Cloudflare Worker secret via dashboard or `wrangler secret put`
3. Old sessions fail after expiry (15min-1hr)
4. All new sessions use new secret

**When to rotate:**

- Quarterly (bootstrap token)
- On security incident
- On team member departure
- On credential leak

**Best practices:**

- Store secrets in 1Password/Vault
- Never commit to git
- Never share via Slack/email
- Use `wrangler secret put` (not env vars in code)

## API

### List Allowlist

```bash
GET /api/state
```

Returns full state (owner role only):

```json
{
  "user": {...},
  "allow": [
    {"value": "@steipete", "role": "owner"},
    {"value": "@openclaw/maintainer", "role": "maintainer"}
  ],
  "repos": ["openclaw/crabbox", "openclaw/codex"],
  "cap": 20,
  "retention": "30",
  "merge": "guarded"
}
```

### Add User/Team

```bash
POST /api/admin/allow
{
  "value": "@jane",
  "role": "maintainer"
}
```

Returns updated state.

### Remove User/Team

```bash
DELETE /api/admin/allow/@jane
```

URL-encode value: `DELETE /api/admin/allow/%40jane`

### Add Repo

```bash
POST /api/admin/repos
{
  "repo": "openclaw/crabbox"
}
```

### Remove Repo

```bash
DELETE /api/admin/repos/openclaw%2Fcrabbox
```

URL-encode `owner/repo` → `owner%2Frepo`

### Update Policy

```bash
PUT /api/admin/policy
{
  "cap": 30,
  "retention": "60",
  "merge": "disabled"
}
```

All fields optional. Omitted fields unchanged.

## Monitoring

### Metrics

Dashboard shows:

- **Active:** Running cards count / cap
- **Queue:** Todo cards count
- **Review:** Human Review cards count
- **Logs:** Retention period

**Healthy state:**

- Active < cap (capacity available)
- Queue < 10 (not bottlenecked)
- Review < 20 (not backlogged)

**Warning signs:**

- Active = cap consistently → Increase cap
- Queue > 20 → Increase cap or reduce load
- Review > 50 → Process reviews or adjust merge policy

### Audit Review

Owner should periodically review:

- Recent allowlist changes (who added what)
- Direct merges (which PRs auto-merged)
- Takeover events (who took control of which runs)
- Policy changes (who changed caps/retention/merge)

**How to review:**

```sql
SELECT * FROM audit_events
WHERE created_at > strftime('%s', 'now', '-7 days') * 1000
ORDER BY created_at DESC;
```

Query D1 directly via `wrangler d1 execute`.

## Best Practices

### Allowlist Management

**Start small:**

- Add owners first
- Add core team as maintainers
- Add observers as viewers
- Expand gradually

**Use teams:**

- Prefer `@org/team` over individual users
- Easier to manage at scale
- Automatic sync with GitHub membership

**Review regularly:**

- Quarterly audit of allowlist
- Remove departed team members
- Downgrade inactive members to viewer

### Repo Management

**Allowlist only active repos:**

- Don't allowlist entire org
- Add repos as needed
- Remove deprecated/archived repos

**Avoid wildcards:**

- No `*` support (yet)
- Explicit per-repo approval required
- Prevents accidental access to sensitive repos

### Policy Tuning

**Concurrent cap:**

- Start with 20
- Monitor queue length
- Increase if bottlenecked
- Decrease if costs too high

**Log retention:**

- 30 days sufficient for most
- Increase to 60 for compliance
- Export logs to external storage for long-term retention

**Direct merge:**

- Start disabled
- Enable guarded after workflow proven
- Never auto-merge critical infrastructure

### Security

**Bootstrap token:**

- Rotate quarterly
- Store in 1Password/Vault
- Use only for break-glass access

**GitHub OAuth:**

- Use org-owned OAuth app (not personal)
- Scope to `read:user read:org repo`
- Rotate client secret on security events

**Secrets:**

- Never log or expose
- Use Cloudflare secrets (not env vars)
- Audit secret usage via audit log

**Audit log:**

- Review weekly (owner)
- Export for compliance
- Alert on suspicious patterns

## Troubleshooting

### User can't log in via GitHub

**Cause:** Not in OpenClaw org or not allowlisted

**Solution:**

1. Verify user is in GitHub org
2. Check allowlist for `@login` or `@org/team` entry
3. Add if missing

### Team allowlist not working

**Cause:** GitHub team membership not synced

**Solution:**

- Team membership fetched fresh on each login
- User must log out and back in to refresh teams
- Verify team slug matches exactly (case-sensitive)

### Repo not appearing in dropdown

**Cause:** Repo not allowlisted

**Solution:**

1. Admin → Repos
2. Add `owner/repo`
3. Refresh page

### Direct merge blocked

**Cause:** Policy disabled or guardrails failed

**Solution:**

1. Check Admin → Policy → Direct merge setting
2. Verify CI checks all green
3. Verify branch up to date
4. Check no active takeover
5. User has maintainer+ role

## Next Steps

- [Quickstart](/quickstart/) – Bootstrap your first admin session
- [Cards](/cards/) – Create and manage cards
- [Runs](/runs/) – Monitor and debug runs
- [API Reference](/api/) – Full REST and WebSocket API docs
