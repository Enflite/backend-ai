# Roadmap and implementation status

Status baseline: `main` after PR #16 (all six build phases complete:
security/correctness → eval framework → private inference → scale/reliability
→ enterprise → advanced AI).

## Implemented

- Session authentication, server-side RBAC, tenant RLS, classification policy, audit events, approved-model AI Gateway, conversations, and SSE chat.
- Secure document upload/metadata/delete/retry, S3-compatible storage, durable ingestion jobs (worker pool with retries, idempotency, poison-job quarantine, tenant fairness), malware scanner boundary, real local extractors, chunking, embedding provenance, pgvector HNSW storage, permission-aware retrieval, grounded chat citations, and a connected React document workspace.
- Private inference: provider abstraction, vLLM production path, dev-only Ollama, eval-gated model lifecycle (registered → evaluated → approved → canary → active), per-request latency telemetry.
- Capability routing: per-turn model selection across `chat`/`syteline`/`coding`/`embeddings` slots with audited fallback; generalized agentic tool loop with approval gate for destructive tools; repo-aware coding.
- Observability: request/trace IDs, RED-style metrics on `GET /metrics`, dependency-aware `/ready`, load-test harness (`npm run loadtest:smoke`), backup/restore runbook (`docs/recovery.md` + `scripts/verify-restore.sh`).
- Enterprise: agentic read-only SyteLine tools (items, sales orders, availability, POs, work orders, BOM, customers) with evidence-cited diagnoses, OIDC SSO, DLP scanning/redaction, retention enforcement + legal hold.

## Partially implemented

- An OpenTelemetry exporter and metrics backend remain deployment work (in-memory metrics + Prometheus exposition exist).
- The ingestion queue is durable across restarts but executes inside one API process. A dedicated worker is needed for multi-replica scale.
- Extraction preserves available PDF page and spreadsheet sheet/row metadata. DOCX section fidelity depends on headings present in the file.
- Egress control: the AI Gateway enforces an endpoint allowlist (`AI_PROVIDER_ALLOWED_ORIGINS`) with deny tests; tool-adapter egress hardening is in progress.
- Tool Gateway: the SyteLine adapter is production-grade; additional production adapters are future work.
- Destructive tool approvals: the agentic loop has an approval gate (write-capable tools never auto-execute); the human-in-the-loop review workflow and write tools are future work.

## Not implemented

- Fine-tuning support, multi-region deployment, live-environment validation (real GPU/vLLM, live SyteLine, live PostgreSQL/pgvector, production load tests, backup/restore drill, vulnerability scan sign-off) — tracked in TODO.md.

No document asserts CMMC, NIST, FedRAMP, or other certification. Infrastructure, organizational procedures, deployment configuration, and independent assessment remain required.
