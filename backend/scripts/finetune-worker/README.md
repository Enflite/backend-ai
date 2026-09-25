# Self-hosted fine-tune worker (reference)

This directory holds the **reference worker** for `FINETUNE_PROVIDER=local`
(ADR-015). It runs on your GPU machine(s), claims jobs from the
`finetune_jobs` MongoDB collection, trains, and reports back. The API server
never trains.

The worker itself is plain Python and runs on Windows, macOS, or Linux.

## Windows machines (Enflite)

GPU training stacks (torchtune, axolotl, llama-factory) are Linux-first, so
on Windows pick one of these paths:

1. **WSL2 + NVIDIA CUDA (recommended).** Install WSL2 with Ubuntu, install
   the NVIDIA CUDA driver for WSL inside it, then run the worker there —
   everything below works unchanged and the GPU is fully visible to Linux
   training tools.
2. **Docker Desktop with GPU passthrough.** Run the worker in a Linux
   container with `--gpus all`; mount your training stack into the image.
3. **Native Windows.** Works for the worker itself (`py worker.py ...`),
   and PyTorch with CUDA runs natively — but expect friction with
   torchtune/axolotl, which assume a POSIX environment. Only pick this if
   your trainer is verified on native Windows.

`run-worker.bat` is a minimal native-Windows launcher (edit the variables at
the top). For WSL2, use the bash commands below instead.

## Setup

```bash
pip install pymongo requests
python worker.py \
  --mongo-uri "mongodb+srv://..." \
  --api-base https://ai.yourcompany.internal \
  --api-key "$WORKER_API_KEY" \
  --worker-id gpu-01
```

`WORKER_API_KEY` belongs to a service user with `finetune:manage` (it needs
the dataset export endpoint). Run one worker per GPU machine; the atomic
claim guarantees a job is trained exactly once.

## Adapting to your stack

`worker.py` is a contract reference, not a finished trainer. Two functions
are marked `ADAPT THIS`:

- `run_training(...)` — shell out to your trainer (torchtune, axolotl,
  llama-factory). QLoRA on an 8B model fits a single 24GB card (RTX 4090);
  a full fine-tune wants 2× H100-80GB.
- `upload_artifact(...)` — push the adapter/checkpoint to your artifact
  store and return its URI (s3://…, HF repo id, …).

## Safety notes

- A succeeded job registers the artifact as a **DRAFT** model
  (`enabled: false`). It cannot serve traffic until it passes the eval-gated
  promotion flow (ADR-008). Training never auto-promotes.
- If a worker dies mid-job, the API's `requeueStaleJobs` returns the job to
  `queued` after 2 hours (configurable in
  `backend/src/learning/finetune/jobs.ts`).
- Training data may contain non-PUBLIC content: run workers on trusted
  machines with the same data-handling posture as the API servers.
