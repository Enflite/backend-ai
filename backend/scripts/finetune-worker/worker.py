#!/usr/bin/env python3
"""
Reference self-hosted fine-tune worker (ADR-015, FINETUNE_PROVIDER=local).

The API server never trains. It enqueues jobs in the `finetune_jobs`
collection; this worker (running on your GPU machine) claims them atomically,
runs training, and reports back. This is a REFERENCE implementation — adapt
the training command to your stack (torchtune, axolotl, llama-factory).

Claim contract (must match backend/src/learning/finetune/jobs.ts):
  - Claim: findOneAndUpdate({status:'queued'}, {$set:{status:'running',
    lockedAt: now, lockedBy: workerId}, $inc:{attempts:1}}, sort createdAt)
  - Success: update {_id} -> {status:'succeeded', artifactRef, updatedAt}
  - Failure: update {_id} -> {status:'failed', error, updatedAt}

The worker itself is cross-platform Python (Windows/macOS/Linux). GPU
TRAINING stacks are Linux-first: on Windows machines prefer WSL2 + NVIDIA
CUDA, or Docker Desktop with --gpus all (see README.md).

The worker fetches the training JSONL from the API:
  GET {API_BASE}/api/v1/learning/datasets/{datasetId}/export
authenticated with a worker API key (any user with finetune:manage).

Usage:
  pip install pymongo requests
  python worker.py --mongo-uri mongodb://... --api-base https://ai.internal \
      --api-key $WORKER_API_KEY --worker-id gpu-01
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile
import time

import requests
from pymongo import MongoClient, ReturnDocument


def utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def claim_job(coll, worker_id: str):
    """Atomically claim the oldest queued job. Only one worker wins."""
    return coll.find_one_and_update(
        {"status": "queued"},
        {
            "$set": {"status": "running", "lockedAt": utcnow(), "lockedBy": worker_id,
                     "updatedAt": utcnow()},
            "$inc": {"attempts": 1},
        },
        sort=[("createdAt", 1)],
        return_document=ReturnDocument.AFTER,
    )


def fetch_dataset_jsonl(api_base: str, api_key: str, dataset_id: str) -> str:
    url = f"{api_base.rstrip('/')}/api/v1/learning/datasets/{dataset_id}/export"
    resp = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=60)
    resp.raise_for_status()
    return resp.text


def run_training(jsonl_path: str, base_model: str, out_dir: str,
                 hyperparameters: dict | None) -> str:
    """
    ADAPT THIS to your training stack. The example below shows the shape of a
    torchtune-style LoRA run; replace with axolotl / llama-factory / your own.
    Must produce an artifact directory (or checkpoint path) on success.
    """
    hyper = hyperparameters or {}
    cmd = [
        sys.executable, "-m", "your_training_module",  # <-- replace
        "--base-model", base_model,
        "--train-file", jsonl_path,
        "--output-dir", out_dir,
    ]
    for key, value in hyper.items():
        cmd += [f"--{key}", str(value)]
    print(f"[worker] running: {' '.join(cmd)}", flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=12 * 3600)
    if proc.returncode != 0:
        raise RuntimeError(f"training failed (exit {proc.returncode}):\n{proc.stderr[-4000:]}")
    return out_dir


def upload_artifact(out_dir: str, job_id: str) -> str:
    """
    ADAPT THIS: push the trained adapter/checkpoint to your artifact store
    (S3, HuggingFace Hub, NFS, ...) and return the artifact reference that the
    API will record (e.g. an s3:// URI or HF repo id). The API registers it
    as a DRAFT model — it cannot serve traffic until eval-gated promotion.
    """
    # Example placeholder: tar the output dir and pretend-upload.
    # Replace with your real upload and return its URI.
    return f"local-artifact://{job_id}"


def process_job(coll, job: dict, args) -> None:
    job_id = str(job["_id"])
    print(f"[worker] claimed job {job_id} (dataset {job['datasetId']})", flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix=f"finetune-{job_id}-") as tmp:
            jsonl_path = os.path.join(tmp, "training.jsonl")
            with open(jsonl_path, "w", encoding="utf-8") as f:
                f.write(fetch_dataset_jsonl(args.api_base, args.api_key, job["datasetId"]))
            out_dir = os.path.join(tmp, "artifact")
            run_training(jsonl_path, job["baseModel"], out_dir, job.get("hyperparameters"))
            artifact_ref = upload_artifact(out_dir, job_id)
        coll.update_one(
            {"_id": job["_id"]},
            {"$set": {"status": "succeeded", "artifactRef": artifact_ref,
                      "updatedAt": utcnow()}},
        )
        print(f"[worker] job {job_id} succeeded -> {artifact_ref}", flush=True)
    except Exception as exc:  # noqa: BLE001 — must report, never crash the loop
        coll.update_one(
            {"_id": job["_id"]},
            {"$set": {"status": "failed", "error": str(exc)[:2000],
                      "updatedAt": utcnow()}},
        )
        print(f"[worker] job {job_id} failed: {exc}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Reference fine-tune worker (ADR-015)")
    parser.add_argument("--mongo-uri", required=True)
    parser.add_argument("--db-name", default="enflite")
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--worker-id", default=f"worker-{os.getpid()}")
    parser.add_argument("--poll-seconds", type=int, default=15)
    args = parser.parse_args()

    client = MongoClient(args.mongo_uri)
    coll = client[args.db_name]["finetune_jobs"]
    print(f"[worker] {args.worker_id} polling every {args.poll_seconds}s", flush=True)

    while True:
        try:
            job = claim_job(coll, args.worker_id)
            if job:
                process_job(coll, job, args)
            else:
                time.sleep(args.poll_seconds)
        except KeyboardInterrupt:
            print("[worker] stopping", flush=True)
            return 0
        except Exception as exc:  # noqa: BLE001 — keep polling through transient errors
            print(f"[worker] poll error: {exc}", flush=True)
            time.sleep(args.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
