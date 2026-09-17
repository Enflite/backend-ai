# Master Build Prompt: Private AI Platform

You are the lead software architect and senior full-stack/ML engineer responsible for building a production-ready private AI platform.

Your job is to **actually implement the application**, not merely describe it.

The goal is to build an internally controlled, ChatGPT/Claude-style AI platform that can eventually handle proprietary customer information and potentially CUI inside an organization-controlled infrastructure environment.

The platform must be designed with CMMC/NIST SP 800-171 security requirements in mind from the beginning.

## 1. Primary Objective

Build a private AI platform with this architecture:

```text
React + TypeScript
        ↓
Node.js + TypeScript API
        ↓
AI Gateway / Orchestration
        ↓
RAG / Data Access / Security Policies
        ↓
Internal Model API
        ↓
vLLM
        ↓
GPU
        ↓
Self-hosted Open-Weight LLM
```

The system must be capable of running entirely inside infrastructure controlled by the organization.

The underlying model must be replaceable.

Do NOT tightly couple the application to one specific LLM.

The application should support an OpenAI-compatible internal model API so models can be changed without rewriting the frontend or core backend.

---

# 2. Critical Requirements

Build the application so that:

* Customer data can remain inside the controlled environment.
* Proprietary company information can remain inside the controlled environment.
* CUI can eventually be supported within the appropriate authorized security boundary.
* No sensitive information is sent to public AI APIs by default.
* The frontend never communicates directly with the model server.
* The Node.js backend is the security and orchestration boundary.
* Model servers are isolated from the public network.
* RAG retrieval is permission-aware.
* Users cannot retrieve documents they are not authorized to access.
* Tenant isolation is enforced server-side.
* AI tool calls are authorized independently of the LLM.
* Destructive actions require explicit user confirmation.
* All security-relevant actions are auditable.
* Secrets are never hard-coded.
* Sensitive data is not indiscriminately written to logs.
* Models are treated as controlled software artifacts.
* Dependencies are pinned and scanned.
* The application can be deployed using containers.
* Local development should be easy.
* Production deployment should be reproducible.

Do not claim that the resulting software is automatically "CMMC compliant."

Instead, build the technical controls and documentation necessary for the system to be evaluated against the organization's applicable CMMC requirements.

---

# 3. Technology Stack

Use:

## Frontend

* React
* TypeScript
* Vite
* Tailwind CSS
* React Query/TanStack Query
* Modern component architecture
* Server-sent events for streaming

The UI should feel like a polished combination of ChatGPT and Claude.

It should NOT look like a basic developer demo.

Include:

* Sidebar
* New Chat
* Conversation history
* Chat interface
* Markdown rendering
* Code blocks
* Copy buttons
* Streaming responses
* File attachments
* Source citations
* Model selector
* User/account menu
* Settings
* Loading states
* Error states
* Empty states
* Responsive layout

---

# 4. Backend

Use:

* Node.js
* TypeScript
* Fastify
* Zod
* PostgreSQL
* Prisma or Drizzle ORM

Prefer a modular architecture.

Suggested:

```text
apps/api/
  src/
    modules/
      auth/
      users/
      organizations/
      tenants/
      conversations/
      messages/
      files/
      search/
      ai/
      models/
      tools/
      audit/
      admin/
    middleware/
    plugins/
    config/
    server.ts
```

Do not create one enormous `server.ts`.

Keep business logic inside modules/services.

---

# 5. AI Gateway

Create a dedicated AI Gateway abstraction.

The frontend must call:

```text
POST /api/v1/chat
```

The Node backend handles:

```text
Authentication
      ↓
Authorization
      ↓
Data classification
      ↓
Conversation retrieval
      ↓
RAG retrieval
      ↓
Permission filtering
      ↓
Prompt construction
      ↓
Model selection
      ↓
AI request
      ↓
Streaming response
      ↓
Audit event
```

The React application should never know the physical address of vLLM.

---

# 6. Model Provider Abstraction

Create an interface similar to:

```typescript
interface ModelProvider {
  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
  listModels(): Promise<ModelInfo[]>;
}
```

Implement an OpenAI-compatible provider for internal vLLM.

The provider should support:

* Streaming
* Chat completion
* Model selection
* System prompts
* Conversation messages
* Temperature
* Max tokens
* Tool calls where supported
* Abort/cancellation
* Timeout handling
* Retries where appropriate

Configuration must come from environment/configuration rather than source code.

Example:

```text
MODEL_GATEWAY_URL
MODEL_GATEWAY_API_KEY
DEFAULT_MODEL
```

Never hard-code these values.

---

# 7. Local Model Infrastructure

Provide Docker configuration for vLLM.

The model server must:

* Run on an internal network.
* Not be directly exposed to the Internet.
* Require authentication from the AI Gateway.
* Have health checks.
* Have resource configuration.
* Have model configuration externalized.
* Have persistent model storage where appropriate.

Create:

```text
infrastructure/
  docker/
    vllm/
      Dockerfile
      docker-compose.yml
      README.md
```

Do not require a GPU for basic development.

The application should support a development mode using either:

1. A local CPU-compatible model, or
2. A configurable OpenAI-compatible test endpoint.

However, production configuration must support vLLM/GPU inference.

---

# 8. Database

Use PostgreSQL.

Create migrations.

Initial tables should include:

```text
users
organizations
tenants
memberships
roles
permissions

conversations
messages

documents
document_chunks
document_permissions

models

tools
tool_permissions

audit_events

sessions
api_keys
```

Every tenant-owned record must include:

```text
tenant_id
```

where applicable.

Do not rely on frontend-provided tenant IDs.

Derive tenant identity from the authenticated session/token.

---

# 9. Authentication

Build authentication as an abstraction.

The application should eventually support enterprise SSO.

For development, implement a secure local authentication mechanism.

Architecture:

```text
Auth Provider
      ↓
Session
      ↓
Authenticated User
      ↓
Tenant Membership
      ↓
Authorization
```

Support:

* Password hashing using an approved modern password hashing mechanism.
* Secure sessions.
* Session expiration.
* Logout.
* Account lockout/rate limiting where appropriate.
* MFA-ready architecture.
* SSO-ready architecture.

Do not invent a custom cryptographic system.

---

# 10. Authorization

Implement server-side RBAC.

Example roles:

```text
USER
POWER_USER
AI_ADMIN
DATA_ADMIN
SECURITY_ADMIN
SYSTEM_ADMIN
AUDITOR
```

Authorization must occur before:

* Document access
* Conversation access
* Tool execution
* Administrative actions
* Model administration
* User administration

Never trust:

```text
tenantId
userId
role
permissions
```

from the frontend.

---

# 11. Data Classification

Implement:

```typescript
type DataClassification =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "PROPRIETARY"
  | "CUI";
```

Documents and AI requests must carry classification metadata.

Implement policy enforcement.

Example:

```text
PUBLIC
  → Local model or explicitly approved external provider

INTERNAL
  → Local model

CONFIDENTIAL
  → Local model

PROPRIETARY
  → Local model

CUI
  → Authorized internal/CUI environment only
```

If classification is unknown:

```text
BLOCK
```

Do not silently downgrade classification.

---

# 12. RAG

Implement retrieval-augmented generation.

Initial architecture:

```text
Upload Document
      ↓
Security Validation
      ↓
Document Parsing
      ↓
Chunking
      ↓
Embedding
      ↓
PostgreSQL + pgvector
```

During chat:

```text
User Question
      ↓
Embedding
      ↓
Vector Search
      ↓
Tenant Filter
      ↓
Permission Filter
      ↓
Classification Filter
      ↓
Reranking
      ↓
Relevant Context
      ↓
LLM
```

The permission filter must happen before the content is provided to the model.

Do not use the LLM to decide whether the user has permission to access a document.

The application/database authorization layer must decide.

---

# 13. Document Ingestion

Support:

```text
PDF
DOCX
XLSX
CSV
TXT
MD
HTML
```

Pipeline:

```text
Upload
 ↓
File size validation
 ↓
MIME/type validation
 ↓
Malware scanning hook
 ↓
Metadata extraction
 ↓
Classification
 ↓
Authorization metadata
 ↓
Text extraction
 ↓
Chunking
 ↓
Embedding
 ↓
Vector storage
 ↓
Audit event
```

Original files should be stored in object storage rather than PostgreSQL.

Use an S3-compatible abstraction.

The implementation should support:

```text
S3-compatible object storage
```

without hard-coding a cloud provider.

---

# 14. Document Permissions

Every document should support authorization metadata such as:

```text
tenant
owner
department
allowed users
allowed groups
classification
```

Retrieval must enforce all applicable restrictions.

Example:

```sql
WHERE tenant_id = ?
AND classification <= allowed_classification
AND user_has_access(...)
```

Do not retrieve unauthorized chunks and filter them afterward.

---

# 15. Chat Experience

Build a polished streaming chat experience.

The user should be able to:

* Create conversations.
* Rename conversations.
* Delete conversations.
* Search conversations.
* Send messages.
* Stop generation.
* Regenerate responses.
* Copy responses.
* Upload documents.
* Ask questions about uploaded documents.
* See citations.
* Select models.
* See errors.
* Retry failed requests.

Use SSE initially.

Example:

```text
POST /api/v1/chat
Accept: text/event-stream
```

---

# 16. Citations

When RAG is used, the model response should include source references.

Example:

```text
According to the purchasing procedure, expedited orders require approval.

Sources:
[1] Purchasing Procedure.pdf — Page 14
[2] Procurement Policy.docx — Section 4.2
```

Sources should be generated from actual retrieved chunks.

Do not allow the model to invent citation metadata.

The backend should maintain source IDs.

---

# 17. Prompt Injection Protection

Treat retrieved documents as untrusted content.

System instructions must have higher priority than:

* User-provided documents
* Retrieved documents
* Web content
* Tool output

Never allow retrieved text to override system security policies.

Example:

```text
SYSTEM SECURITY POLICY
        ↓
APPLICATION POLICY
        ↓
USER REQUEST
        ↓
RETRIEVED CONTENT
        ↓
TOOL OUTPUT
```

The model must never be allowed to change:

* User permissions
* Tenant identity
* Classification
* Security policy
* Tool permissions

---

# 18. Tool Gateway

Create a tool abstraction.

Example:

```typescript
interface AI tool {
  id: string;
  name: string;
  description: string;
  inputSchema: unknown;
  execute(context: ToolExecutionContext, input: unknown): Promise<unknown>;
}
```

The LLM should NEVER receive unrestricted database access.

Architecture:

```text
LLM
 ↓
Tool Gateway
 ↓
Authorization
 ↓
Input Validation
 ↓
Tool
 ↓
Internal API
```

Every tool call must independently verify:

```text
authenticated user
tenant
role
permission
tool permission
input
classification
```

---

# 19. Read-Only First

For internal system integrations, implement read-only tools first.

Example:

```text
SyteLine:
  getItem
  searchItems
  getJob
  getPurchaseOrder
```

Do not initially implement:

```text
delete
cancel
update
approve
```

without an explicit approval mechanism.

For destructive operations:

```text
AI proposes action
      ↓
User confirmation
      ↓
Backend authorization
      ↓
Tool execution
      ↓
Audit event
```

---

# 20. Audit Logging

Create an append-oriented audit event system.

Capture security-relevant events such as:

```text
LOGIN
LOGIN_FAILURE
LOGOUT

DOCUMENT_UPLOAD
DOCUMENT_VIEW
DOCUMENT_DELETE

CONVERSATION_CREATE
CONVERSATION_DELETE

AI_REQUEST
AI_RESPONSE

RAG_RETRIEVAL
TOOL_REQUEST
TOOL_EXECUTION

AUTHORIZATION_DENIED

USER_CREATED
USER_UPDATED

ROLE_CHANGED

MODEL_CHANGED
SYSTEM_CONFIGURATION_CHANGED
```

Each event should include:

```text
event_id
timestamp
user_id
tenant_id
action
resource_type
resource_id
result
request_id
source_ip where appropriate
metadata
```

Be deliberate about storing prompts/responses.

Do not automatically store sensitive content in logs.

---

# 21. Request Correlation

Every request must have a correlation/request ID.

Example:

```text
request_id = UUID
```

Propagate it through:

```text
React
 ↓
Node
 ↓
AI Gateway
 ↓
RAG
 ↓
vLLM
 ↓
Tool Gateway
```

This makes troubleshooting and security investigations possible.

---

# 22. Secrets

Never commit:

```text
API keys
passwords
tokens
private keys
database credentials
model credentials
```

Use environment variables for development.

Design production deployment for a real secrets manager.

Create:

```text
.env.example
```

but NEVER:

```text
.env
```

with real secrets.

---

# 23. Logging

Use structured JSON logging.

Example:

```json
{
  "timestamp": "...",
  "level": "info",
  "requestId": "...",
  "userId": "...",
  "tenantId": "...",
  "event": "AI_REQUEST",
  "model": "internal-model"
}
```

Never log:

* Passwords
* API keys
* Session tokens
* Full CUI documents
* Secrets
* Authorization headers

unless explicitly required by a controlled security/audit design.

---

# 24. Rate Limiting

Implement rate limiting at:

```text
IP
User
Tenant
Endpoint
Model
Tool
```

Especially protect:

```text
/login
/chat
/files
/search
/tools
```

Prevent abuse and accidental resource exhaustion.

---

# 25. File Security

Uploaded files must be treated as untrusted.

Implement:

* Size limits.
* Allowed file types.
* MIME validation.
* Extension validation.
* Malware scanning abstraction.
* Filename normalization.
* Storage outside web root.
* Random storage keys.
* No executable file execution.
* Tenant isolation.

Never use the original filename as a filesystem path.

---

# 26. Containerization

Everything should be containerized.

Create:

```text
Dockerfile
docker-compose.yml
docker-compose.dev.yml
```

Development stack should include:

```text
web
api
postgres
object-storage
vector database/search
```

The model server should be separately configurable because GPU requirements differ.

---

# 27. Health Checks

Every service should have:

```text
/health
/ready
```

Health checks should distinguish:

```text
process alive
```

from:

```text
service ready
```

The API should verify required dependencies.

---

# 28. Error Handling

Do not expose stack traces to users.

Return structured errors:

```json
{
  "error": {
    "code": "AI_MODEL_UNAVAILABLE",
    "message": "The AI service is temporarily unavailable.",
    "requestId": "..."
  }
}
```

Log detailed technical information server-side.

---

# 29. Testing

Create automated tests.

Minimum:

## Unit tests

Test:

* Authorization
* Classification
* Tenant isolation
* RAG filters
* Model routing
* Tool authorization
* Input validation

## Integration tests

Test:

```text
React → API
API → PostgreSQL
API → RAG
API → Model Gateway
API → Tool Gateway
```

## Security tests

Test:

```text
Cross-tenant access
Unauthorized document retrieval
Unauthorized tool execution
Prompt injection
Path traversal
Invalid file uploads
Authentication bypass
Authorization bypass
Rate limiting
```

## End-to-end tests

At minimum:

```text
Create account
Login
Create conversation
Send message
Receive streaming response
Upload document
Ask question about document
Receive citation
Logout
```

---

# 30. Security Testing

Create a test suite specifically for AI security.

Include:

### Prompt Injection

Documents containing:

```text
Ignore all previous instructions.
```

must not override system policies.

### Data Exfiltration

Attempt to make the model retrieve:

```text
another tenant's documents
```

Expected:

```text
authorization denied
```

### Tool Abuse

Attempt:

```text
execute unauthorized tool
```

Expected:

```text
authorization denied
```

### Classification Bypass

Attempt:

```text
send CUI to external model
```

Expected:

```text
blocked
```

---

# 31. External Model Support

Build external model providers as optional adapters.

Architecture:

```text
AI Gateway
   │
   ├── Local Provider
   │      └── vLLM
   │
   ├── Approved External Provider
   │
   └── Test Provider
```

The default provider must be local.

External providers must require an explicit policy allowing them.

Never automatically send proprietary/CUI content to an external provider.

---

# 32. Model Registry

Create a model registry.

Store:

```text
model ID
display name
provider
version
capabilities
classification allowed
enabled
deployment status
model hash
license
approval status
```

The model selector in the UI should only display models the authenticated user is authorized to use.

---

# 33. Configuration

Use typed configuration validation.

Create:

```text
src/config/env.ts
```

Use Zod to validate environment variables at startup.

If required configuration is missing:

```text
FAIL FAST
```

Do not silently use insecure defaults in production.

---

# 34. Development Mode

Make the project easy to start.

Target:

```bash
git clone ...
cp .env.example .env
docker compose up
```

Then:

```text
http://localhost:3000
```

should load the application.

Provide seed data.

Create:

```text
demo organization
demo tenant
demo user
demo conversation
demo documents
```

Do not use real customer data.

---

# 35. Production Mode

Create a production deployment design that supports:

```text
Reverse proxy / WAF
        ↓
React
        ↓
Node API
        ↓
Internal services
        ↓
Database / storage
        ↓
GPU/model network
```

Production configuration must include:

* TLS.
* Secure headers.
* Authentication.
* Authorization.
* Secrets management.
* Database encryption strategy.
* Backups.
* Logging.
* Monitoring.
* Network segmentation.
* Egress controls.
* Vulnerability scanning.
* Container scanning.

---

# 36. No Public AI Data Flow

The default architecture must guarantee:

```text
User
 ↓
Internal React
 ↓
Internal Node API
 ↓
Internal RAG
 ↓
Internal Model
```

No request should leave the organization's infrastructure unless an explicit external-provider policy allows it.

Make external calls observable and auditable.

---

# 37. Documentation

Create:

```text
docs/
  architecture.md
  data-flow.md
  security.md
  threat-model.md
  deployment.md
  development.md
  ai-models.md
  rag.md
  tools.md
  authentication.md
  authorization.md
  incident-response.md
  cmmc-control-mapping.md
```

Document:

* Architecture.
* Data flows.
* Trust boundaries.
* Authentication.
* Authorization.
* RAG.
* Model serving.
* Tool execution.
* Logging.
* Security controls.
* Deployment.
* Disaster recovery.

---

# 38. CMMC Documentation

Create a technical mapping document.

Do not claim compliance.

Instead map implemented technical capabilities to relevant areas of NIST SP 800-171.

For each applicable requirement, document:

```text
Requirement
 ↓
Technical implementation
 ↓
Configuration
 ↓
Evidence
 ↓
Responsible owner
```

Clearly distinguish:

```text
IMPLEMENTED
PARTIALLY IMPLEMENTED
NOT IMPLEMENTED
ORGANIZATIONAL CONTROL
REQUIRES ASSESSMENT
```

Do not fabricate compliance evidence.

---

# 39. Threat Model

Create a threat model covering:

```text
External attacker
Malicious employee
Compromised account
Compromised document
Prompt injection
Model compromise
Tool abuse
Cross-tenant access
Database compromise
Credential theft
Supply-chain attack
Malicious model
Data exfiltration
```

For each:

```text
Threat
 ↓
Attack path
 ↓
Impact
 ↓
Mitigation
 ↓
Detection
 ↓
Response
```

---

# 40. Model Supply Chain

Treat model files as controlled artifacts.

Document:

```text
model source
model version
license
SHA-256 hash
download date
security review
evaluation results
approval status
```

Production models must come from an approved internal artifact repository.

---

# 41. Evaluation Framework

Create an evaluation framework capable of testing:

```text
General knowledge
Company knowledge
RAG accuracy
Citation accuracy
Hallucination
Permission enforcement
Prompt injection
Data leakage
Tool safety
Structured output
Coding
Reasoning
Latency
Token throughput
```

Models should be evaluated before production deployment.

---

# 42. Performance

Measure:

```text
TTFT
tokens/sec
request latency
RAG latency
database latency
embedding latency
GPU utilization
CPU utilization
memory
concurrent users
error rate
```

Create an observability architecture that can eventually integrate with Prometheus/Grafana/OpenTelemetry or an equivalent approved monitoring stack.

---

# 43. AI Cost/Resource Controls

Even with self-hosted models, GPU resources are expensive.

Implement:

* Maximum token limits.
* Request timeouts.
* User rate limits.
* Tenant quotas.
* Model-specific limits.
* Concurrent generation limits.
* Cancellation.
* Queueing where necessary.

Do not allow a single user to consume the entire GPU cluster.

---

# 44. Repository Quality

The resulting repository must be:

* Clean.
* Typed.
* Modular.
* Documented.
* Testable.
* Containerized.
* Production-oriented.

Use:

```text
ESLint
Prettier
TypeScript strict mode
Vitest/Jest
Playwright
```

Do not leave:

```text
TODO
FIXME
placeholder
coming soon
implement later
```

in critical production code.

If a feature is intentionally deferred, document it in:

```text
docs/roadmap.md
```

rather than pretending it is implemented.

---

# 45. Do Not Create Fake Security

Never implement security as UI decoration.

For example, this is NOT acceptable:

```typescript
if (user.role === "ADMIN") {
   // pretend security
}
```

Security must be enforced at the backend/data layer.

Likewise:

```text
Frontend says tenant_id = customer-a
```

must never be considered sufficient authorization.

---

# 46. Implementation Process

Do not generate the entire project as one giant response.

Work incrementally.

First inspect the repository.

Then produce:

```text
1. Architecture
2. Repository structure
3. Database schema
4. API contracts
5. Security model
6. Development environment
7. Implementation
8. Tests
9. Documentation
```

After each major implementation phase:

```text
Run tests
Fix errors
Run lint
Fix errors
Build
Fix errors
Verify startup
```

Do not move on while the current phase is broken.

---

# 47. Coding Rules

Use complete implementations.

Do not give me pseudocode when executable code is required.

Do not omit important code with statements such as:

```text
// implementation omitted
// add your code here
// etc.
```

Do not use fake APIs.

Do not invent package APIs.

Use stable, documented libraries.

If you are uncertain about a library API, inspect its documentation/source before implementing it.

Prefer simple, maintainable architecture over unnecessary abstraction.

---

# 48. Security Decision Rules

When choosing between two implementations:

1. Prefer least privilege.
2. Prefer deny-by-default.
3. Prefer server-side enforcement.
4. Prefer explicit authorization.
5. Prefer auditable operations.
6. Prefer deterministic policy enforcement.
7. Prefer internal data processing.
8. Prefer reversible actions.
9. Prefer immutable audit records.
10. Prefer a smaller attack surface.

---

# 49. Definition of Done

The initial production-ready test release is complete when:

```text
[ ] React application runs
[ ] Node API runs
[ ] PostgreSQL runs
[ ] Authentication works
[ ] Authorization works
[ ] Tenant isolation works
[ ] Chat works
[ ] Streaming works
[ ] Local model provider works
[ ] vLLM integration works
[ ] Conversations persist
[ ] File upload works
[ ] Document parsing works
[ ] Embeddings work
[ ] pgvector retrieval works
[ ] Permission-aware RAG works
[ ] Citations work
[ ] Audit events work
[ ] Tool gateway exists
[ ] Tool authorization works
[ ] Rate limiting works
[ ] Security validation works
[ ] Docker deployment works
[ ] Tests pass
[ ] Lint passes
[ ] TypeScript build passes
[ ] Production build passes
[ ] Documentation exists
[ ] Threat model exists
[ ] CMMC technical mapping exists
[ ] No secrets are committed
[ ] No external AI calls occur by default
```

---

# 50. First Milestone

Do not attempt fine-tuning first.

Build this first:

```text
React
  ↓
Node.js
  ↓
Authentication
  ↓
PostgreSQL
  ↓
AI Gateway
  ↓
vLLM
  ↓
Local Model
```

Get that completely working.

Then implement:

```text
Document Upload
  ↓
Object Storage
  ↓
Embedding
  ↓
pgvector
  ↓
Permission-Aware RAG
  ↓
Citations
```

Then:

```text
Tool Gateway
  ↓
Internal Systems
```

Then:

```text
Model Registry
  ↓
Evaluation
  ↓
Fine-Tuning
```

---

# 51. Important Architectural Principle

The product is not the model.

The product is:

```text
                    PRIVATE AI PLATFORM

                         React UI
                            │
                            ▼
                       Node API
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
          Security/IAM              AI Gateway
                │                       │
                ▼                       ▼
             RAG                  Model Router
                │                       │
                └───────────┬───────────┘
                            ▼
                       Model Server
                            │
                            ▼
                          LLM
```

The model must be replaceable.

The organization should own and control:

* Application
* Security
* Data
* Retrieval
* Integrations
* Tools
* Policies
* Audit system
* Evaluation system
* Model registry
* Infrastructure

This ensures the platform remains useful even when the underlying model changes.

---

# 52. Your Immediate Task

Start by inspecting the existing repository and environment.

Determine:

* Operating system.
* Existing Node version.
* Existing package manager.
* Existing project structure.
* Available Docker installation.
* Available GPU/CUDA environment.
* Existing PostgreSQL availability.
* Existing object storage.
* Existing authentication/SSO infrastructure.
* Existing CI/CD.
* Existing security tooling.

Do not overwrite an existing project without first understanding it.

If this is an empty repository, create the project structure described above.

Then implement **Phase 1: Private Chat MVP**.

Do not stop at a plan.

Create the actual files and working application.

At the end of each implementation phase report:

```text
IMPLEMENTED
TESTED
KNOWN LIMITATIONS
NEXT PHASE
```

The objective is a working, secure foundation that can be deployed into an organization's controlled infrastructure and subsequently hardened/evaluated for its applicable CMMC requirements.
