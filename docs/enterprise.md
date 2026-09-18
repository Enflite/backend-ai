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
3. Point the frontend login page at `GET /api/v1/auth/oidc/status`;
   when `{"enabled": true}`, show a "Sign in with SSO" button linking to
   `GET /api/v1/auth/oidc/login`.
4. Implement the frontend callback page at `OIDC_FRONTEND_CALLBACK`:
   read `access_token` from the URL **fragment** (never the query string),
   store it the same way as a password-login token, and continue to the app.
   On `…#error=<code>` show a generic sign-in failure message.

### Behavior

- `GET /auth/oidc/login` creates a state + PKCE pair, stores the verifier
  server-side (single-use, 10-minute expiry), and 302-redirects to the
  IdP. Expired login attempts are cleaned up opportunistically.
- `GET /auth/oidc/callback` validates the single-use state, exchanges the
  code (client authenticated via `client_secret_basic`), and verifies the
  ID token signature against the IdP JWKS, checking issuer, audience,
  and expiry. Email/groups fall back to userinfo only when the ID token
  lacks them; identity always comes from the verified token.
- First login auto-provisions the user: email from the verified token,
  clearance `OIDC_DEFAULT_CLEARANCE` (least-privilege `PUBLIC` by
  default), and a deliberately unusable password hash (password login
  can never succeed for SSO-provisioned accounts). The user joins
  `OIDC_DEFAULT_TENANT_ID` with the mapped role.
- Group→role mapping (`OIDC_ROLE_MAPPING`, IdP group → internal role
  name) applies **only at provisioning**: unknown groups, and mappings
  to roles that do not exist, fail closed to the `User` role. Existing
  memberships keep their admin-managed role — role changes are an admin
  action, never silently rewritten by a login.
- Sessions are issued through the same machinery as password login
  (`createSession` + refresh cookie); refresh rotation, revocation, and
  audit semantics are unchanged. Logins audit as `LOGIN` with
  `metadata.provider: 'oidc'`; failures audit as `OIDC_LOGIN_FAILURE`.
- Tokens leave the server only in the callback redirect's URL fragment,
  so they never appear in server access logs.

### Security notes

- PKCE (S256) is always used; the authorization `state` is single-use.
- The discovery document must describe the configured issuer — a
  document pointing at a different issuer is rejected.
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
  tenant/user/tool/args/result size.

## Data-loss prevention (DLP)

*(Phase 5c — to be documented here.)*

## Retention and legal hold

*(Phase 5c — to be documented here.)*
