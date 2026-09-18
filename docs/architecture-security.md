# Architecture and security model

The React client calls only the Fastify `/api/v1` API. Fastify owns identity, permissions, tenant context, model/provider resolution, storage credentials, retrieval, tools, and audits. PostgreSQL with pgvector stores metadata, conversations, messages, embeddings, grants, sessions, and audit/tool records. S3-compatible storage holds opaque document objects.

## Authentication and authorization

Passwords are Argon2id hashes. Login creates a revocable database session, returns a short-lived signed access token, and sets a rotating refresh token in a `HttpOnly`, `SameSite=Strict` cookie. The browser keeps the access token only in memory. Logout revokes the session. Every authenticated request verifies the token, active session, active user, tenant membership, current role, and current database permissions. An enterprise OIDC/SAML broker can replace the credential-verification boundary without changing downstream authorization or sessions; that broker is deployment work, not an implemented provider.

Tenant and owner filters are applied in every resource query. Row-level security adds defense in depth when the production database role is a non-owner without `BYPASSRLS`. Roles grant coarse permissions; model, document, and resource grants provide narrower access.

## Classification and policy

Supported labels are `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `PROPRIETARY`, `CUI`, and `UNKNOWN`. `UNKNOWN` is always denied. The policy engine checks tenant, ownership/grants, user clearance, model compatibility, and tool compatibility before data crosses a boundary.

Classification is enforced on the write side as well as the read side: conversation creation, chat turns, uploads, and reclassification reject any label above the caller's clearance (`CLASSIFICATION_DENIED`), and an explicit upload classification requested without the `document:classify` permission is rejected rather than silently downgraded. Renaming a conversation requires the dedicated `conversation:update` permission (granted to User, Developer, and Admin roles); read-only roles cannot mutate titles.

## AI gateway and conversations

Clients send a registry UUID, never a URL or key. The gateway resolves enabled `APPROVED` models granted to the current user or role and permits only `vllm` or `openai-compatible` providers. It enforces classification compatibility, timeouts, cancellation, audit recording, and SSE `meta`, `delta`, `done`, and `error` events. Conversations and messages persist under both tenant and owner filters. Provider-reported usage is not currently stored because it is not available from the streaming adapter.

## Documents and secure RAG

Uploads are size limited, traversal names rejected, extensions allowlisted, and signatures checked. Objects use opaque tenant/document keys. Production requires the HTTP malware scanner mode and endpoint; unavailable or infected scans are quarantined, and CUI also fails closed in the explicit development mode. PDF, DOCX, XLSX, HTML, CSV, Markdown, and text are extracted locally with bounded archive expansion and extracted-text/chunk limits. Durable jobs scan, extract, chunk, call a configured internal OpenAI-compatible embedding endpoint, and write pgvector rows with model/version/dimension provenance.

Retrieval applies tenant, READY state, classification, requested-document, owner, user, role, department, and group predicates in SQL before vector ordering. A bounded hybrid rerank operates only on already-authorized candidates. Returned chunks are escaped and delimited as untrusted reference data under a system rule that prohibits following retrieved instructions. Citation records come directly from selected rows; the application does not synthesize citations.

## Tool gateway and SyteLine

Tools are compiled server-side definitions with strict schemas, permission/classification policy, rate limits, timeouts, and execution/audit records. Destructive definitions must require explicit confirmation. The initial `syteline.getItem` definition uses an adapter and server-side endpoint/token configuration. It is unavailable until deployment supplies those values; there is no fake production connection and the model never receives credentials or database access.

## Audit and observability

Login, logout, authentication/authorization failures, conversation access/deletion, model calls, document operations, retrieval, and tools emit tenant-scoped events. Sensitive metadata keys are redacted. Structured request logs include actual request/trace IDs, status, actor scope, route, and measured Fastify latency. Incoming W3C `traceparent` trace IDs are propagated to logs and response headers. Exporter/collector configuration remains a deployment responsibility.
