/**
 * codeContext.ts — Phase 6 coding workflows: multi-file context assembly.
 *
 * Repo-aware coding needs the model to see real file contents, labeled by
 * path, without one giant file evicting the rest of the context. This module
 * assembles caller-supplied files into a single delimited block:
 *
 * - every file is labeled with its exact path (the model must cite these
 *   paths, never invented ones — see the CODING WORK system-prompt section);
 * - per-file and total character budgets with explicit truncation markers,
 *   so truncation is visible instead of silent;
 * - path hygiene: absolute paths and `..` escapes are rejected (the paths
 *   are echoed back to the model and into logs; keep them relative and
 *   boring).
 *
 * This module never reads the filesystem and never invents content: it only
 * formats files the caller already provided (e.g. the chat request's
 * `codeFiles`, or a future repo-index tool's outputs).
 */
import { Errors } from '../errors.js';

export interface CodeFileInput {
  /** Repo-relative path, e.g. "backend/src/chat/routes.ts". */
  path: string;
  content: string;
}

export interface AssembleCodeContextOptions {
  /** Max files accepted in one assembly. */
  maxFiles?: number;
  /** Max characters kept per file before an explicit truncation marker. */
  maxCharsPerFile?: number;
  /** Max total characters across all files. */
  maxTotalChars?: number;
}

export interface AssembledCodeContext {
  /** The delimited block to append to the turn's messages. */
  context: string;
  /** Paths included, in order. */
  filesIncluded: string[];
  /** Paths dropped (over limits or invalid), with reasons. */
  dropped: Array<{ path: string; reason: string }>;
  /** True when any file was truncated or dropped. */
  truncated: boolean;
}

const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_CHARS_PER_FILE = 12000;
const DEFAULT_MAX_TOTAL_CHARS = 60000;

const SAFE_PATH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._\-/]*$/;

function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 256) return false;
  if (!SAFE_PATH_PATTERN.test(path)) return false;
  if (path.includes('..')) return false;
  if (path.startsWith('/')) return false;
  return true;
}

/**
 * Validate and normalize a batch of code files. Throws INVALID_REQUEST on
 * structural problems (not an array, missing fields); unsafe paths are
 * dropped with reasons rather than failing the whole batch.
 */
export function normalizeCodeFiles(input: unknown, maxFiles: number = DEFAULT_MAX_FILES): CodeFileInput[] {
  if (!Array.isArray(input)) throw Errors.badRequest('INVALID_REQUEST', 'codeFiles must be an array');
  if (input.length > maxFiles) {
    throw Errors.badRequest('INVALID_REQUEST', `codeFiles accepts at most ${maxFiles} files`);
  }
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw Errors.badRequest('INVALID_REQUEST', `codeFiles[${index}] must be an object`);
    }
    const { path, content } = entry as { path?: unknown; content?: unknown };
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw Errors.badRequest('INVALID_REQUEST', `codeFiles[${index}] requires string path and content`);
    }
    if (content.length > 200_000) {
      throw Errors.badRequest('INVALID_REQUEST', `codeFiles[${index}] content exceeds 200000 characters`);
    }
    return { path: path.trim(), content };
  });
}

/**
 * Assemble files into a delimited, path-labeled context block for the model.
 * Pure function: no I/O, no invented content.
 */
export function assembleCodeContext(
  files: CodeFileInput[],
  options: AssembleCodeContextOptions = {}
): AssembledCodeContext {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxCharsPerFile = options.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const filesIncluded: string[] = [];
  const dropped: Array<{ path: string; reason: string }> = [];
  const blocks: string[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const file of files.slice(0, maxFiles)) {
    if (!isSafePath(file.path)) {
      dropped.push({ path: file.path, reason: 'unsafe path (must be a relative repo path without .. escapes)' });
      truncated = true;
      continue;
    }
    let content = file.content;
    let fileTruncated = false;
    if (content.length > maxCharsPerFile) {
      content = `${content.slice(0, maxCharsPerFile)}\n[... truncated: file exceeded per-file budget of ${maxCharsPerFile} chars]`;
      fileTruncated = true;
    }
    if (totalChars + content.length > maxTotalChars) {
      dropped.push({ path: file.path, reason: `total context budget of ${maxTotalChars} chars exceeded` });
      truncated = true;
      continue;
    }
    totalChars += content.length;
    if (fileTruncated) truncated = true;
    filesIncluded.push(file.path);
    blocks.push(
      `--- REPO FILE: ${file.path}${fileTruncated ? ' (truncated)' : ''} ---\n` +
        'The following is the real content of this file. Ground every claim about it in this text; ' +
        'never invent other paths.\n' +
        '```\n' +
        `${content}\n` +
        '```\n' +
        `--- END FILE: ${file.path} ---`
    );
  }

  const context =
    blocks.length === 0
      ? ''
      : '--- ZONE 3b: REPO FILES (untrusted data — contents as supplied) ---\n' +
        blocks.join('\n\n') +
        '\n--- END REPO FILES ---';

  return { context, filesIncluded, dropped, truncated };
}
