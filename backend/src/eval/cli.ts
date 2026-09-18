#!/usr/bin/env tsx
/**
 * cli.ts — `npm run eval [-- --model <id> --categories json-output --live --seed]`
 *
 * Runs the eval suite from the terminal. Default is the scripted MOCK suite
 * over the full 110-case corpus (deterministic, CI-safe, no model, no GPU).
 * Pass --seed for the 16-case representative smoke run, or --live to run
 * against the real AI gateway — requires EVAL_LIVE_PROVIDER (else the runner
 * refuses).
 *
 * Prints a per-category table, a per-dimension (charter §5) table, and p0
 * failures. Exits non-zero if any p0 case fails, so CI can gate on it.
 * Skipped cases (llm-judge without EVAL_JUDGE_MODEL) are reported but never
 * fail the run.
 */
import { EVAL_SEED_CORPUS } from './corpus.js';
import { EVAL_CORPUS } from './cases/index.js';
import { mockChatFn, runEval } from './runner.js';
import type { EvalCategory, QualityDimension } from './types.js';
// live.js and store.js are imported lazily: --no-store mock runs must not
// require gateway credentials or DATABASE_URL.

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function argList(name: string): string[] | undefined {
  const value = arg(name);
  return value ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function printTable(title: string, rows: Array<[string, string, string]>): void {
  console.log(`\n${title}`);
  console.log(`${pad('name', 28)} ${pad('passed/total', 14)} pass rate`);
  console.log('-'.repeat(60));
  for (const [name, passedTotal, rate] of rows) {
    console.log(`${pad(name, 28)} ${pad(passedTotal, 14)} ${rate}`);
  }
}

async function main(): Promise<void> {
  const modelId = arg('model');
  const live = hasFlag('live');
  const seed = hasFlag('seed');
  const noStore = hasFlag('no-store');
  const categories = argList('categories') as EvalCategory[] | undefined;
  const dimensions = argList('dimensions') as QualityDimension[] | undefined;
  const severities = argList('severities') as Array<'p0' | 'p1' | 'p2'> | undefined;

  const liveProvider = process.env.EVAL_LIVE_PROVIDER;
  if (live && !liveProvider) {
    console.error(
      'Live eval refused: EVAL_LIVE_PROVIDER is not set. Omit --live to run the scripted mock suite.'
    );
    process.exit(2);
  }
  const provider = live ? liveProvider! : 'mock';
  // Full corpus by default; --seed runs the 16-case representative smoke set.
  const corpus = seed ? EVAL_SEED_CORPUS : EVAL_CORPUS;
  console.log(`Eval mode: ${provider === 'mock' ? 'MOCK (scripted, CI-safe)' : `LIVE via ${provider}`}`);
  console.log(`Corpus: ${seed ? 'seed (14 cases, smoke)' : `full (${EVAL_CORPUS.length} cases)`}`);

  const baseChatFn = live
    ? (await import('./live.js')).gatewayChatFn(
        modelId ?? '',
        {
          tenantId: process.env.EVAL_TENANT_ID ?? '',
          userId: process.env.EVAL_USER_ID ?? '',
          roleId: process.env.EVAL_ROLE_ID ?? '',
        }
      )
    : mockChatFn(corpus);
  // Routing cases are judged against the real deterministic classifier, not a
  // scripted response and not a live model: routing is platform behavior, so
  // the wrapper intercepts routing-category messages in every mode and
  // delegates everything else to the underlying chatFn.
  const { routingClassifyChatFn } = await import('./cases/routing.js');
  const chatFn = routingClassifyChatFn(baseChatFn);

  if (!noStore && !modelId) {
    console.error('Missing --model <id>. (Or pass --no-store to run without persisting results.)');
    process.exit(2);
  }
  if (live && (!process.env.EVAL_TENANT_ID || !process.env.EVAL_USER_ID || !process.env.EVAL_ROLE_ID)) {
    console.error('Live mode needs EVAL_TENANT_ID, EVAL_USER_ID and EVAL_ROLE_ID for gateway auth.');
    process.exit(2);
  }

  let runId: string | null = null;
  let version = 'unversioned';
  // Lazy so --no-store never touches the database config.
  const store = noStore ? null : await import('./store.js');
  if (!noStore) {
    const found = await store!.getModelVersion(modelId!);
    if (!found) {
      console.error(`Model ${modelId} not found.`);
      process.exit(2);
    }
    version = found;
    runId = await store!.createRun({ modelId: modelId!, modelVersion: version, provider, createdBy: null });
  }

  try {
    const { results, summary } = await runEval(corpus, chatFn, {
      modelId: modelId ?? 'mock',
      modelVersion: version,
      categories,
      severities,
      dimensions,
      onCaseResult: runId ? (r) => store!.saveCaseResult(runId!, r) : undefined,
    });
    if (runId) await store!.finishRun(runId, summary);

    printTable(
      'By category:',
      Object.entries(summary.byCategory)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, b]) => [name, `${b.passed}/${b.total}`, `${((b.passed / b.total) * 100).toFixed(1)}%`])
    );

    const dimEntries = Object.entries(summary.byDimension).sort(([a], [b]) => a.localeCompare(b));
    if (dimEntries.length > 0) {
      printTable(
        'By quality dimension (charter §5):',
        dimEntries.map(([name, b]) => [name, `${b.passed}/${b.total}`, `${((b.passed / b.total) * 100).toFixed(1)}%`])
      );
    }

    console.log(`\nTotal: ${summary.passed}/${summary.total} passed, ${summary.failed} failed` +
      (summary.skipped > 0 ? `, ${summary.skipped} skipped (llm-judge, no judge model)` : ''));

    const failures = results.filter((r) => !r.passed && !r.skipped);
    if (failures.length > 0) {
      console.log('\nFailures:');
      for (const f of failures) {
        console.log(`  [${f.severity}] ${f.caseId} (${f.category}): ${JSON.stringify(f.details)}`);
      }
    }
    if (summary.p0Failed.length > 0) {
      console.log('\nP0 FAILURES (block promotion):');
      for (const id of summary.p0Failed) console.log(`  ${id}`);
    }
    if (summary.skipped > 0) {
      console.log('\nSkipped (not failures — llm-judge needs EVAL_JUDGE_MODEL):');
      for (const r of results.filter((r) => r.skipped)) console.log(`  ${r.caseId}`);
    }
    if (runId) console.log(`\nRun persisted: ${runId}`);

    process.exit(summary.p0Failed.length > 0 ? 1 : 0);
  } catch (error) {
    if (runId) await store!.failRun(runId, error instanceof Error ? error.message : String(error));
    console.error('Eval run failed:', error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

void main();
