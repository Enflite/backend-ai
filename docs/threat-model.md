# Threat model

Primary assets are credentials, sessions, proprietary documents, embeddings, model prompts/responses, internal tool access, and audit evidence. Primary adversaries include unauthenticated callers, compromised tenant users, malicious uploads, prompt-injection documents, SSRF attempts, stolen tokens, and misconfigured infrastructure.

Implemented mitigations include revocable rotating sessions; server-side RBAC, tenant, owner, model, document, classification, and tool checks; `UNKNOWN = deny`; RLS defense in depth; fixed provider/tool registries; strict input schemas; upload signature and malware boundaries; pre-vector authorization filters; untrusted-content delimiters; opaque object keys; rate limits; timeouts/cancellation; security headers; explicit CORS; audit redaction; and non-root containers.

Residual deployment risks include identity-provider configuration, TLS/key management, backup encryption, object-store policies, scanner/extractor hardening, egress controls, database role ownership, model supply-chain evaluation, incident response, retention, SIEM/OTel export, and SyteLine authorization semantics. Prompt injection is reduced, not mathematically eliminated; deployments should restrict tools, review destructive actions, and continuously evaluate models and documents.
