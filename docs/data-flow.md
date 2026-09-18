# Security-sensitive data flow

1. JWT/session verification establishes user, tenant, role, permissions, and clearance.
2. Fastify route permissions deny unauthenticated or unauthorized calls.
3. Upload validation derives MIME type from extension and file signatures; client tenant IDs and storage paths are ignored.
4. Private object storage receives an opaque random key. Credentials never reach React.
5. The ingestion job records identifiers and safe error codes, not document contents.
6. Malware policy runs before extraction. Production and CUI fail closed when a clean verdict is unavailable.
7. Extraction and chunking retain real source metadata; embedding calls use only the configured internal endpoint.
8. PostgreSQL RLS and application SQL enforce tenant and document ACL filters before similarity ordering.
9. Retrieved text is untrusted prompt data. The AI Gateway resolves an approved model and is the only model-call path.
10. Responses contain grounded citations; audits record identity, request, action, result count, and resource IDs without full prompts or document text.

The React client can select documents and display status, errors, search results, and citations. It never makes authorization decisions; a manipulated request receives the same backend/RLS enforcement.
