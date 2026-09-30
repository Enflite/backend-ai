# ADR-019: Agentic SyteLine UI automation (syteline.ui.*)

**Status:** Accepted

## Context

The read-only SyteLine tools (ADR, Phase 5) and the form-project builder
(Phase 5+) cover data reads and form-project scaffolding, but some real
workflows only exist inside the SyteLine web client itself: tasks that
require navigating forms, entering data, and clicking through multi-step
sequences. Jake approved a build plan where the assistant drives the
Infor Mongoose / SyteLine web client in a real browser session — logging
in *as the user* with the user's own credentials — and completes
multi-step tasks on explicit request.

Two hard constraints shape every decision below:

1. **Acting-as-the-user is privileged.** A browser session authenticated
   as a human can do anything that human can do in the ERP. It must never
   be ambiently available the way read tools are.
2. **Passwords must exist once and travel nowhere.** The save flow exists
   so a password is typed once, stored encrypted, decrypted only at login
   time, and never appears in logs, audit trails, tool transcripts, or
   model context.

This ADR records the design decisions. The operator-facing details live
in `docs/syteline-ui.md`; the tool contracts in `docs/api.md`.

## Decision

### 1. Playwright in-process driver (browser runs inside the backend)

The browser driver lives in `backend/src/syteline/ui/`, behind a narrow
`UiDriver` interface (`goto`, `fillField`, `clickButton`, `readScreen`,
`screenshot`, `waitForText`/`assertVisible`, `close`; every method takes
an `AbortSignal`). The concrete implementation is a Playwright Chromium
driver (`playwrightDriver.ts`).

Playwright is an **optional, lazily-imported dependency**
(`await import('playwright')`), so the backend boots and runs fine
without it; requesting a UI session without Playwright installed fails
fast with a clear, actionable error. It must not break `npm test`,
`npm run typecheck`, or `npm run build` on a machine without browser
binaries. No .bat launcher is needed — the browser runs in-process —
but the Windows setup (Enflite runs Windows) is documented in
`docs/syteline-ui.md`, including `npx playwright install chromium`.

*Rationale:* an in-process driver keeps the security boundary where the
platform already enforces it — authz, audit, timeouts, and credential
handling all run in the same backend process, and there is no second
service to authenticate, deploy, or observe.

### 2. Per-user encrypted credential store (Jake's requirement)

`backend/src/secrets/credentialCrypto.ts`: AES-256-GCM, key from
`CREDENTIAL_STORE_KEY` (≥32 bytes, hex or base64). Following the
`JWT_SECRET` hygiene in `config.ts`: documented placeholder values are
rejected, and the credential feature refuses to boot when the key is
absent or malformed — fail closed.

Storage is a tenant-scoped Mongo collection `syteline_credentials`:
username in **cleartext** (identifier, used for labeling and audit),
password **never in clear** — persisted as `{ iv, ciphertext, authTag,
alg: 'aes-256-gcm' }`. Save = rotate (upsert per user); the `userId`
comes from the auth context, never from tool arguments — a user can only
ever store their own credentials. No cross-user impersonation: a user
drives SyteLine only as themselves (their stored creds, or the
tenant/service account fallback from env).

Login-time discipline: the session manager decrypts the password into
memory at login, uses it for the SyteLine form login, then zero-fills
the buffer. Precedence: user's stored creds first, then
`SYTELINE_UI_USERNAME` / `SYTELINE_UI_PASSWORD` from env. The secret is
never logged, never echoed, never returned in tool output or errors —
failure paths go through `sanitizeReason`.

A password typed in chat lives in the user's own message (inherent);
the save flow exists so it is typed exactly once.

### 3. `secretParams` redaction in the tool pipeline (core, minimal)

The gateway's `runToolCall` persists `parameters` into
`tool_executions`. A new optional `secretParams?: string[]` on
`ToolDefinition` redacts those keys (e.g. `"[REDACTED]"`) in the
persisted parameters **and** in any audit metadata.
`syteline.ui.saveCredentials` sets `secretParams: ['password']`.
The change to `backend/src/tools/gateway.ts` is kept minimal — it is
the one core change in the whole plan.

### 4. Session manager: one short-lived session per user

`UiSessionManager`: at most **one active browser session per
(tenantId, userId)**; short-lived with an idle TTL and an absolute max
duration (env-configurable, conservative defaults: 5 min idle / 30 min
max). Session records `{ sessionId, userId, tenantId, startedAt,
lastUsedAt }`. Every acquire/release writes an audit event. The session
manager is what binds "a browser acting in the ERP" to "one
authenticated platform user" — sessions are never shared across users
or tenants.

### 5. `syteline.ui.*` tool family, destructive writes ride the existing gate

`backend/src/tools/sytelineUi.ts` (registered in `toolRegistry`),
all with `permission: 'syteline:ui'`:

- `syteline.ui.saveCredentials` / `deleteCredentials` / `listCredentials`
  (credential lifecycle; save/delete are `destructive:true`)
- `syteline.ui.startSession` / `endSession` (session lifecycle;
  non-destructive)
- `syteline.ui.gotoForm` / `readScreen` / `screenshot` (non-destructive;
  screenshot returns `{ evidenceId, capturedAt }` — evidence ids only,
  never raw pixels to the model, keeping customer data out of model
  context)
- `syteline.ui.fillField` / `clickButton` / `runTaskPlan`
  (`destructive:true`; `runTaskPlan` is a bounded, zod-validated JSON
  task-plan DSL — max 25 steps, sequential, stops at first failure,
  per-step outcomes, each step audit-logged with argument keys only)

`startSession` runs only on explicit user request (enforced by the
permission plus the model-prompt trigger-phrase contract).

No new approval machinery: the existing agentic loop already gates
`destructive:true` tools behind explicit confirmation — UI writes ride
that gate with no bypass.

### 6. `syteline:ui` permission: Admin / AI Admin only

New permission `syteline:ui` in `backend/src/authz/permissions.ts`,
granted to **Admin and AI Admin only** — explicitly **not** the User
role. Form-project tools stay default-open for developers; driving a
browser as a user does not. Migration `031_…` follows the
`030_syteline_forms_permission.ts` pattern (idempotent). The existing
`buildProviderTools` permission filter needs no change, but a test must
prove UI tools are never offered to a User-role auth.

### 7. Privacy routing inherits automatically (verify, keep)

The `syteline.` name prefix means privacy routing already strips these
tools from cloud-served turns (`CUSTOMER_DATA_TOOL_PREFIXES =
['syteline.']`) and the capability-predicted rule routes UI turns to
local Enflite preemptively (see `docs/privacy-routing.md`). The code PR
must verify this inheritance rather than re-implement it. Sensitive
data pulled from the ERP UI is customer/finance/proprietary data — it
stays local, default-deny, fails closed.

### 8. FakeDriver CI strategy

A deterministic in-memory `FakeDriver` implements `UiDriver` for tests
and CI. All UI behavior is **VALIDATED IN CI** through it: crypto
round-trip/tamper tests, credential store scoping and isolation, the
`secretParams` redaction path, session-manager expiry and scoping, tool
authorization and the destructive gate, `runTaskPlan` schema rejection
and fail-fast, and the User-role tool-filter test. Real Playwright
driving a real SyteLine web client is **REQUIRES REAL SYTELINE** and is
never claimed as validated here.

## Consequences

- The `syteline:ui` kill switch `SYTELINE_UI_ENABLED` (default `false`):
  every UI tool fails fast when the feature is off.
- Credential-store key rotation is an operator procedure (see
  `docs/syteline-ui.md`): rotating `CREDENTIAL_STORE_KEY` invalidates
  stored credentials — they must be re-saved.
- `runTaskPlan`'s DSL is intentionally small (five actions); growing it
  is a new ADR, not scope creep in the code PR.
- Screenshots are server-side evidence, tenant-scoped; the model never
  sees pixels — a deliberate limit, not a TODO to "fix" later.

## Validation status

- **VALIDATED IN CI (code PR):** everything above testable without a
  browser, via FakeDriver, per §8 of the approved build plan.
- **REQUIRES REAL SYTELINE:** actual Chromium login and form driving
  against the SyteLine web client; Windows Chromium install via
  `npx playwright install chromium`.
