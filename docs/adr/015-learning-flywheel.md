# ADR-015: Learning flywheel — feedback → datasets → fine-tuning with provider toggle

Status: accepted
Date: 2026-09-24

## Context

The assistant does not learn from production usage. There is no feedback
capture (no thumbs up/down, no correction flow), no training-dataset pipeline,
and no fine-tuning path — so mistakes never compound into improvements
(2026-09-24 review). Jake asked for the system to "grow & learn", starting
with a flywheel that can train against a 3rd-party GPU service for testing
and toggle to self-hosted machines via a feature flag / env variable.

Training a foundation model from scratch is out of scope and would be
wasteful: the platform orchestrates foundation models (Ollama primary,
vLLM high-throughput option, ADR-007). "Learning" here means the data flywheel around them: capture
signal, curate it, fine-tune (LoRA/QLoRA-class), eval-gate, promote.

## Decision

Build the flywheel as three stages behind one module (`backend/src/learning/`):

1. **Feedback capture** — `POST /feedback` lets any chat user rate an
   assistant message (`up`/`down`) and optionally supply a corrected answer.
   Corrections are the gold: an approved `down` + correction becomes a
   supervised fine-tuning (SFT) pair. Curators (`feedback:curate`) approve or
   reject feedback; only approved rows enter datasets.
2. **Dataset curation** — `POST /learning/datasets` builds a versioned JSONL
   SFT dataset from approved feedback. Each example is reconstructed from the
   `messages` collection: the user turn preceding the rated assistant message
   plus the approved correction (or the original answer for `up` ratings).
   Datasets are immutable once built (`status: ready`); export is an audited,
   `finetune:manage`-gated action.
3. **Fine-tune orchestration with provider toggle** — `FINETUNE_PROVIDER`
   env var, one of:
   - `disabled` (default) — all training endpoints return 403. The kill
     switch. Nothing trains by accident.
   - `external` — submits to a 3rd-party fine-tuning service over a
     generic OpenAI-compatible fine-tuning REST dialect
     (`POST /v1/files`, `POST /v1/fine_tuning/jobs`,
     `GET /v1/fine_tuning/jobs/{id}`), which covers OpenAI, Together AI and
     Fireworks. Base URL + API key come from `FINETUNE_API_BASE_URL` /
     `FINETUNE_API_KEY`; the URL's origin must be listed in
     `FINETUNE_ALLOWED_ORIGINS` (egress allowlist, same posture as
     `AI_PROVIDER_ALLOWED_ORIGINS`). This is the testing path: rent a GPU by
     the hour, no hardware.
   - `local` — the API server never trains. Jobs are enqueued in the
     `finetune_jobs` MongoDB collection and claimed atomically
     (`findOneAndUpdate`, the same pattern as the document-ingestion queue)
     by a self-hosted GPU worker. A reference worker
     (`backend/scripts/finetune-worker/`) defines the contract: claim →
     run training command (axolotl/torchtune/llama-factory) → upload artifact
     → report status.

Training never auto-promotes. A succeeded job registers the artifact in the
`models` collection with status `DRAFT`; serving it requires the existing
eval-gated promotion flow (ADR-008). The promotion gate is what makes the
flywheel safe: a bad fine-tune cannot reach users without passing evals.

**Serving a fine-tuned model (Ollama).** The training artifact is a GGUF
(or weights convertible to one). Serve it through the primary inference
provider with a Modelfile — `ollama create <name> -f Modelfile` — then
register `<name>` as a normal `ollama`-provider model and walk the standard
lifecycle (`REGISTERED → … → ACTIVE`). No application code changes are
needed: the gateway already speaks Ollama. See `docs/inference.md` §4.

## Alternatives considered

- **In-process training in the API server**: rejected. Training is bursty,
  GPU-bound, and long-lived; it does not belong in the request path. The
  queue/worker split keeps the API stateless and lets workers live anywhere.
- **Vendor-specific SDK per provider**: rejected. The OpenAI fine-tuning
  REST dialect is the de-facto standard across providers; one dialect,
  configurable base URL, no SDK sprawl.
- **RLHF / online weight updates from chat traffic**: rejected for now.
  Unsafe without a reward model and eval harness; SFT on curated corrections
  is the correct first loop. Revisit when the eval corpus is large.

## Consequences

- New permissions: `feedback:submit` (all chat roles), `feedback:curate`
  (AI Admin), `finetune:manage` (AI Admin). Seeded by migration
  `006_learning_flywheel`.
- New collections: `feedback`, `finetune_datasets`, `finetune_jobs`
  (tenant-scoped, indexed).
- Correction text is user-supplied training data: treated as untrusted input,
  never rendered unsanitized, and dataset export is audited. Examples carry
  the stricter of the source message classification and the curator's
  clearance.
- The `external` provider sends tenant training data to a third party:
  operators must confirm the provider's data-retention terms before enabling
  it on non-PUBLIC data. The config refuses to start with `external` unless
  `FINETUNE_ALLOWED_ORIGINS` is explicitly set.
- Cost: 3rd-party fine-tuning of an 8B model (QLoRA) is a few dollars per
  run on hourly GPU rental; the API server itself needs no GPU.
