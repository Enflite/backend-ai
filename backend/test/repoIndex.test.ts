import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeRepoPath } from '../src/repos/search.js';
import { assertLocalPathAllowed, createRepoSchema } from '../src/repos/registry.js';
import { gitEnv, walkRepoFiles, REPO_EMBEDDING_DIMENSIONS } from '../src/repos/indexer.js';
import { listOrgRepos } from '../src/repos/github.js';
import { authorizeTool, getTool } from '../src/tools/gateway.js';
import { buildSystemPrompt } from '../src/chat/systemPrompt.js';
import { AuthContext } from '../src/authz/permissions.js';
import { config } from '../src/config.js';

function authContext(permissions: AuthContext['permissions']): AuthContext {
  return {
    userId: 'user-1',
    email: 'dev@example.com',
    displayName: 'Dev',
    clearance: 'INTERNAL',
    tenantId: 'tenant-1',
    roleId: 'role-1',
    roleName: 'Developer',
    permissions,
    sessionId: 'session-1',
  };
}

describe('normalizeRepoPath', () => {
  it('accepts clean repo-relative paths', () => {
    expect(normalizeRepoPath('backend/src/chat/routes.ts')).toBe('backend/src/chat/routes.ts');
  });
  it('converts backslashes and collapses dot segments', () => {
    expect(normalizeRepoPath('backend\\src\\.\\routes.ts')).toBe('backend/src/routes.ts');
  });
  it('rejects absolute paths', () => {
    expect(() => normalizeRepoPath('/etc/passwd')).toThrowError(/relative/);
  });
  it('rejects parent-directory escapes', () => {
    expect(() => normalizeRepoPath('../secrets.env')).toThrowError(/escape/);
    expect(() => normalizeRepoPath('a/../../b')).toThrowError(/escape/);
  });
  it('rejects empty and overlong paths', () => {
    expect(() => normalizeRepoPath('  ')).toThrowError(/1-500/);
    expect(() => normalizeRepoPath(`a/${'x'.repeat(600)}`)).toThrowError(/1-500/);
  });
});

describe('walkRepoFiles', () => {
  async function fixture(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-walk-'));
    await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(root, 'src', 'nested', 'util.py'), 'def f():\n    pass\n');
    await fs.writeFile(path.join(root, 'README.md'), '# hello\n');
    await fs.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = {};\n');
    await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0x41, 0x42, 0x00, 0x43]));
    return root;
  }

  it('collects text files and skips deps, VCS metadata, and binaries', async () => {
    const root = await fixture();
    try {
      const { files, skipped } = await walkRepoFiles(root);
      const paths = files.map((file) => file.path).sort();
      expect(paths).toEqual(['README.md', 'src/app.ts', 'src/nested/util.py']);
      // node_modules file, .git file, .png (extension), .dat (null byte)
      expect(skipped).toBe(4);
      // Absolute paths never escape the root.
      for (const file of files) {
        expect(path.relative(root, file.absolutePath).startsWith('..')).toBe(false);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('skips symlinks without following them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-walk-link-'));
    try {
      await fs.writeFile(path.join(root, 'real.ts'), 'export const x = 1;\n');
      await fs.symlink(path.join(root, 'real.ts'), path.join(root, 'link.ts'));
      const { files } = await walkRepoFiles(root);
      expect(files.map((file) => file.path)).toEqual(['real.ts']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('createRepoSchema', () => {
  it('requires exactly one of gitUrl or localPath', () => {
    expect(createRepoSchema.safeParse({ name: 'a' }).success).toBe(false);
    expect(
      createRepoSchema.safeParse({ name: 'a', gitUrl: 'https://github.com/Enflite/eCMRs.git', localPath: '/srv/a' }).success
    ).toBe(false);
    expect(createRepoSchema.safeParse({ name: 'eCMRs', gitUrl: 'https://github.com/Enflite/eCMRs.git' }).success).toBe(true);
    expect(createRepoSchema.safeParse({ name: 'local', localPath: '/srv/repos/local' }).success).toBe(true);
  });
  it('rejects unsafe names and non-absolute local paths', () => {
    expect(createRepoSchema.safeParse({ name: '../evil', gitUrl: 'https://github.com/o/r.git' }).success).toBe(false);
    expect(createRepoSchema.safeParse({ name: 'ok', localPath: 'relative/path' }).success).toBe(false);
    expect(createRepoSchema.safeParse({ name: 'ok', gitUrl: 'ftp://example.com/r.git' }).success).toBe(false);
  });
});

describe('repo tool registration and authorization', () => {
  it('registers repo.search and repo.readFile as non-destructive repo:read tools', () => {
    for (const name of ['repo.search', 'repo.readFile']) {
      const tool = getTool(name);
      expect(tool.permission).toBe('repo:read');
      expect(tool.destructive).toBe(false);
      expect(tool.action).toMatch(/^(search|read)$/);
    }
  });

  it('denies repo tools without the repo:read permission', () => {
    const auth = authContext(['chat:create', 'tool:use']);
    try {
      authorizeTool(auth, 'repo.search', { query: 'where is auth?' }, 'INTERNAL', false);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('TOOL_FORBIDDEN');
    }
  });

  it('authorizes repo.search for callers with repo:read', () => {
    const auth = authContext(['chat:create', 'tool:use', 'repo:read']);
    const { definition, input } = authorizeTool(auth, 'repo.search', { query: 'where is auth?' }, 'INTERNAL', false);
    expect(definition.name).toBe('repo.search');
    expect(input).toMatchObject({ query: 'where is auth?', topK: 8 });
  });

  it('validates repo.readFile parameters strictly', () => {
    const auth = authContext(['chat:create', 'tool:use', 'repo:read']);
    try {
      authorizeTool(auth, 'repo.readFile', { repo: 'eCMRs' }, 'INTERNAL', false);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_TOOL_PARAMETERS');
    }
    const { input } = authorizeTool(
      auth,
      'repo.readFile',
      { repo: 'eCMRs', path: 'src/app.ts' },
      'INTERNAL',
      false
    );
    expect(input).toMatchObject({ repo: 'eCMRs', path: 'src/app.ts' });
  });
});

describe('createRepoSchema source validation', () => {
  it('requires exactly one of gitUrl or localPath', () => {
    expect(createRepoSchema.safeParse({ name: 'a' }).success).toBe(false);
    expect(
      createRepoSchema.safeParse({ name: 'a', gitUrl: 'https://github.com/o/r.git', localPath: '/x' }).success
    ).toBe(false);
    expect(createRepoSchema.safeParse({ name: 'a', gitUrl: 'https://github.com/o/r.git' }).success).toBe(true);
    expect(createRepoSchema.safeParse({ name: 'a', localPath: '/srv/code' }).success).toBe(true);
  });
  it('rejects branch names that could become git options or path escapes', () => {
    const base = { name: 'a', gitUrl: 'https://github.com/o/r.git' } as const;
    for (const branch of ['-rm-rf', '--upload-pack=touch', '../escape', '/abs', 'trailing/']) {
      const parsed = createRepoSchema.safeParse({ ...base, defaultBranch: branch });
      expect(parsed.success).toBe(false);
    }
    for (const branch of ['main', 'master', 'feature/my-branch', 'release_2.0']) {
      const parsed = createRepoSchema.safeParse({ ...base, defaultBranch: branch });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('assertLocalPathAllowed', () => {
  const originalRoot = config.REPO_LOCAL_ROOT;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-root-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-outside-'));
    config.REPO_LOCAL_ROOT = root;
  });
  afterEach(async () => {
    config.REPO_LOCAL_ROOT = originalRoot;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('accepts a directory inside the root', async () => {
    const dir = path.join(root, 'myrepo');
    await fs.mkdir(dir);
    await expect(assertLocalPathAllowed(dir)).resolves.toBe(dir);
  });
  it('rejects paths outside the root', async () => {
    await expect(assertLocalPathAllowed(outside)).rejects.toMatchObject({ code: 'REPO_LOCAL_PATH_DENIED' });
    await expect(assertLocalPathAllowed('/etc')).rejects.toMatchObject({ code: 'REPO_LOCAL_PATH_DENIED' });
  });
  it('rejects a symlink inside the root that points outside', async () => {
    const link = path.join(root, 'evil');
    await fs.symlink(outside, link);
    await expect(assertLocalPathAllowed(link)).rejects.toMatchObject({ code: 'REPO_LOCAL_PATH_DENIED' });
  });
  it('rejects missing paths and files', async () => {
    await expect(assertLocalPathAllowed(path.join(root, 'nope'))).rejects.toMatchObject({
      code: 'REPO_LOCAL_PATH_INVALID',
    });
    const file = path.join(root, 'f.txt');
    await fs.writeFile(file, 'x');
    await expect(assertLocalPathAllowed(file)).rejects.toMatchObject({ code: 'REPO_LOCAL_PATH_INVALID' });
  });
});

describe('gitEnv token scoping', () => {
  const originalToken = config.GITHUB_TOKEN;
  const originalAllowlist = config.REPO_GIT_HOST_ALLOWLIST;
  afterEach(() => {
    config.GITHUB_TOKEN = originalToken;
    config.REPO_GIT_HOST_ALLOWLIST = originalAllowlist;
  });

  it('sends the token to GitHub hosts only, never to other allowlist entries', () => {
    config.GITHUB_TOKEN = 'tok123';
    config.REPO_GIT_HOST_ALLOWLIST = 'github.com,evil.example';
    const env = gitEnv();
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe('Authorization: Bearer tok123');
    expect(JSON.stringify(env)).not.toContain('evil.example');
  });
  it('sets no git config when no token is configured', () => {
    config.GITHUB_TOKEN = undefined;
    const env = gitEnv();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });
});

describe('system prompt repo guidance', () => {
  it('tells the model to search the index when repo tools are offered', () => {
    const prompt = buildSystemPrompt({ codingMode: true, repoToolsAvailable: true, toolsAvailable: true });
    expect(prompt).toContain('repo.search');
    expect(prompt).toContain('repo.readFile');
  });
  it('omits repo guidance when repo tools are not offered', () => {
    const prompt = buildSystemPrompt({ codingMode: true, toolsAvailable: true });
    expect(prompt).not.toContain('repo.search');
  });
});

describe('repo embedding dimension pin', () => {
  it('pins the HNSW column dimension to 1536, matching document_chunks', () => {
    expect(REPO_EMBEDDING_DIMENSIONS).toBe(1536);
  });
});

describe('listOrgRepos', () => {
  const originalToken = config.GITHUB_TOKEN;

  function stubFetch(pages: unknown[][] | { status: number }): typeof fetch {
    return (async (url: unknown) => {
      if (!Array.isArray(pages)) {
        return { ok: false, status: pages.status, json: async () => ({}) } as unknown as Response;
      }
      const page = Number(new URL(url as string).searchParams.get('page') ?? '1');
      const body = pages[page - 1] ?? [];
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as typeof fetch;
  }

  function ghRepo(name: string, extra: Record<string, unknown> = {}) {
    return { name, private: false, default_branch: 'main', clone_url: `https://github.com/Enflite/${name}.git`, ...extra };
  }

  it('refuses without a configured token', async () => {
    config.GITHUB_TOKEN = undefined;
    try {
      await expect(listOrgRepos(stubFetch([[]]))).rejects.toMatchObject({ code: 'GITHUB_TOKEN_MISSING' });
    } finally {
      config.GITHUB_TOKEN = originalToken;
    }
  });

  it('follows pagination and normalizes repo metadata', async () => {
    config.GITHUB_TOKEN = 'test-token';
    try {
      const page1 = Array.from({ length: 100 }, (_, i) => ghRepo(`repo-${i}`));
      const page2 = [ghRepo('eCMRs', { private: true, default_branch: 'master' }), ghRepo('ApsDash')];
      const repos = await listOrgRepos(stubFetch([page1, page2]));
      expect(repos).toHaveLength(102);
      expect(repos[100]).toMatchObject({
        name: 'eCMRs',
        private: true,
        defaultBranch: 'master',
        cloneUrl: 'https://github.com/Enflite/eCMRs.git',
      });
    } finally {
      config.GITHUB_TOKEN = originalToken;
    }
  });

  it('skips malformed entries and maps a 401 to a token error', async () => {
    config.GITHUB_TOKEN = 'test-token';
    try {
      const repos = await listOrgRepos(stubFetch([[ghRepo('ok'), { name: 42 }, { clone_url: 'x' }]]));
      expect(repos.map((repo) => repo.name)).toEqual(['ok']);
      await expect(listOrgRepos(stubFetch({ status: 401 }))).rejects.toMatchObject({ code: 'GITHUB_TOKEN_REJECTED' });
    } finally {
      config.GITHUB_TOKEN = originalToken;
    }
  });

  it('sends the token as a Bearer header, never in the URL', async () => {
    config.GITHUB_TOKEN = 'super-secret-token';
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: url as string, auth: init?.headers?.['Authorization'] ?? null });
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }) as typeof fetch;
    try {
      await listOrgRepos(fetchFn);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).not.toContain('super-secret-token');
      expect(seen[0]!.auth).toBe('Bearer super-secret-token');
      expect(seen[0]!.url).toContain('/orgs/Enflite/repos');
    } finally {
      config.GITHUB_TOKEN = originalToken;
    }
  });
});
