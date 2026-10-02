# Enabling the APS exception pipeline on your tenant

The `aps-exception-analysis` / `aps-exception-verify` flow definitions ship
in the repo (`flows/*.flow.json`), but flows are **tenant data**: each
tenant must import them, publish a version, and point the `live` alias at
it before the APS Planning Agent can run. Until then, analyses land
honestly in `pending-substrate` and `POST /aps/analyses/:id/retry`
re-attempts the start once the flows are live.

## Prerequisites

- Backend deployed with **`FLOWS_ENABLED=true`** (the Flows kill switch
  defaults to `false`; `APS_PLANNING_ENABLED` defaults to `true`).
- A user with **`flows:manage`** (Admin / AI Admin hold it; under the
  current all-permissions posture every role holds it). The publishing
  steps below need it; the retry step needs `aps:plan`.
- `curl` and `jq` on your machine. Run every command from the same
  shell session (the token is exported once).

## 1. Point at your backend and sign in

```bash
BASE_URL="https://your-backend.example.com"   # no trailing slash

TOKEN="$(curl -s -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"YOUR_PASSWORD"}' \
  | jq -r .accessToken)"
test -n "$TOKEN" && [ "$TOKEN" != "null" ] && echo "signed in"

auth() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }
```

## 2. Import the flow definitions from the repo

This loads both `aps-exception-analysis` and `aps-exception-verify`
as drafts on your tenant (creates new, updates changed, skips
unchanged):

```bash
auth -X POST "$BASE_URL/api/v1/flows/ensure" | jq '{created, updated, unchanged, errors}'
```

## 3. Publish a version of each flow

```bash
for FLOW in aps-exception-analysis aps-exception-verify; do
  auth -X POST "$BASE_URL/api/v1/flows/$FLOW/versions" \
    | jq --arg f "$FLOW" '{flow: $f, version: .version.version, revision: .revision}'
done
```

Note the `version` and `revision` numbers from the output — the next
step needs them.

## 4. Point the live alias at the published version

`expectedRevision` is the If-Match guard: if someone else changed the
flow since step 3 you get `412 REVISION_MISMATCH` instead of silently
overwriting them. (Replace `1` with your published version and `7`
with your revision from step 3.)

```bash
for FLOW in aps-exception-analysis aps-exception-verify; do
  auth -X POST "$BASE_URL/api/v1/flows/$FLOW/alias" \
    -H 'Content-Type: application/json' \
    -d '{"version":1,"expectedRevision":7}' \
    | jq '{liveVersion: .flow.liveVersion, revision: .flow.revision}'
done
```

## 5. Verify both flows resolve live

```bash
for FLOW in aps-exception-analysis aps-exception-verify; do
  auth "$BASE_URL/api/v1/flows/$FLOW/pull" | jq '{name, version}'
done
```

Both should print a `version` (no `NO_LIVE_VERSION` error). If you see
`FLOW_NOT_FOUND`, step 2 did not import the file; if `NO_LIVE_VERSION`,
step 4 did not stick.

## 6. Retry the waiting analyses

Any analysis that landed in `pending-substrate` while the flows were
unpublished can now start. The retry is idempotent — it re-uses the
stored intake inputs and never starts a second flow run:

```bash
auth "$BASE_URL/api/v1/aps/analyses?status=pending-substrate" \
  | jq -r '.items[].id' \
  | while read -r ID; do
      auth -X POST "$BASE_URL/api/v1/aps/analyses/$ID/retry" \
        | jq '{id, status, retried, flowRunId}'
    done
```

`{"status":"analyzing","retried":true}` means the pipeline run started.
`{"status":"pending-substrate","retried":false}` means the flow still is
not published — re-check steps 2–5.

## Notes

- Re-running steps 2–4 after a repo pull picks up new flow versions;
  the live alias stays where you pointed it until you move it, so
  review the diff before re-pointing.
- `flows:manage` is required for steps 2–4; `aps:plan` for step 6.
- Flow management actions are audited (`FLOW_CREATED`,
  `FLOW_PUBLISHED`, `FLOW_ALIAS_SET`); retries are audited
  (`APS_ANALYSIS_RETRY_STARTED` / `APS_ANALYSIS_RETRY_SKIPPED`).
