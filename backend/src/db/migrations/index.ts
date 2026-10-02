/**
 * MongoDB migration registry (ADR-014).
 *
 * Ordered list of migrations consumed by `runMigrations()` in
 * `backend/src/db/migrate.ts`. The runner also sorts by `version` and skips
 * already-applied versions (tracked in the `schema_migrations` collection),
 * so this order is the source of truth and the sort is belt-and-braces.
 *
 * Ported from the 27-file SQL history:
 *  - 001_init          → 001_init, 002_seed, 004 (document:classify grant),
 *                         006, 009, 010, 011, 012, 019, 022, 026 (repo grants),
 *                         027 (memory grants)
 *  - 002_platform      → 001 (conversations/messages/models/audit DDL),
 *                         002_seed (APPROVED model), 003 (model_access),
 *                         007, 015, 017, 021 (legal_hold), 024, 025
 *  - 003_documents_rag → 003 (documents DDL), 004, 005, 008, 014, 018
 *  - 004_eval_oidc     → 016, 020, 023
 *  - 005_repos_memory  → 021 (retention_policies), 026, 027
 *
 * 006_learning_flywheel is new (ADR-015): not a port — feedback,
 * finetune_datasets and finetune_jobs collections plus the
 * feedback:submit / feedback:curate / finetune:manage permission seeds.
 *
 * Atlas Vector Search indexes (document_chunks.embedding,
 * repo_code_chunks.embedding) are NOT created here — the MongoDB driver
 * cannot provision them. See backend/src/db/createVectorIndexes.ts.
 */

import type { Migration } from '../migrate.js';
import { migration001 } from './001_init.js';
import { migration002 } from './002_platform.js';
import { migration003 } from './003_documents_rag.js';
import { migration004 } from './004_eval_oidc.js';
import { migration005 } from './005_repos_memory.js';
import { migration006 } from './006_learning_flywheel.js';
import { migration028 } from './028_ollama_primary_seed.js';
import { migration029 } from './029_model_default_open.js';
import { migration030 } from './030_syteline_forms_permission.js';
import { migration031 } from './031_syteline_ui_permission.js';
import { migration032 } from './032_syteline_tasks.js';
import { migration033 } from './033_flows_permissions.js';
import { migration034 } from './034_all_permissions_all_roles.js';

export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration028,
  migration029,
  migration030,
  migration031,
  migration032,
  migration033,
  migration034,
];
