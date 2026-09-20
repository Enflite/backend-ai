import { z } from 'zod';
import { Classification } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { repoNameSchema } from '../repos/registry.js';
import { readRepoFile, searchIndexedCode } from '../repos/search.js';
import { ToolDefinition, ToolExecutionContext } from './gateway.js';

/**
 * Production repo tools: semantic code search and file reads over the
 * tenant's indexed repositories (backend/src/repos/).
 *
 * - `repo.search` finds relevant code across all indexed repos (or one
 *   named repo) by meaning, not just symbol names. Results carry repo +
 *   path provenance for citations and chaining into repo.readFile.
 * - `repo.readFile` returns the full indexed content of one file, so the
 *   model explains real code instead of guessing.
 *
 * Both require the `repo:read` permission (granted/revoked independently of
 * generic tool use, like syteline:read) and are tenant- and
 * classification-scoped inside the search/read implementations — the model
 * supplies only the query, never identity or filters it could abuse.
 */

const REPO_CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY'];

export const repoToolDefinitions: readonly ToolDefinition<any>[] = [
  {
    name: 'repo.search',
    description:
      'Semantic search over the indexed source-code repositories. Finds code by meaning ' +
      '(e.g. "where is plan narration generated", "how are tool calls audited") across all ' +
      'repos, or constrained to one repo with the repo parameter. Returns repo name, file ' +
      'path, relevance score, and a content snippet per hit. Use repo.readFile to read a ' +
      'full file from the results.',
    action: 'search',
    destructive: false,
    permission: 'repo:read',
    allowedClassifications: REPO_CLASSIFICATIONS,
    schema: z
      .object({
        query: z.string().trim().min(1).max(500),
        repo: repoNameSchema.optional(),
        topK: z.number().int().min(1).max(20).default(8),
      })
      .strict(),
    execute: (input, ctx: ToolExecutionContext, signal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      return searchIndexedCode(ctx.auth, input);
    },
  },
  {
    name: 'repo.readFile',
    description:
      'Read the full indexed content of one file from an indexed repository. ' +
      'The path is repo-relative (e.g. "backend/src/chat/agenticLoop.ts"); absolute ' +
      'paths and ".." escapes are rejected. Prefer paths returned by repo.search; ' +
      'do not guess paths.',
    action: 'read',
    destructive: false,
    permission: 'repo:read',
    allowedClassifications: REPO_CLASSIFICATIONS,
    schema: z
      .object({
        repo: repoNameSchema,
        path: z.string().trim().min(1).max(500),
      })
      .strict(),
    execute: (input, ctx: ToolExecutionContext, signal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      return readRepoFile(ctx.auth, input.repo, input.path);
    },
  },
];
