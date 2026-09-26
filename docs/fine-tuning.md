# Fine-Tuning Runbook — SyteLine-Pro Bootstrap

How to go from zero training data to a SyteLine-expert model served in
Ollama. Design: ADR-015 (learning flywheel). Serving: `docs/inference.md`
§4. Promotion gate: `docs/eval.md`.

> **Honesty note:** everything below the "kick off training" step was
> validated in CI with deterministic mocks only. No real training run has
> happened — there is no GPU and no vendor key in this environment. The
> owner's one remaining step is marked explicitly.

## 0. Prerequisites

- Backend running with MongoDB reachable; migrations applied
  (`npm run migrate`).
- A tenant exists (create one with `npm run create-user` if needed).
- `FINETUNE_PROVIDER` is `disabled` by default — the kill switch. Set it
  to `external` (testing: rent a GPU by the hour) or `local` (Enflite's own
  machines via the reference worker in `backend/scripts/finetune-worker/`).

## 1. Seed the SFT dataset

A fresh tenant has no approved feedback, so the flywheel ships with a
curator-authored seed: 154 SFT pairs (user question → expert answer)
grounded strictly in the SyteLine knowledge pack
(`docs/syteline-expert.md`, `docs/syteline-vision.md`). The seed file is
plain JSONL so curators can extend it by hand:

```
backend/scripts/seed-data/syteline-expert-seed-v1.jsonl
```

Run the seeder (idempotent — re-running is a no-op once the dataset
exists for the tenant):

```bash
cd backend
npm run seed:syteline-sft -- --tenant "Default Tenant"
# or by id: npm run seed:syteline-sft -- --tenant-id <tenantId>
# env fallback: SEED_TENANT_ID / SEED_TENANT / SEED_ORG / SEED_FILE
```

This inserts a `finetune_datasets` doc named `syteline-expert-seed-v1`
with `status: 'ready'` (immutable, like feedback-derived datasets).
Provenance: seed examples carry
`sourceFeedbackId: 'seed:syteline-expert-seed-v1:<n>'` — never a feedback
row id — so audits always distinguish curator-authored examples from
feedback-derived ones. The feedback-derived builder
(`POST /learning/datasets`) is untouched; the seed path is additive.

To grow the dataset later: append lines to the JSONL and seed under a new
name (`--name syteline-expert-seed-v2`), or let real usage flow through
the flywheel — user ratings/corrections → curator approval →
`POST /learning/datasets` — and train on the union.

## 2. Kick off training (owner's step — not run here)

Create a fine-tune job from the dataset (requires `finetune:manage`):

```http
POST /api/v1/learning/jobs
{ "datasetId": "<dataset _id>", "baseModel": "meta-llama/Meta-Llama-3.1-8B-Instruct" }
```

Then `POST /api/v1/learning/jobs/:id/sync` to poll the provider.

- `FINETUNE_PROVIDER=external`: submits over the OpenAI-compatible
  fine-tuning dialect (`FINETUNE_API_BASE_URL` / `FINETUNE_API_KEY`, origin
  allowlisted in `FINETUNE_ALLOWED_ORIGINS`). Needs a real vendor key —
  validate the vendor's API shape before spending money.
- `FINETUNE_PROVIDER=local`: the job is enqueued in MongoDB and claimed
  by the self-hosted GPU worker (`backend/scripts/finetune-worker/`,
  Windows-ready). The worker runs the training command
  (axolotl/torchtune/llama-factory), uploads the artifact, reports status.

## 3. Eval-gated promotion

A succeeded job registers the artifact in `models` with status `DRAFT`
and `enabled: false` — it cannot serve traffic. Promotion goes through
the existing eval gate (`docs/eval.md`,
`GET /api/v1/admin/eval/promotion-gate?modelId=`): deterministic cases
must pass; llm-judge verdicts inform but never gate on their own. A bad
fine-tune cannot reach users without passing evals.

## 4. Serve in Ollama

Export the promoted artifact as GGUF (or convert the weights), then:

```bash
ollama create syteline-pro -f Modelfile   # FROM <gguf>, SYSTEM prompt, etc.
```

Register `syteline-pro` as a normal `ollama`-provider model and walk the
standard lifecycle (`REGISTERED → … → ACTIVE`). No application code
changes: the gateway already speaks Ollama. The knowledge pack stays in
the system prompt on SyteLine turns regardless — fine-tuning deepens the
expertise, it does not replace the pack.

## What "SyteLine pro" means here

The seed teaches the model to reason like a veteran practitioner: name
real tables, fields, forms, and IDOs (never invent them); reason from
records, not vibes; run the diagnostic checklists (the "why is this
order late?" multi-step investigation is the flagship pattern); report
negative availability honestly by cause; and say plainly what could not
be checked. The flywheel then compounds it: every correction your team
makes becomes future training data.
