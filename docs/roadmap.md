# Roadmap and implementation status

## Implemented

- Session authentication, server-side RBAC, tenant RLS, classification policy, audit events, approved-model AI Gateway, conversations, and SSE chat.
- Secure document upload/metadata/delete/retry, S3-compatible storage, durable ingestion jobs, malware scanner boundary, real local extractors, chunking, embedding provenance, pgvector HNSW storage, permission-aware retrieval, grounded chat citations, and a connected React document workspace.

## Partially implemented

- Observability provides request/trace IDs and structured latency logs; an OpenTelemetry exporter and metrics backend remain deployment work.
- The ingestion queue is durable across restarts but executes inside one API process. A dedicated worker is needed for multi-replica scale.
- Extraction preserves available PDF page and spreadsheet sheet/row metadata. DOCX section fidelity depends on headings present in the file.

## Not implemented

- Tool Gateway production adapters and read-only SyteLine operations are the next phase.
- Fine-tuning, destructive SyteLine tools, external IdP wiring, DLP, enterprise retention enforcement, and legal-hold workflows.

No document asserts CMMC, NIST, FedRAMP, or other certification. Infrastructure, organizational procedures, deployment configuration, and independent assessment remain required.
