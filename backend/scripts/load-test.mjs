#!/usr/bin/env node
/**
 * load-test.mjs — stdlib-only load-test harness for the Enflite backend.
 *
 * Spins up a mock OpenAI-compatible chat provider and a mock SyteLine API
 * (both in-process HTTP servers), boots the real backend server against them,
 * provisions a dev user + an ACTIVE mock model via the public API, then runs
 * load scenarios and reports latency/error statistics.
 *
 * No k6, no npm dependencies beyond what `npm install` already provides
 * (tsx is used to run the TypeScript server and helpers).
 *
 * ---------------------------------------------------------------------------
 * STATED SLOS (see also docs/load-testing.md)
 * ---------------------------------------------------------------------------
 * - p95 time-to-first-token < 2000ms on the mock provider
 *     (mock TTFB is ~120ms; this SLO guards server-side queuing/regression,
 *     not provider speed — real providers are 5-50x slower)
 * - 0% HTTP 5xx under burst load (overload must surface as 429, never 500)
 * - HTTP 429s are graceful, not failures: they carry Retry-After and are
 *     reported separately from errors
 * - /ready reports per-dependency status; /metrics exposes RED series
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node scripts/load-test.mjs --scenario smoke            # ~30s, CI-safe
 *   node scripts/load-test.mjs --scenario steady --rps 5 --duration-sec 60
 *   node scripts/load-test.mjs --scenario burst --concurrency 20 --waves 3
 *   node scripts/load-test.mjs --scenario tools --concurrency 10 --total 100
 *   node scripts/load-test.mjs --scenario all
 *
 *   Point at an already-running server (skips boot + provisioning):
 *   node scripts/load-test.mjs --scenario smoke --base-url http://localhost:8080 --skip-setup
 *     (requires LOADTEST_TOKEN for an admin-capable session)
 *
 * ---------------------------------------------------------------------------
 * ENVIRONMENT
 * ---------------------------------------------------------------------------
 *   DATABASE_URL        Postgres to test against (must be migrated).
 *                       Default: postgres://postgres:postgres@localhost:5432/ai_test
 *   JWT_SECRET          Backend JWT secret (>= 32 chars).
 *                       Default: a fixed dev-only secret (never production).
 *   LOADTEST_EMAIL      Dev user to create/reuse. Default: loadtest@example.com
 *   LOADTEST_PASSWORD   Password for create-user (else a random one is generated).
 *   LOADTEST_TOKEN      Bearer token when --skip-setup is used.
 *   LOADTEST_PORT       Backend port. Default: 18080
 *
 * EXIT CODE: 0 when every SLO passes, 1 otherwise.
 */
import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');

const {
  values: ARGS,
} = parseArgs({
  options: {
    scenario: { type: 'string', default: 'smoke' },
    'duration-sec': { type: 'string', default: '20' },
    rps: { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '10' },
    waves: { type: 'string', default: '2' },
    total: { type: 'string', default: '50' },
    'base-url': { type: 'string' },
    'skip-setup': { type: 'boolean', default: false },
    'mock-ttfb-ms': { type: 'string', default: '120' },
    'slo-ttfb-p95-ms': { type: 'string', default: '2000' },
  },
});

const SCENARIO = ARGS.scenario;
const DURATION_SEC = Number(ARGS['duration-sec']);
const RPS = Number(ARGS.rps);
const CONCURRENCY = Number(ARGS.concurrency);
const WAVES = Number(ARGS.waves);
const TOTAL = Number(ARGS.total);
const MOCK_TTFB_MS = Number(ARGS['mock-ttfb-ms']);
const SLO_TTFB_P95_MS = Number(ARGS['slo-ttfb-p95-ms']);
const LOADTEST_PORT = Number(process.env.LOADTEST_PORT ?? '18080');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_test';
const JWT_SECRET = process.env.JWT_SECRET ?? 'loadtest-dev-secret-please-rotate-32-chars';
const EMAIL = process.env.LOADTEST_EMAIL ?? 'loadtest@example.com';
const PASSWORD = process.env.LOADTEST_PASSWORD ?? randomBytes(16).toString('hex');

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// HTTP helpers (global fetch is stdlib in Node >= 18)
// ---------------------------------------------------------------------------

async function api(base, p, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON bodies (e.g. 404 HTML) are fine
  }
  return { status: res.status, json, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Mock provider: OpenAI-compatible SSE chat completions
// ---------------------------------------------------------------------------

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * In-process mock of an OpenAI-compatible /v1/chat/completions endpoint.
 * Streams a short canned answer: first content token after `ttfbMs`, then a
 * few more chunks, then usage + [DONE]. If the user message contains
 * "LOADTEST_FAIL" it returns 500 instead (error-path testing).
 */
function startMockProvider({ ttfbMs }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch { /* ignore */ }
        const text = JSON.stringify(body.messages ?? []);
        if (text.includes('LOADTEST_FAIL')) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'mock provider failure' }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunks = ['Hello', ' from', ' the', ' mock', ' provider', '!'];
        const send = (i) => {
          if (i >= chunks.length) {
            res.write(
              sseChunk({ usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 } })
            );
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write(
            sseChunk({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }] })
          );
          setTimeout(() => send(i + 1), 25);
        };
        setTimeout(() => send(0), ttfbMs);
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

/** Minimal mock of the SyteLine GET /api/items endpoint used by syteline.getItem. */
function startMockSyteLine() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          item: url.searchParams.get('item'),
          site: url.searchParams.get('site'),
          description: 'Mock widget',
          quantityOnHand: 42,
        })
      );
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Backend server lifecycle
// ---------------------------------------------------------------------------

function spawnBackend({ mockBase, sytelineBase, port }) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DATABASE_URL,
    JWT_SECRET,
    DEV_AUTH_ENABLED: 'true',
    // The model endpoint below is `${mockBase}/v1`; the allowlist compares
    // URL origins, so only the mock's origin goes here (no path).
    AI_PROVIDER_ALLOWED_ORIGINS: mockBase,
    // Throughput knobs for the load run (documented in docs/load-testing.md):
    // the per-minute chat rate limit is raised so the steady scenario measures
    // server throughput, while the per-user/per-tenant concurrency caps stay
    // at defaults so the burst scenario still exercises graceful 429s.
    CHAT_RATE_LIMIT_PER_MIN: '1000',
    TOOL_RATE_LIMIT_PER_MIN: '5000',
    SYTELINE_BASE_URL: sytelineBase,
    SYTELINE_API_TOKEN: 'loadtest-token',
    CORS_ORIGIN: 'http://localhost:8443',
  };
  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so shutdown() can SIGTERM the whole tree: `npx`
    // does not reliably forward signals to the tsx/node child, which would
    // otherwise survive as an orphan and squat the port on the next run.
    detached: true,
  });
  child.stdout.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[backend:err] ${d}`));
  return child;
}

async function waitForHealth(base, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`backend did not become healthy at ${base}/health`);
    await sleep(500);
  }
}

/** Fail fast when something already answers on the backend port (stale server). */
async function assertPortFree(base) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok || res.status === 404) {
      throw new Error(
        `port is already in use: ${base} answers HTTP ${res.status}. Stop the stale server first.`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('port is already in use')) throw error;
    // Connection refused / timeout: port is free.
  }
}

// ---------------------------------------------------------------------------
// Provisioning: dev user -> login -> ACTIVE mock model -> serving default
// ---------------------------------------------------------------------------

function ensureUser() {
  log('provisioning dev user', EMAIL);
  const result = spawnSync(
    'npx',
    ['tsx', 'scripts/create-user.ts', '--email', EMAIL, '--role', 'Admin', '--clearance', 'INTERNAL'],
    { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL, JWT_SECRET, BACKEND_CREATE_USER_PASSWORD: PASSWORD }, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`create-user failed: ${result.stderr || result.stdout}`);
  }
}

async function devLogin(base) {
  const { status, json } = await api(base, '/api/v1/auth/dev-login', {
    method: 'POST',
    body: { email: EMAIL },
  });
  if (status !== 200 || !json?.accessToken) {
    throw new Error(`dev-login failed: ${status} ${JSON.stringify(json)}`);
  }
  return { token: json.accessToken, tenantId: json.tenant.id, roleId: json.user.roleId, userId: json.user.userId };
}

const LIFECYCLE_PATH = [
  'DOWNLOADING',
  'VALIDATING',
  'EVALUATING',
  'PENDING_APPROVAL',
  'APPROVED',
  'ACTIVE',
];

/** Grant the role access to the model via a tiny tsx helper (no admin route exists for model_access). */
function grantModelAccess(modelId, tenantId, roleId) {
  const helperPath = path.join(BACKEND_DIR, '.loadtest-grant-access.mts');
  const code = `import { query, pool } from './src/db/pool.js';
async function main() {
  const [modelId, tenantId, roleId] = process.argv.slice(2);
  await query(
    'INSERT INTO model_access (tenant_id, model_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [tenantId, modelId, roleId]
  );
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
`;
  try {
    writeFileSync(helperPath, code);
    const result = spawnSync('npx', ['tsx', helperPath, modelId, tenantId, roleId], {
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL, JWT_SECRET },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`grantModelAccess failed: ${result.stderr || result.stdout}`);
    }
  } finally {
    try { unlinkSync(helperPath); } catch { /* ignore */ }
  }
}

async function ensureModel(base, token, mockBase, login) {
  // Fresh model per run: the mock provider gets a new random port each run,
  // and model endpoints are immutable after registration, so a reused model
  // would point at a dead mock. Stale loadtest models are inert (only the
  // serving default routes traffic) and safe to leave in a test database.
  const modelBody = {
    name: `loadtest-mock-${process.pid}-${Date.now()}`,
    version: '1.0',
    provider: 'openai-compatible',
    endpoint: `${mockBase}/v1`,
    modelIdentifier: 'mock-model',
    contextWindow: 8192,
    capabilities: { chat: true, streaming: true },
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
  };
  let modelId;
  const created = await api(base, '/api/v1/admin/models', { method: 'POST', body: modelBody, token });
  if (created.status === 201) {
    modelId = created.json.model.id;
    log('registered mock model', modelId);
  } else if (created.status === 400 || created.status === 409) {
    // Reuse an existing loadtest-mock model from a previous run.
    const listed = await api(base, '/api/v1/admin/models', { token });
    modelId = listed.json.models.find((m) => m.name === 'loadtest-mock')?.id;
    if (!modelId) throw new Error(`model register failed: ${created.status} ${JSON.stringify(created.json)}`);
    log('reusing existing mock model', modelId);
  } else {
    throw new Error(`model register failed: ${created.status} ${JSON.stringify(created.json)}`);
  }

  // Walk the lifecycle to ACTIVE (idempotent: skip states already passed).
  // PENDING_APPROVAL -> APPROVED requires the eval promotion gate, so run the
  // scripted 16-case seed suite (provider recorded as 'mock' on the run row —
  // honest test scaffolding, never mistaken for live validation).
  const current = (await api(base, '/api/v1/admin/models', { token })).json.models.find(
    (m) => m.id === modelId
  );
  let idx = LIFECYCLE_PATH.indexOf(current.status);
  for (let i = Math.max(0, idx); i < LIFECYCLE_PATH.length; i++) {
    const target = LIFECYCLE_PATH[i];
    if (current.status === target) continue;
    if (target === 'APPROVED') {
      log('running seed eval suite for the promotion gate...');
      const evalRun = await api(base, '/api/v1/admin/eval/runs', {
        method: 'POST',
        body: { modelId, seed: true },
        token,
      });
      if (evalRun.status !== 200) {
        throw new Error(`seed eval failed: ${evalRun.status} ${JSON.stringify(evalRun.json)}`);
      }
      log(`seed eval done: ${evalRun.json.summary.passed}/${evalRun.json.summary.total} passed`);
    }
    const t = await api(base, `/api/v1/admin/models/${modelId}/transition`, {
      method: 'POST',
      body: { status: target },
      token,
    });
    if (t.status !== 200) throw new Error(`transition to ${target} failed: ${t.status} ${JSON.stringify(t.json)}`);
    log(`model -> ${target}`);
  }

  const def = await api(base, '/api/v1/admin/serving-defaults/chat', {
    method: 'PUT',
    body: { modelId },
    token,
  });
  if (def.status !== 200) throw new Error(`serving default failed: ${def.status} ${JSON.stringify(def.json)}`);
  log('serving default chat ->', modelId);

  grantModelAccess(modelId, login.tenantId, login.roleId);
  log('granted model access to role');
  return modelId;
}

// ---------------------------------------------------------------------------
// Chat SSE client
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/chat and parse the SSE stream.
 * Returns { outcome, httpStatus, ttfbMs, latencyMs, errorCode? }.
 * outcome: 'ok' | 'error_event' | 'http_error' | 'rate_limited' | 'exception'
 */
async function chatRequest(base, token, content) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${base}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    });
  } catch (error) {
    return { outcome: 'exception', latencyMs: performance.now() - started, detail: String(error) };
  }
  if (res.status === 429) {
    await res.text().catch(() => '');
    return { outcome: 'rate_limited', httpStatus: 429, latencyMs: performance.now() - started };
  }
  if (!res.ok || !res.body) {
    await res.text().catch(() => '');
    return {
      outcome: 'http_error',
      httpStatus: res.status,
      latencyMs: performance.now() - started,
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ttfbMs = null;
  let errorCode = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        const event = eventLine ? eventLine.slice(6).trim() : '';
        let data = null;
        try {
          data = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
        } catch { /* ignore */ }
        if (event === 'delta' && ttfbMs === null) ttfbMs = performance.now() - started;
        if (event === 'error') errorCode = data?.code ?? 'UNKNOWN';
        if (event === 'done' || event === 'error') {
          reader.cancel().catch(() => '');
          const latencyMs = performance.now() - started;
          return {
            outcome: event === 'done' ? 'ok' : 'error_event',
            httpStatus: 200,
            ttfbMs,
            latencyMs,
            errorCode,
          };
        }
      }
    }
  } catch (error) {
    return { outcome: 'exception', latencyMs: performance.now() - started, detail: String(error) };
  }
  return { outcome: 'exception', latencyMs: performance.now() - started, detail: 'stream ended without done/error' };
}

async function toolRequest(base, token) {
  const started = performance.now();
  try {
    const { status } = await api(base, '/api/v1/tools/syteline.getItem/execute', {
      method: 'POST',
      body: { parameters: { item: 'WIDGET-1', site: 'MPLS' }, classification: 'INTERNAL' },
      token,
    });
    const latencyMs = performance.now() - started;
    if (status === 429) return { outcome: 'rate_limited', httpStatus: 429, latencyMs };
    if (status >= 500) return { outcome: 'http_error', httpStatus: status, latencyMs };
    if (status !== 200) return { outcome: 'http_error', httpStatus: status, latencyMs };
    return { outcome: 'ok', httpStatus: 200, latencyMs };
  } catch (error) {
    return { outcome: 'exception', latencyMs: performance.now() - started, detail: String(error) };
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(name, samples) {
  const ttfbs = samples.filter((s) => s.ttfbMs != null).map((s) => s.ttfbMs).sort((a, b) => a - b);
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const byOutcome = {};
  for (const s of samples) byOutcome[s.outcome] = (byOutcome[s.outcome] ?? 0) + 1;
  const errors5xx = samples.filter((s) => s.httpStatus >= 500).length;
  const rateLimited = byOutcome.rate_limited ?? 0;
  const failed = samples.filter((s) => s.outcome === 'http_error' || s.outcome === 'exception' || s.outcome === 'error_event').length;
  return {
    name,
    total: samples.length,
    p50TtfbMs: percentile(ttfbs, 50),
    p95TtfbMs: percentile(ttfbs, 95),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: latencies[latencies.length - 1] ?? null,
    byOutcome,
    errors5xx,
    rateLimited,
    failed,
    errorRate: samples.length ? failed / samples.length : 0,
    rate429: samples.length ? rateLimited / samples.length : 0,
  };
}

function printSummary(s) {
  const f = (v) => (v == null ? 'n/a' : `${v.toFixed(1)}ms`);
  console.log(`\n--- ${s.name} ---`);
  console.log(`  requests:        ${s.total}`);
  console.log(`  p50 TTFB:        ${f(s.p50TtfbMs)}`);
  console.log(`  p95 TTFB:        ${f(s.p95TtfbMs)}`);
  console.log(`  p50 latency:     ${f(s.p50LatencyMs)}`);
  console.log(`  p95 latency:     ${f(s.p95LatencyMs)}`);
  console.log(`  max latency:     ${f(s.maxLatencyMs)}`);
  console.log(`  outcomes:        ${JSON.stringify(s.byOutcome)}`);
  console.log(`  5xx errors:      ${s.errors5xx} (${(s.errorRate * 100).toFixed(2)}% failure rate)`);
  console.log(`  429 graceful:    ${s.rateLimited} (${(s.rate429 * 100).toFixed(2)}%)`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioSteadyChat(base, token, { rps, durationSec }) {
  log(`steady chat: ${rps} rps for ${durationSec}s`);
  const samples = [];
  const intervalMs = 1000 / rps;
  const deadline = Date.now() + durationSec * 1000;
  let n = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const pending = new Set();
  while (Date.now() < deadline) {
    const tick = Date.now();
    n += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const p = chatRequest(base, token, `steady load message ${n}`).then((s) => {
      inFlight -= 1;
      samples.push(s);
      pending.delete(p);
    });
    pending.add(p);
    const elapsed = Date.now() - tick;
    if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
  }
  await Promise.all([...pending]);
  log(`steady chat done: ${samples.length} samples, max in-flight ${maxInFlight}`);
  return { summary: summarize('steady chat', samples), maxInFlight };
}

async function scenarioBurstChat(base, token, { concurrency, waves }) {
  log(`burst chat: ${waves} waves of ${concurrency} concurrent`);
  const samples = [];
  let maxInFlight = 0;
  for (let w = 0; w < waves; w++) {
    let inFlight = 0;
    const batch = Array.from({ length: concurrency }, (_, i) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return chatRequest(base, token, `burst wave ${w} message ${i}`).then((s) => {
        inFlight -= 1;
        samples.push(s);
      });
    });
    await Promise.all(batch);
    log(`wave ${w + 1}/${waves} complete`);
    await sleep(1000);
  }
  return { summary: summarize('burst chat', samples), maxInFlight };
}

async function scenarioTools(base, token, { concurrency, total }) {
  log(`concurrent tools: ${total} executions at ${concurrency} concurrency`);
  const samples = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;
  async function worker() {
    for (;;) {
      const i = started++;
      if (i >= total) return;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const s = await toolRequest(base, token);
      inFlight -= 1;
      samples.push(s);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { summary: summarize('concurrent tool calls', samples), maxInFlight };
}

async function checkObservability(base) {
  const metricsRes = await fetch(`${base}/metrics`);
  const metricsText = await metricsRes.text().catch(() => '');
  const ready = await api(base, '/ready');
  const hasSeries =
    metricsRes.status === 200 &&
    metricsText.includes('http_requests_total') &&
    metricsText.includes('chat_turns_total');
  log(`observability: /metrics=${metricsRes.status} hasSeries=${hasSeries} /ready=${ready.status}`);
  return { metricsOk: hasSeries, ready: ready.json };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!['smoke', 'steady', 'burst', 'tools', 'all'].includes(SCENARIO)) {
    console.error(`unknown scenario: ${SCENARIO}`);
    process.exit(2);
  }
  // Smoke defaults: ~30s of load, small scale, CI-safe.
  const smoke = SCENARIO === 'smoke';
  const steadyCfg = smoke ? { rps: 2, durationSec: 20 } : { rps: RPS, durationSec: DURATION_SEC };
  const burstCfg = smoke ? { concurrency: 8, waves: 1 } : { concurrency: CONCURRENCY, waves: WAVES };
  const toolsCfg = smoke ? { concurrency: 5, total: 20 } : { concurrency: CONCURRENCY, total: TOTAL };

  let base = ARGS['base-url'];
  let token = process.env.LOADTEST_TOKEN;
  const children = [];
  const servers = [];

  const shutdown = () => {
    for (const s of servers) s.close();
    for (const c of children) {
      try {
        // Negative pid = whole process group (see spawnBackend: detached).
        process.kill(-c.pid, 'SIGTERM');
      } catch { /* already dead */ }
    }
  };
  process.on('SIGINT', () => { shutdown(); process.exit(130); });

  try {
    if (!base) {
      const mock = await startMockProvider({ ttfbMs: MOCK_TTFB_MS });
      servers.push(mock.server);
      log('mock provider at', mock.base);
      const syteline = await startMockSyteLine();
      servers.push(syteline.server);
      log('mock syteline at', syteline.base);

      base = `http://127.0.0.1:${LOADTEST_PORT}`;
      await assertPortFree(base);
      const child = spawnBackend({ mockBase: mock.base, sytelineBase: syteline.base, port: LOADTEST_PORT });
      children.push(child);
      log('waiting for backend health...');
      await waitForHealth(base);
      log('backend healthy');

      if (!ARGS['skip-setup']) {
        ensureUser();
        const login = await devLogin(base);
        token = login.token;
        await ensureModel(base, token, mock.base, login);
      } else if (!token) {
        throw new Error('--skip-setup requires LOADTEST_TOKEN');
      }
    } else if (!token && !ARGS['skip-setup']) {
      throw new Error('--base-url without --skip-setup still needs provisioning; pass --skip-setup with LOADTEST_TOKEN');
    }

    // Sanity: a single chat round-trip before the load scenarios.
    const probe = await chatRequest(base, token, 'loadtest warmup');
    log('warmup chat:', probe.outcome, `ttfb=${probe.ttfbMs?.toFixed(0)}ms`, `latency=${probe.latencyMs.toFixed(0)}ms`);
    if (probe.outcome !== 'ok') {
      throw new Error(`warmup chat failed: ${JSON.stringify(probe)}`);
    }

    const obs = await checkObservability(base);

    const results = [];
    const runSteady = smoke || SCENARIO === 'steady' || SCENARIO === 'all';
    const runBurst = smoke || SCENARIO === 'burst' || SCENARIO === 'all';
    const runTools = smoke || SCENARIO === 'tools' || SCENARIO === 'all';

    if (runSteady) results.push(await scenarioSteadyChat(base, token, steadyCfg));
    if (runBurst) results.push(await scenarioBurstChat(base, token, burstCfg));
    if (runTools) results.push(await scenarioTools(base, token, toolsCfg));

    console.log('\n================ LOAD TEST REPORT ================');
    for (const r of results) {
      printSummary(r.summary);
      console.log(`  max concurrency achieved: ${r.maxInFlight}`);
    }
    console.log(`\n/metrics reachable with RED series: ${obs.metricsOk}`);
    console.log(`/ready status: ${obs.ready?.status} checks=${JSON.stringify(obs.ready?.checks)}`);

    // SLO verdict.
    const verdicts = [];
    for (const r of results) {
      const s = r.summary;
      if (s.p95TtfbMs != null) {
        verdicts.push({
          name: `${s.name}: p95 TTFB < ${SLO_TTFB_P95_MS}ms`,
          pass: s.p95TtfbMs < SLO_TTFB_P95_MS,
          actual: `${s.p95TtfbMs.toFixed(1)}ms`,
        });
      }
      verdicts.push({
        name: `${s.name}: 0 HTTP 5xx`,
        pass: s.errors5xx === 0,
        actual: `${s.errors5xx}`,
      });
    }
    verdicts.push({ name: '/metrics exposes RED series', pass: obs.metricsOk, actual: String(obs.metricsOk) });

    console.log('\n--- SLO verdicts ---');
    let allPass = true;
    for (const v of verdicts) {
      console.log(`  [${v.pass ? 'PASS' : 'FAIL'}] ${v.name} (actual: ${v.actual})`);
      if (!v.pass) allPass = false;
    }
    // 429s are informational: graceful, never failures.
    const total429 = results.reduce((n, r) => n + r.summary.rateLimited, 0);
    console.log(`  (info) total graceful 429s observed: ${total429} — expected under burst, not a failure`);
    console.log(allPass ? '\nALL SLOS PASSED' : '\nSOME SLOS FAILED');
    shutdown();
    process.exit(allPass ? 0 : 1);
  } catch (error) {
    console.error('LOAD TEST FAILED:', error);
    shutdown();
    process.exit(1);
  }
}

await main();
