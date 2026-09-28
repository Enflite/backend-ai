# ADR-017: Vision model for image attachments

**Status:** Accepted

## Context

Users attach screenshots (e.g. a SyteLine error dialog) to chat, but
document validation rejected every image with "Document type is not
supported". The product direction is that common business documents and
images are first-class: a user should attach an error screenshot and get a
diagnostic answer, with no manual model selection.

The tenant default model (`llama3.1:8b`) is text-only. Sending it image
payloads would produce garbage or provider errors, and silently falling
back to it on a vision turn would answer about an image the model never
saw — a trust violation.

## Decision

- **Model choice: `qwen2.5vl:7b` (Ollama), seeded as
  `qwen/Qwen2.5-VL-7B-Instruct`.** Rationale: runs on the same
  Ollama-first topology as the rest of the platform (no new provider, no
  GPU-server changes), 7B class fits the same hardware that serves
  `llama3.1:8b`, Apache-2.0 license, 32k native context. The Windows setup
  script and README pull it alongside the chat and embedding models.
- **New `vision` capability** (`KNOWN_CAPABILITIES`), with its own
  resolution path (`resolveVisionModel`) that **never falls back to the
  text chat default**. Order: admin-configured vision serving default →
  platform vision model (ensure-on-read seed). Missing/unusable vision
  model fails the turn closed (`NO_APPROVED_MODEL`), never silent text.
- **Default-open, like the chat default** (ADR-016): the vision model is
  implicitly available to every user in every tenant; explicit
  `model_access.revoked = true` rows still deny per principal, and a
  disabled vision doc is never resurrected by the ensure path.
- **Image turns force the vision capability** even when the request
  carries an explicit `modelId`: a selected text model is replaced with a
  user-visible notice (`MODEL_VISION_SWITCH`); a selected
  vision-capable model is kept.
- **Images bypass RAG entirely**: they reach `READY` with zero chunks
  (still malware-scanned), and an image-only turn never emits the "no
  evidence" notice. Authorization for byte loading mirrors the RAG path
  (tenant, READY, not deleted, classification, owner-or-grant), bounded
  by `CHAT_MAX_IMAGES_PER_TURN` (4), `CHAT_MAX_IMAGE_BYTES` (8 MiB), and
  `CHAT_MAX_IMAGE_TOTAL_BYTES` (32 MiB) — any overage fails the turn with
  a clear error, never a silent drop.
- **Provider mapping**: Ollama `/api/chat` gets `images: [base64]` on the
  user message; OpenAI-compatible APIs get a content-parts array (text +
  `image_url` data URLs). The platform `ChatMessage` carries an
  optional `images` field; text-only paths are unchanged.
- **Text-only models can never receive image payloads**, at every layer:
  resolution (a non-vision `vision` serving default is refused and audited),
  selection (a selected text model is replaced with a user-visible notice),
  and provider failover (an image turn fails over only to another
  vision-capable model; a text-only fallback fails the turn closed with the
  generic provider error).

## Consequences

- `POST /chat` with image attachments requires the `qwen2.5vl:7b` model
  pulled on the Ollama host; without it the turn fails closed with a
  clear error (no silent fallback).
- Operators can bind a different vision model via the `vision` serving
  default (`model:manage`); per-turn images still cannot reach a
  text-only model.
- Vision quality is bounded by the 7B model's ability; the VISION INPUT
  system-prompt section steers screenshot diagnosis (quote error text
  exactly, identify the failing component, give causes + steps, never
  invent visible details).

## Validation

- **VALIDATED IN CI**: unit tests for validation/extraction/ingestion,
  provider mappings, ensure-on-read seeding, and a mocked-provider
  chat-turn test asserting an attached error screenshot yields the
  diagnostic answer path (not a validation error).
- **REQUIRES REAL INFRASTRUCTURE**: live Ollama + `qwen2.5vl:7b`
  answering a real SyteLine error screenshot; GPU sizing for the 7B
  vision model under concurrent load.
