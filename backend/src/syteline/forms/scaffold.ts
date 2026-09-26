/**
 * scaffold.ts — new form-project scaffolding.
 *
 * TypeScript port of `scripts/new-project.sh` from
 * Enflite/Form-Project-Templates:
 *
 *   new-project.sh <FormName> "<Short title>" <target dir> [<GitHub repo name>]
 *
 * Copies `project-template/` to the target dir, fills in `{{FORM}}`,
 * `{{TITLE}}`, `{{REPO}}`, `{{REPO_LOWER}}`, `{{DATE}}` in text files
 * (never in `project-template/AGENTS.md`, which stays identical in every
 * repo), and copies the Enflite logo + deck icons into `plan/`.
 *
 * Refusal rules (mirroring the shell script):
 * - A target dir that already holds project files (anything besides
 *   `.git`, `README.md`, `LICENSE`, `.gitignore`, `original/`) is refused.
 * - An `original/` dir holding non-`.xml` files is refused.
 * - `FormName` must be letters, digits or `_` (as in SyteLine).
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface ScaffoldInput {
  formName: string;
  /** Short title, e.g. `Create Test Field In Purple`. */
  title: string;
  /** GitHub repo name; defaults to the form name. */
  repo?: string;
  /** Target directory for the new project. */
  destDir: string;
  /** Template source: the Form-Project-Templates checkout (has `project-template/` + `branding/`). */
  templateDir: string;
  /** Defaults to today. */
  date?: string;
}

const TEXT_EXTENSIONS = new Set(['.md', '.py', '.js', '.json']);

function escapeReplacement(s: string): string {
  return s.replace(/[\\&|]/g, '\\$&');
}

function listTextFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'AGENTS.md') continue; // stays identical in every repo
    if (statSync(full).isDirectory()) {
      listTextFiles(full, out);
    } else if (TEXT_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
}

export function scaffoldProject(input: ScaffoldInput): string[] {
  const { formName, title, destDir, templateDir } = input;
  const repo = input.repo ?? formName;
  const date = input.date ?? new Date().toISOString().slice(0, 10);

  if (!/^[A-Za-z0-9_]+$/.test(formName)) {
    throw new Error(`FormName must be letters, digits or _ (as in SyteLine): ${formName}`);
  }

  if (existsSync(destDir)) {
    const allowed = new Set(['.git', 'README.md', 'LICENSE', '.gitignore', 'original']);
    const unexpected = readdirSync(destDir).filter((e) => !allowed.has(e));
    if (unexpected.length > 0) {
      throw new Error(
        `${destDir} already has project files (${unexpected.join(', ')}); refusing to overwrite`,
      );
    }
  }
  const originalDir = join(destDir, 'original');
  if (existsSync(originalDir)) {
    const nonXml = readdirSync(originalDir).filter((e) => !e.endsWith('.xml'));
    if (nonXml.length > 0) {
      throw new Error(
        `${originalDir} holds files other than .xml exports; refusing to overwrite`,
      );
    }
  }

  const templateRoot = join(templateDir, 'project-template');
  if (!existsSync(join(templateRoot, 'AGENTS.md'))) {
    throw new Error(`templateDir ${templateDir} has no project-template/AGENTS.md`);
  }

  mkdirSync(destDir, { recursive: true });
  cpSync(templateRoot + '/', destDir + '/', { recursive: true });

  mkdirSync(join(destDir, 'plan', 'brand'), { recursive: true });
  mkdirSync(join(destDir, 'plan', 'icons'), { recursive: true });
  const branding = join(templateDir, 'branding');
  for (const logo of ['enflite-logo-original.jpg', 'enflite-logo.png']) {
    const src = join(branding, 'assets', logo);
    if (existsSync(src)) copyFileSync(src, join(destDir, 'plan', 'brand', logo));
  }
  const iconsDir = join(branding, 'icons');
  if (existsSync(iconsDir)) {
    for (const entry of readdirSync(iconsDir)) {
      if (entry.endsWith('.png') || entry === 'README.md') {
        copyFileSync(join(iconsDir, entry), join(destDir, 'plan', 'icons', entry));
      }
    }
  }

  const repoLower = repo.toLowerCase();
  const replacements: Array<[RegExp, string]> = [
    [/\{\{FORM\}\}/g, escapeReplacement(formName)],
    [/\{\{TITLE\}\}/g, escapeReplacement(title)],
    [/\{\{REPO_LOWER\}\}/g, escapeReplacement(repoLower)],
    [/\{\{REPO\}\}/g, escapeReplacement(repo)],
    [/\{\{DATE\}\}/g, escapeReplacement(date)],
  ];
  const created: string[] = [];
  for (const file of listTextFiles(destDir)) {
    let text = readFileSync(file, 'utf8');
    for (const [pattern, replacement] of replacements) {
      text = text.replace(pattern, replacement);
    }
    writeFileSync(file, text);
    created.push(file.slice(destDir.length + 1));
  }

  // Warn on unreplaced placeholders (the shell script does the same).
  const leftover: string[] = [];
  for (const file of listTextFiles(destDir)) {
    if (/\{\{/.test(readFileSync(file, 'utf8'))) leftover.push(basename(file));
  }
  if (leftover.length > 0) {
    throw new Error(`unreplaced {{...}} placeholders in: ${leftover.join(', ')}`);
  }

  return created.sort();
}
