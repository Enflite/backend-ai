# SyteLine UI Automation — Operator Guide

The assistant can drive the SyteLine web client in a real browser
session and complete multi-step tasks as the user — logging in with the
user's own SyteLine credentials, navigating to forms, filling fields,
clicking buttons, and reading results back. Design: ADR-019.

> **Honesty note:** the docs in this guide describe the full design.
> Playwright driving a real SyteLine web client is **REQUIRES REAL
> SYTELINE** — it has never been exercised in this sandbox. The
> FakeDriver (deterministic, in-memory) path is **VALIDATED IN CI**.

## Who can use it

UI driving is privileged: acting as a user inside the ERP can do
anything that user can do. The `syteline:ui` permission is granted to
**Admin and AI Admin only** — never the User role. A user drives
SyteLine only as themselves: their own stored credentials, or the
tenant service account. There is no cross-user impersonation.

The feature is also behind a master kill switch. If
`SYTELINE_UI_ENABLED=false` (the default), every `syteline.ui.*` tool
fails fast with a clear error.

## Environment variables

All set in the backend environment (`backend/.env`; production via the
secret manager — never committed). None of these have placeholder
values you should keep: placeholders are rejected at boot.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SYTELINE_UI_ENABLED` | no | `false` | Master kill switch. Everything UI fails fast when off. |
| `SYTELINE_UI_URL` | yes (to run) | — | HTTPS URL of the SyteLine web client, e.g. `https://syteline.example.com/...`. Must be `https`. |
| `SYTELINE_UI_USERNAME` / `SYTELINE_UI_PASSWORD` | no | — | Tenant/service-account fallback credentials, used only when the user has no stored credentials. Never logged. |
| `CREDENTIAL_STORE_KEY` | yes (for the credential store) | — | ≥32 bytes, hex or base64. AES-256-GCM key for stored passwords. Placeholder values are rejected; the credential feature refuses to boot without it (fail closed). |
| `SYTELINE_UI_SESSION_IDLE_MS` | no | `300000` (5 min) | Browser session idle TTL. |
| `SYTELINE_UI_SESSION_MAX_MS` | no | `1800000` (30 min) | Absolute max browser session duration. |
| `SYTELINE_UI_STEP_TIMEOUT_MS` | no | `30000` (30 s) | Per-driver-step timeout (inside `AI_TOOL_TIMEOUT_MS`). |

`CREDENTIAL_STORE_KEY` generation (run once, store in the secret
manager):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Windows setup (Enflite runs Windows)

Playwright supports Windows natively; no .bat launcher is needed
because the browser runs in-process in the backend. Setup on the
machine hosting the backend:

1. Install the backend's dependencies as usual (`npm ci` in
   `backend/`). Playwright is an **optional, lazy dependency** — the
   backend boots without it.
2. Install the Chromium browser binary Playwright drives:

   ```powershell
   npx playwright install chromium
   ```

3. Confirm the feature prerequisites: `SYTELINE_UI_ENABLED=true`,
   `SYTELINE_UI_URL` reachable from the backend host, and
   `CREDENTIAL_STORE_KEY` set.
4. Run the backend as a Windows service (or scheduled task) so the
   browser sessions survive logoff; Chromium needs no interactive
   desktop — it runs headless.

Notes:

- Headless Chromium is the default; the driver never needs a visible
  desktop.
- If Playwright is not installed, UI sessions fail fast with an
  explicit error naming the missing dependency — the backend itself
  keeps running.
- CI and machines without browser binaries exercise the deterministic
  `FakeDriver` instead; nothing in `npm test` / `npm run typecheck` /
  `npm run build` requires real Chromium.

## Credential save / rotate / revoke flow

Credentials are saved **per user** — the `userId` comes from the auth
context, never from tool arguments, so a user can only ever store
their own. Save is an upsert: saving again rotates.

Typical flow (in chat, Admin/AI-Admin role):

1. **Save** — `syteline.ui.saveCredentials { username, password, label? }`.
   Destructive: requires explicit confirmation. The `password` argument
   is declared in `secretParams`, so it is stored as `"[REDACTED]"` in
   persisted `tool_executions` and in audit metadata — it never lands in
   any log, transcript store, or audit trail in clear. The password the
   user typed in their own chat message is inherent; the save flow
   exists so it is typed exactly once.
2. **Rotate** — save again with the new password. The old entry is
   replaced (upsert per user).
3. **Revoke** — `syteline.ui.deleteCredentials {}`. Destructive:
   requires explicit confirmation. The stored entry is removed; audit
   records `SYTELINE_CREDENTIAL_DELETED` with the username only.
4. **Inspect (non-secret)** — `syteline.ui.listCredentials {}` returns
   `username` / `label` / `updatedAt` only — never secret material.

At login time the session manager decrypts the password into memory,
uses it for the SyteLine form login, then zero-fills the buffer.
Credential precedence: the user's stored credentials first, then the
`SYTELINE_UI_USERNAME` / `SYTELINE_UI_PASSWORD` service-account
fallback from env. The secret never appears in tool output, errors, or
logs — failures go through `sanitizeReason`.

**Key rotation:** rotating `CREDENTIAL_STORE_KEY` invalidates every
stored credential (they cannot be decrypted with the new key).
Procedure: set the new key, have each user re-save their credentials,
verify a login, then retire the old key. There is no automatic
re-encryption — by design, so a compromised key cannot be "recovered"
from stored ciphertext.

## Session lifecycle

`UiSessionManager` enforces: **at most one active browser session per
(tenantId, userId)**. Sessions are short-lived:

- `syteline.ui.startSession {}` — acquires (or reuses) the user's
  session and logs in to `SYTELINE_UI_URL`. Non-destructive, but only
  runs on explicit user request.
- Idle longer than `SYTELINE_UI_SESSION_IDLE_MS` → the session is
  closed and released.
- Older than `SYTELINE_UI_SESSION_MAX_MS` → the session is closed and
  released, no matter what.
- `syteline.ui.endSession {}` — closes the browser now and writes a
  session-summary audit event.

Every acquire and release writes an audit event (see below). Session
records carry `{ sessionId, userId, tenantId, startedAt, lastUsedAt }`
— sessions are never shared across users or tenants.

## Tool reference (summary)

Full contracts in `docs/api.md`. At a glance:

| Tool | Destructive | What it does |
|---|---|---|
| `syteline.ui.startSession` | no | Acquire the user's browser session; log in to `SYTELINE_UI_URL` |
| `syteline.ui.gotoForm` | no | Navigate to a form via the SyteLine form URL convention (`formName` must match `^[A-Za-z0-9_]+$`) |
| `syteline.ui.readScreen` | no | Return the ARIA/accessible snapshot text of the current screen |
| `syteline.ui.screenshot` | no | Store evidence server-side (tenant-scoped); returns `{ evidenceId, capturedAt }` — the model never receives raw pixels |
| `syteline.ui.fillField` | **yes** | Fill a field by accessible label — requires explicit confirmation |
| `syteline.ui.clickButton` | **yes** | Click a button by accessible label (may submit/save) — requires explicit confirmation |
| `syteline.ui.runTaskPlan` | **yes** | Execute a bounded (max 25 steps), zod-validated JSON task-plan: `gotoForm` / `fillField` / `clickButton` / `readScreen` / `assertText`; sequential, stops at first failure, per-step outcomes — requires explicit confirmation |
| `syteline.ui.endSession` | no | Close the browser; write the session-summary audit |
| `syteline.ui.saveCredentials` | **yes** | Save/rotate the caller's credentials (`secretParams: ['password']`) — requires explicit confirmation |
| `syteline.ui.deleteCredentials` | **yes** | Revoke the caller's stored credentials — requires explicit confirmation |
| `syteline.ui.listCredentials` | no | Username/label/updatedAt only; no secret material |

Destructive tools are gated by the agentic loop's existing explicit-
confirmation flow (`destructive:true`) — UI writes get no new bypass.
Privacy routing treats the whole family as `syteline.*`: these tools
are never offered on cloud turns when customer or finance categories
are enforced, and capability prediction routes UI turns to local
Enflite preemptively (see `docs/privacy-routing.md`).

## Audit events

Query with `GET /api/v1/audit?action=…` (`audit:read`). Every event
carries tenant/user context and **never carries secret material** —
usernames only, passwords nowhere.

| Action | When | Metadata |
|---|---|---|
| `SYTELINE_CREDENTIAL_SAVED` | Credentials saved/rotated | `username` only |
| `SYTELINE_CREDENTIAL_DELETED` | Credentials revoked | `username` only |
| `SYTELINE_UI_LOGIN` | SyteLine login attempt | `username`, `success` / `failure` — never the secret |
| `SYTELINE_UI_SESSION_ACQUIRED` | Browser session acquired | `sessionId` |
| `SYTELINE_UI_SESSION_RELEASED` | Session closed (idle/max/explicit), with reason | `sessionId`, `reason` |
| `TOOL_EXECUTED` | Any `syteline.ui.*` call (existing tool audit) | sanitized reason; `saveCredentials` params carry `password: "[REDACTED]"` |
| `AGENTIC_LOOP_STEP` | Each agentic-loop step, including `runTaskPlan` steps | argument **keys** only |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI tools fail immediately with "feature disabled" | `SYTELINE_UI_ENABLED` is `false`/unset | Set `SYTELINE_UI_ENABLED=true` and restart |
| `startSession` errors about Playwright unavailable | Playwright not installed | `npm i playwright` (optional dep) + `npx playwright install chromium` |
| `saveCredentials` refuses to boot / errors | `CREDENTIAL_STORE_KEY` missing, malformed, or a rejected placeholder | Generate a fresh ≥32-byte key (see above); never reuse a documented example |
| Login fails (`SYTELINE_UI_LOGIN` failure) | Wrong stored creds, or `SYTELINE_UI_URL` unreachable from the backend host | Re-save credentials; check the URL is `https` and reachable from the backend machine (not just your laptop) |
| `gotoForm` rejected | `formName` contains characters outside `^[A-Za-z0-9_]+$` | Use the plain form name; the driver builds the URL itself |
| `runTaskPlan` stops mid-plan | First failing step aborts the plan by design | Read the per-step outcomes, fix the failing step's label/text (screens change; ARIA labels are the selector), re-run |
| Session disappears between turns | Idle TTL or max duration expired | Re-run `startSession`; tune `SYTELINE_UI_SESSION_IDLE_MS` / `SYTELINE_UI_SESSION_MAX_MS` if the workflow legitimately needs longer |
| `TOOL_FORBIDDEN` on UI tools | Caller lacks `syteline:ui` (User role) | UI driving is Admin/AI-Admin only — grant the role or have an admin run it |
| Browser works locally but not as a service | Service account lacks a user profile temp dir, or proxy env vars missing | Run the service under a dedicated account with a writable profile; mirror `HTTP_PROXY`/`HTTPS_PROXY` into the service environment |

When reporting a UI-automation problem, include the `sessionId` and the
relevant audit events — never paste credentials, screenshots of login
fields, or ARIA snapshots containing customer data into a ticket.
