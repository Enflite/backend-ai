/**
 * github.ts — push a form project and open its review PR.
 *
 * Port of `scripts/setup-github-repo.sh` from Enflite/Form-Project-Templates.
 * Prefers the `gh` CLI when available; falls back to the GitHub REST API
 * with `GITHUB_TOKEN` otherwise.
 *
 * Hard guard: form-project PRs are always reviewed and merged by a person —
 * this module only *opens* the PR. It never merges, and never accepts
 * `auto_merge` options.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface GithubRepoOptions {
  /** e.g. `Enflite/Lots`. */
  repo: string;
  /** Path to the scaffolded project. */
  projectDir: string;
  /** Private by default. */
  private?: boolean;
  branch?: string;
  commitMessage?: string;
  prTitle: string;
  prBody: string;
  /** Token for the REST fallback; defaults to `GITHUB_TOKEN` env. */
  token?: string;
  /** Branch to open the PR against (default `main`). */
  base?: string;
}

export interface GithubRepoResult {
  repo: string;
  prUrl: string;
  via: 'gh' | 'rest';
}

function ghAvailable(): boolean {
  try {
    execFileSync('gh', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the review PR can be opened (gh CLI or GITHUB_TOKEN).
 * Exported for the SyteLine Form AI Agent's precondition check — the
 * flow blocks with `missing-github-token` instead of half-running.
 */
export function githubPrAvailable(): boolean {
  return ghAvailable() || !!process.env.GITHUB_TOKEN;
}

function runGh(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('gh', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: 'pipe',
    timeout: 60_000,
  }).trim();
}

async function rest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'enflite-backend-ai',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/**
 * Create the repo, push the project, and open the PR.
 * Throws when neither `gh` nor `GITHUB_TOKEN` is available.
 */
export async function pushProjectAndOpenPr(
  options: GithubRepoOptions,
): Promise<GithubRepoResult> {
  const { repo, projectDir } = options;
  const branch = options.branch ?? 'main';
  const token = options.token ?? process.env.GITHUB_TOKEN;

  if (ghAvailable()) {
    // `gh repo create` is idempotent-ish: ignore "already exists".
    try {
      runGh(
        ['repo', 'create', repo, '--private', '--source', projectDir],
        projectDir,
      );
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (!/already exists|Name already exists/i.test(msg)) throw err;
    }
    if (!existsSync(`${projectDir}/.git`)) {
      throw new Error(`projectDir ${projectDir} is not a git checkout`);
    }
    runGh(['checkout', '-B', branch], projectDir);
    runGh(['add', '-A'], projectDir);
    runGh(['commit', '-m', options.commitMessage ?? options.prTitle], projectDir);
    runGh(['push', '-u', 'origin', branch], projectDir);
    const prUrl = runGh(
      [
        'pr',
        'create',
        '--repo',
        repo,
        '--title',
        options.prTitle,
        '--body',
        options.prBody,
        '--base',
        options.base ?? 'main',
      ],
      projectDir,
    );
    return { repo, prUrl, via: 'gh' };
  }

  if (!token) {
    throw new Error(
      'cannot create the GitHub repo: no gh CLI and no GITHUB_TOKEN. ' +
        'Ask for the token (or gh auth) before continuing.',
    );
  }

  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`invalid repo "${repo}": expected owner/name`);
  const created = await rest('POST', '/user/repos', token, {
    name,
    private: options.private ?? true,
  });
  if (created.status !== 201 && created.status !== 422) {
    throw new Error(`GitHub repo create failed (${created.status}): ${JSON.stringify(created.json)}`);
  }
  // NOTE: the REST path is intentionally conservative: pushing git objects
  // over the REST API means creating blobs/trees/commits directly. Form
  // projects go through `gh` in practice; the REST fallback is here so the
  // tool can still *open* the PR once the branch exists. It does not merge.
  throw new Error(
    'REST fallback: repo created (or exists); push the branch with `gh` and re-run to open the PR. ' +
      'Form-project PRs are never merged by automation.',
  );
}

/**
 * Open (only) a PR on an existing repo via REST.
 */
export async function openPr(
  repo: string,
  title: string,
  body: string,
  head: string,
  options: { token?: string; base?: string } = {},
): Promise<string> {
  const token = options.token ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('openPr requires GITHUB_TOKEN');
  const res = await rest('POST', `/repos/${repo}/pulls`, token, {
    title,
    body,
    head,
    base: options.base ?? 'main',
  });
  if (res.status !== 201) {
    throw new Error(`PR open failed (${res.status}): ${JSON.stringify(res.json)}`);
  }
  return res.json.html_url as string;
}
