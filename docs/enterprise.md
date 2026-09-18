# Enterprise deployment guide

Operator-facing guide for the Phase 5 enterprise surface: OIDC login,
SyteLine integration, data-loss prevention, and retention. For the API
reference see `docs/api.md`; for the SyteLine assistant vision see
`docs/syteline-vision.md`.

## OIDC enterprise login

Password login stays available; OIDC Authorization Code + PKCE becomes the
primary enterprise login path when enabled.

### Setup

1. Register a confidential client at your IdP (Keycloak, Entra ID, Okta,
   …) with the redirect URI
   `https://<backend>/api/v1/auth/oidc/callback` and scopes
   `openid email profile` (groups come from the ID token or userinfo).
2. Set the `OIDC_*` variables (see `backend/.env.example`). When
   `OIDC_ENABLED=true` the server validates every required field at boot
   and refuses to start if anything is missing or `OIDC_ROLE_MAPPING`
   is not a JSON object of string→string.
3. The frontend ships the SSO experience: the login page calls
   `GET /api/v1/auth/oidc/status` and shows a "Sign in with SSO" button
   linking to `GET /api/v1/auth/oidc/login` when enabled. The callback
   page (`OIDC_FRONTEND_CALLBACK`) reads `access_token` from the URL
   **fragment** (never the query string), clears it from the URL
   immediately, and continues to the app. On `…#error=<code>` it shows a
   friendly sign-in failure message.

### Behavior

- `GET /auth/oidc/login` creates a state + PKCE pair + nonce, stores the
  verifier and nonce server-side (single-use, 10-minute expiry), and
  302-redirects to the IdP. Expired login attempts are cleaned up
  opportunistically.
- `GET /auth/oidc/callback` validates the single-use state, exchanges the
  code (client authenticated via `client_secret_basic`), and verifies the
  ID token signature against the IdP JWKS, checking issuer, audience,
  expiry, subject, and nonce (the token is bound to the authorization
  request that produced it). Email/name/groups fall back to userinfo only
  when the ID token lacks them; identity always comes from the verified
  token's `(issuer, sub)` pair.
- Identity is the verified `(issuer, subject)` pair, stored in
  `oidc_identities` — never the email address (emails change and are
  reassigned). First login auto-provisions the user: email from the
  verified token (claim name configurable via `OIDC_EMAIL_CLAIM`,
  `OIDC_NAME_CLAIM`), clearance `OIDC_DEFAULT_CLEARANCE`
  (least-privilege `PUBLIC` by default), and a deliberately unusable
  password hash (password login can never succeed for SSO-provisioned
  accounts). The user joins `OIDC_DEFAULT_TENANT_ID` with the mapped
  role; an existing user signing in via SSO for the first time is added
  to the default tenant the same way. Concurrent first-logins for the
  same IdP identity are serialized with an advisory lock; a leftover
  unique violation falls back to re-reading the winner.
- Group→role mapping (`OIDC_ROLE_MAPPING`, IdP group → internal role
  name) applies **only at provisioning**: unknown groups, and mappings
  to roles that do not exist, fail closed to the `User` role. Existing
  memberships keep their admin-managed role — role changes are an admin
  action, never silently rewritten by a login.
- Sessions are issued through the same machinery as password login
  (`createSession` + refresh cookie); refresh rotation, revocation, and
  audit semantics are unchanged. Logins audit as `LOGIN` with
  `metadata.provider: 'oidc'`; failures audit as `OIDC_LOGIN_FAILURE`.
- Account linking is deliberate, never automatic: an SSO identity whose
  email matches an existing local account is **not** merged into it —
  identity is `(issuer, subject)`, and email is not an identity proof.
  If provisioning collides with the unique email constraint, the callback
  fails closed (`#error=login_failed`, audited) and an administrator
  links the accounts explicitly.
- Tokens leave the server only in the callback redirect's URL fragment,
  so they never appear in server access logs. Callback failures also
  redirect with `#error=<code>` (audited as `OIDC_LOGIN_FAILURE`) rather
  than rendering a JSON error page, since the callback is a browser
  navigation endpoint; internal error codes never reach the URL.

### Security notes

- PKCE (S256) is always used; the authorization `state` is single-use and
  the ID token `nonce` binds the token to the request that produced it.
- The discovery document must describe the configured issuer — a
  document pointing at a different issuer is rejected. Issuers with a
  path (e.g. Keycloak realms) discover at
  `<issuer>/.well-known/openid-configuration`.
- Disabled accounts cannot sign in via SSO; the callback fails instead
  of provisioning.
- Rate limiting: 10/minute on both OIDC endpoints (same posture as
  password login).
- A live round-trip against a real IdP requires production
  infrastructure; CI covers the flow with mocked IdP endpoints and real
  RSA-signed test tokens.

## SyteLine read-only integration

See `docs/syteline-vision.md` for the assistant vision and `docs/api.md`
for the tool reference. Operational notes:

- `SYTELINE_BASE_URL` + `SYTELINE_API_TOKEN`; the token travels only as
  an `Authorization` header and is never logged or returned to the model.
- `SYTELINE_TIMEOUT_MS` (default 15000) bounds every adapter call;
  `SYTELINE_MAX_ROWS` (default 100) caps list fields, with `truncated:
  true` markers on truncated lists.
- Access requires the `syteline:read` permission (granted to User, Admin,
  AI Admin, Developer by migration `019`). Every call is audited with
  tenant/user/tool/result size (arguments live on the `tool_executions`
  record referenced by the audit).

## Data-loss prevention (DLP)

The assistant outbound boundary. Every assistant text chunk passes through
the DLP stream guard before it reaches the client or the persisted
transcript — what is streamed and what is stored are the same redacted
text.

- Built-in deterministic detectors: US Social Security numbers (dashed
  form) and credit-card-looking numbers (13–19 digits, Luhn-validated to
  avoid false-positiving on order numbers, UUIDs, and snowflake IDs).
- Detected spans are replaced with a visible marker — `[redacted:SSN]`,
  `[redacted:card]` — with no lecture and no refusal. The answer stays
  useful; only the sensitive span is masked.
- Streaming safety: the guard holds back only the trailing run of
  digits/spaces/dashes (capped at 40 chars, longer than any detectable
  pattern) from each emission and scans tail + chunk as one window, so a
  pattern split across provider chunks is still caught. Text without a
  trailing digit run streams with no added latency. The held run is
  flushed before the terminal `done` frame.
- Detections are audited per turn as `DLP_DETECTION` with kinds and
  counts only — matched text is never logged or persisted.
- Optional external hook (`DLP_EXTERNAL_ENDPOINT`): `POST { "text" }` →
  `{ "text" }` (redacted). It runs over built-in-redacted text as
  best-effort defense in depth. Each window awaits the hook (its output
  gates emission), bounded by `DLP_EXTERNAL_TIMEOUT_MS` (default 2000ms):
  a slow sidecar adds at most that latency per chunk and can never stall
  the stream indefinitely; any failure or timeout fails open to the
  built-in redaction. The platform runs fully without it; point it at a
  fast local sidecar.
- Disable with `DLP_ENABLED=false` (not recommended for production).

## Retention and legal hold

Per-tenant retention for conversations, messages, and audit events,
enforced by a scheduled in-process purge.

- Global defaults: `RETENTION_CONVERSATIONS_DAYS=365`,
  `RETENTION_MESSAGES_DAYS=365`, `RETENTION_AUDIT_EVENTS_DAYS=730`.
  `null`/`0` disables purging for that table (keep forever).
- Per-tenant overrides: `PUT /api/v1/retention/policy` with
  `{ conversationsDays, messagesDays, auditEventsDays }` (nullable;
  `null` falls back to the global default). `GET` returns overrides +
  the effective policy. Requires the `retention:manage` permission
  (Admin, Security Admin).
- The purge runs in-process every `RETENTION_PURGE_INTERVAL_HOURS`
  (default 24), started at server startup and stopped at shutdown.
  Deletes run in bounded batches (1000 rows); a failed tenant is logged
  and the sweep continues. Every instance in a multi-instance deployment
  runs the scheduler — the idempotent deletes make concurrent sweeps
  safe.
- Conversations purge on `updated_at` (long-running conversations stay);
  messages and audit events purge on `created_at`. Deleting a
  conversation cascades to its messages.
- Legal hold: `POST /api/v1/retention/conversations/:id/legal-hold`
  `{ "hold": true|false }` exempts the conversation and all its messages;
  `POST /api/v1/retention/audit-events/:id/legal-hold` exempts an audit
  row. Hold changes audit as `LEGAL_HOLD_SET`/`LEGAL_HOLD_CLEARED`.
- Audit reconciliation: audit is append-only by convention, but legal
  retention requires old audit rows to be deletable. Each purge writes a
  `RETENTION_PURGE` summary *after* deleting (per-table counts, the
  effective policy — no sensitive content); the summary row is new, so it
  survives its own retention window and stands as the durable,
  non-sensitive record of what was deleted and why. A sweep-level
  `RETENTION_PURGE_SWEEP` event records the multi-tenant run.
