# CMMC and NIST control-area mapping

This software does not by itself make a deployment CMMC compliant. Formal scope, evidence, organizational procedures, infrastructure controls, and an external assessment are required.

| Control area | Software support | Deployment or organizational responsibility |
| --- | --- | --- |
| Access control | Sessions, RBAC, grants, tenant/owner filters, RLS, model/tool policy | IdP policy, account lifecycle, database roles, periodic reviews |
| Identification/authentication | Argon2id, token expiry, rotation, revocation | MFA/federation, proofing, recovery, secret rotation |
| Audit/accountability | Structured tenant events, request/trace correlation, redaction | Immutable retention, SIEM export, review and alert procedures |
| Configuration management | Versioned migrations, pinned application dependencies, CI | Approved baselines, change control, image registry and patching |
| Communications protection | No browser credentials; explicit CORS/cookies | TLS/mTLS, network segmentation, egress and certificate management |
| System/information integrity | Validation, scanner boundary, approved registries, secure RAG | Scanner operations, vulnerability response, model evaluation |
| Incident response | Correlated audit records and failure codes | Response plan, contacts, exercises, evidence preservation |
| Risk assessment | Threat model and explicit residual risks | Recurring assessments, supplier and model risk decisions |
| Media protection | Opaque private storage keys and authorized access | Encryption keys, backups, retention, disposal and export policy |
