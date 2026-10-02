/**
 * projectPaths.ts — confine form-project paths under
 * SYTELINE_FORM_PROJECTS_DIR.
 *
 * Shared by the `syteline.form_*` tools and the SyteLine Form AI Agent:
 * every project path (project folders, inbox folders) resolves under the
 * configured root; absolute paths and `..` escapes are rejected.
 */

import { basename, join, relative, resolve, sep } from 'node:path';
import { config } from '../../config.js';
import { Errors } from '../../errors.js';

/** Absolute root every form-project path lives under. */
export function formProjectsRoot(): string {
  return resolve(config.SYTELINE_FORM_PROJECTS_DIR ?? join(process.cwd(), 'form-projects'));
}

/** Confine a project folder (single name) under the projects root. */
export function projectDirOrThrow(relativeProjectDir: string): string {
  const root = formProjectsRoot();
  const dir = resolve(root, relativeProjectDir);
  const rel = relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== dir) {
    throw Errors.badRequest('INVALID_PROJECT_DIR', 'projectDir must stay under the form-projects root');
  }
  if (dir !== resolve(root, basename(relativeProjectDir))) {
    throw Errors.badRequest('INVALID_PROJECT_DIR', 'projectDir must be a single folder name');
  }
  return dir;
}

/**
 * Resolve path segments under the projects root, refusing `..` escapes.
 * For nested agent folders such as `.inbox/<runId>`.
 */
export function projectsSubdirOrThrow(...segments: string[]): string {
  const root = formProjectsRoot();
  const dir = resolve(root, ...segments);
  const rel = relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== dir) {
    throw Errors.badRequest('INVALID_PROJECT_DIR', 'path must stay under the form-projects root');
  }
  return dir;
}
