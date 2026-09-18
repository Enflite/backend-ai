# Secure document knowledge and RAG

## Implemented flow

Authenticated uploads are size-limited, filename/extension/signature checked, hashed, and written under a random tenant/document object key. The server assigns the default classification (`PUBLIC` for public-only users, otherwise `INTERNAL`); only `document:classify` holders can request or change a classification. An explicitly provided empty classification counts as a request (403 without the permission, 400 with it) — only an absent value falls back to the default.

An append-only database job is queued after storage. A bounded worker scans, extracts, normalizes, chunks, embeds, and indexes the document. Jobs survive process restarts and stale jobs are reclaimed. Supported local extractors are PDF, DOCX, XLSX, TXT, CSV, Markdown, and HTML. Office archives have entry-count, expanded-size, and compression-ratio limits. Citation page, sheet, section, and source-location metadata is retained where the parser provides it.

Production requires `MALWARE_SCAN_MODE=http` and a scanner endpoint. Scanner infection, outage, or malformed responses quarantine the document. `disabled-development` is explicit: it never records a clean verdict, is prohibited in production, and still quarantines CUI.

Embeddings use the configured internal OpenAI-compatible endpoint. Each vector stores model, version, and dimensions; the current migration fixes the pgvector column to 1536 dimensions and creates a cosine HNSW index. Changing dimensions requires a migration and re-indexing rather than silently mixing vectors.

## Authorization and retrieval

`POST /api/v1/rag/search` derives user, tenant, role, and clearance from the verified session. Its SQL filters tenant, READY status, classification, owner, user/role grants, department membership, and security-group membership before vector ordering. A bounded lexical/vector rerank is then applied. Deleted, quarantined, failed, cross-tenant, higher-classification, and ungranted documents cannot enter the result set or model prompt.

Chat remains routed through the AI Gateway. Retrieved text is escaped and placed inside explicit `untrusted_document` delimiters below the system/application policy. Retrieved instructions never authorize tools or data access. Citations contain only source metadata actually produced by extraction.

## Operational limits and dependencies

Object storage, embeddings, and malware scanning are infrastructure dependencies; production has no fake fallback. Compose supplies private MinIO for development. It does not supply an embedding model, GPU inference, or scanner. Unit tests use deterministic test boundaries and do not claim external inference or scanning succeeded.

The in-process worker is suitable for a single API replica. Before horizontally scaling, use the durable job table with a dedicated worker deployment and database-backed concurrency leases.

## Relevance and safety gates

Retrieval blends cosine similarity (85%) with a lexical overlap score (15%) and reranks only already-authorized candidates. An operator may inject an external reranker via `setReranker()`; the hook executes after authorization filtering and before the similarity threshold, so a reranker can reorder candidates but can never introduce unauthorized chunks. Because the ANN traversal runs under selective tenant/ACL filters, each retrieval transaction sets `hnsw.ef_search = 200` (the default 40 under-recalls); confirm `vector >= 0.7.0` (`SELECT extversion FROM pg_extension WHERE extname = 'vector'`) so filtered HNSW scans cannot silently under-return rows. `RAG_SIMILARITY_THRESHOLD` (default `0`, disabled) applies a floor to the blended score after reranking: chunks below the threshold are excluded from model context and citations, so weak matches cannot fill `topK` slots.

Both the query embedding and stored chunk vectors are validated as finite numbers with the expected dimensions before use; a provider returning `NaN`, infinities, or wrong-dimension vectors fails the request instead of poisoning the index or the query.
