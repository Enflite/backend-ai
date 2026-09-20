import { config } from '../config.js';
import { Errors } from '../errors.js';

/**
 * GitHub organization discovery for the repo index ("use all of my existing
 * repos"). Lists the repositories the server's GITHUB_TOKEN can see in
 * GITHUB_ORG so an admin can import them all with one call instead of
 * registering ten repos by hand.
 *
 * Security posture:
 * - The token lives only in server config and travels in an Authorization
 *   header to api.github.com; it is never stored, logged, or returned.
 * - Responses carry repo metadata only (name, visibility, default branch,
 *   clone URL) — nothing secret.
 * - Imported repos go through the same createRepoSchema validation as manual
 *   registration (name shape, https host allowlist), and syncing them still
 *   requires repo:manage.
 */

export interface GitHubOrgRepo {
  name: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

const GITHUB_API_TIMEOUT_MS = 15_000;
const PER_PAGE = 100;

type FetchFn = typeof fetch;

function apiBase(): string {
  return config.GITHUB_API_BASE.replace(/\/+$/, '');
}

/**
 * List every repository visible to GITHUB_TOKEN in GITHUB_ORG (public and
 * private), following pagination. Throws a 502-style internal error when
 * the token is missing or GitHub is unreachable — the admin route maps this
 * to a clean failure, never a token leak.
 */
export async function listOrgRepos(fetchFn: FetchFn = fetch): Promise<GitHubOrgRepo[]> {
  const token = config.GITHUB_TOKEN;
  if (!token) {
    throw Errors.internal(
      'GitHub organization discovery requires GITHUB_TOKEN to be configured',
      undefined,
      'GITHUB_TOKEN_MISSING'
    );
  }
  const org = encodeURIComponent(config.GITHUB_ORG);
  const repos: GitHubOrgRepo[] = [];
  let page = 1;
  for (;;) {
    const url = `${apiBase()}/orgs/${org}/repos?per_page=${PER_PAGE}&page=${page}&type=all&sort=full_name`;
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'enflite-backend-ai',
        },
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      });
    } catch (error) {
      throw Errors.internal(
        'GitHub API unreachable during organization discovery',
        { cause: error instanceof Error ? error.message : String(error) },
        'GITHUB_API_UNREACHABLE'
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw Errors.internal(
        'GitHub token rejected during organization discovery (check scopes: read access to the org)',
        { status: response.status },
        'GITHUB_TOKEN_REJECTED'
      );
    }
    if (!response.ok) {
      throw Errors.internal('GitHub organization discovery failed', { status: response.status }, 'GITHUB_API_ERROR');
    }
    const payload = (await response.json()) as Array<{
      name?: unknown;
      private?: unknown;
      default_branch?: unknown;
      clone_url?: unknown;
    }>;
    if (!Array.isArray(payload)) {
      throw Errors.internal('GitHub API returned an unexpected payload', undefined, 'GITHUB_API_ERROR');
    }
    for (const item of payload) {
      if (typeof item.name !== 'string' || typeof item.clone_url !== 'string') continue;
      repos.push({
        name: item.name,
        private: item.private === true,
        defaultBranch: typeof item.default_branch === 'string' && item.default_branch ? item.default_branch : 'main',
        cloneUrl: item.clone_url,
      });
    }
    if (payload.length < PER_PAGE) break;
    page += 1;
    if (page > 100) break; // sanity cap: 10k repos is not this org
  }
  return repos;
}
