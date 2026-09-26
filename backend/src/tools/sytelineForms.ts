/**
 * sytelineForms.ts — SyteLine form-project tools.
 *
 * The AI performs the form-customization workflow from the
 * Enflite/Form-Project-Templates SOP (ports of `scripts/new-project.sh` and
 * `apply_form_changes.py`, doc/deck/PR automation) through these tools.
 *
 * Hard guards (enforced here, in application code):
 * - Every tool requires the `syteline:forms` permission (Admin gets it by
 *   default; AI Admin and Developer get it explicitly in permissions.ts).
 * - `form_add_field` SHA-256-compares the TRN and production originals when
 *   both exist. If they differ, it REFUSES to build: production has local
 *   changes and the plan must record them before any design work.
 * - New fields must bind to `object.<alias>Uf_ENF_<Name>` — the UET-only
 *   naming standard; anything else throws.
 * - `form_open_pr` only OPENS the review PR. Form-project PRs are never
 *   merged by automation (no auto_merge, no merge call at all).
 *
 * The AI never operates SyteLine, UET, FormSync, or the live IDO — those
 * stay numbered human steps in the generated docs. All tool paths are
 * confined under SYTELINE_FORM_PROJECTS_DIR; absolute paths and `..`
 * escapes are rejected.
 */

import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { Classification } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { config } from '../config.js';
import {
  buildFormXml,
  decodeExport,
  encodeExport,
  NewFieldSpec,
  assertExportBytes,
  checkDeterministic,
  sha256Hex,
} from '../syteline/forms/formXml.js';
import { assertUetFieldName, componentStem } from '../syteline/forms/naming.js';
import { scaffoldProject } from '../syteline/forms/scaffold.js';
import {
  ImplementationPlanInput,
  ReadmeInput,
  renderImplementationPlan,
  renderOriginalReadme,
  renderReadme,
  renderTroubleshooting,
} from '../syteline/forms/projectDocs.js';
import { buildDeck, DeckInput } from '../syteline/forms/deck.js';
import { pushProjectAndOpenPr } from '../syteline/forms/github.js';
import { ToolDefinition, ToolExecutionContext } from './gateway.js';

const FORM_CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY'];

const formNameSchema = () => z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_]+$/);
const relPathSchema = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (p) => !p.startsWith('/') && !p.includes('..') && !p.includes('\0'),
      `${what}: must be a relative path without .. escapes`,
    );

/** Confine every project path under the configured projects root. */
function projectDirOrThrow(relativeProjectDir: string): string {
  const root = resolve(
    config.SYTELINE_FORM_PROJECTS_DIR ??
      join(process.cwd(), 'form-projects'),
  );
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

function readExportBytes(projectDir: string, file: string): Buffer {
  const safe = basename(file);
  if (safe !== file || !file.endsWith('.xml')) {
    throw Errors.badRequest('INVALID_EXPORT', 'original exports must be .xml files in original/');
  }
  const path = join(projectDir, 'original', file);
  if (!existsSync(path)) throw Errors.notFound('EXPORT_NOT_FOUND', `original/${file} not found`);
  const bytes = readFileSync(path);
  assertExportBytes(bytes, `original/${file}`);
  return bytes;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const newFieldSchema = z
  .object({
    field: z.string().regex(/^Uf_ENF_[A-Za-z0-9]+$/),
    caption: z.string().min(1).max(60),
    kind: z.enum(['text', 'date', 'dropdown', 'notes']),
    userDefinedType: z.string().max(60).optional(),
    container: z.string().min(1).max(80),
    top: z.number().finite(),
    labelLeft: z.number().finite(),
    labelWidth: z.number().finite().positive(),
    editLeft: z.number().finite(),
    editWidth: z.number().finite().positive(),
  })
  .strict();

const formAddFieldInput = z
  .object({
    projectDir: relPathSchema('projectDir'),
    /** TRN original export the XML is built from. */
    originalFile: relPathSchema('originalFile'),
    /** When present: the production original. If it differs, the tool stops. */
    prdOriginalFile: relPathSchema('prdOriginalFile').optional(),
    /** Table alias the new fields bind with, e.g. `lot`. */
    aliasPrefix: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
    fields: z.array(newFieldSchema).min(1).max(20),
    relabels: z
      .array(z.object({ component: z.string().min(1), newCaption: z.string().min(1) }).strict())
      .default([]),
    resizes: z
      .array(
        z
          .object({
            component: z.string().min(1),
            changes: z.record(z.string(), z.union([z.number(), z.string()])),
          })
          .strict(),
      )
      .default([]),
    addGridColumns: z.boolean().default(true),
    highlight: z.boolean().default(true),
    /** Rebuild-check against the committed file instead of writing. */
    checkOnly: z.boolean().default(false),
  })
  .strict();

const formStartProjectInput = z
  .object({
    projectDir: relPathSchema('projectDir'),
    formName: formNameSchema(),
    title: z.string().trim().min(1).max(120),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
    /** Absolute path to a Form-Project-Templates checkout (CI/fixtures); server default otherwise. */
    templateDir: z.string().max(500).optional(),
  })
  .strict();

const deckInputSchema: z.ZodType<DeckInput> = z
  .object({
    formName: z.string().min(1),
    title: z.string().min(1),
    subtitle: z.string().min(1),
    fileName: z.string().min(1),
    brd: z.array(z.array(z.string())),
    scope: z.object({ sub: z.string(), flow: z.array(z.string()) }),
    design: z.array(z.string()),
    develop: z.array(z.string()),
    formsync: z.array(z.string()),
    staging: z.array(z.string()),
    launch: z.array(z.string()),
    test: z.array(z.string()),
    optimize: z.array(z.string()),
    rollback: z.array(z.string()),
    phases: z.array(z.tuple([z.string(), z.array(z.string())])),
    mockupImage: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const sytelineFormToolDefinitions: readonly ToolDefinition<any>[] = [
  {
    name: 'syteline.form_start_project',
    description:
      'Scaffold a new SyteLine form project (port of new-project.sh): copies ' +
      'the project template, fills in {{FORM}}/{{TITLE}}/{{REPO}}, copies the ' +
      'Enflite brand assets, and writes plan/deck.config.js. Refuses to ' +
      'overwrite an existing project. Start here for any form change.',
    action: 'scaffold',
    destructive: false,
    permission: 'syteline:forms',
    allowedClassifications: FORM_CLASSIFICATIONS,
    schema: formStartProjectInput,
    execute: async (input: z.infer<typeof formStartProjectInput>, _ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const dir = projectDirOrThrow(input.projectDir);
      const templateDir =
        input.templateDir ??
        (config.SYTELINE_FORM_TEMPLATES_DIR as string | undefined) ??
        (() => {
          throw Errors.badRequest(
            'NO_TEMPLATE_DIR',
            'No Form-Project-Templates checkout configured (SYTELINE_FORM_TEMPLATES_DIR)',
          );
        })();
      const files = scaffoldProject({
        formName: input.formName,
        title: input.title,
        repo: input.repo,
        destDir: dir,
        templateDir,
      });
      return { projectDir: dir, formName: input.formName, files, filesCount: files.length };
    },
  },
  {
    name: 'syteline.form_add_field',
    description:
      'Build <Form>.xml from the TRN original export and write it (or, with ' +
      'checkOnly, verify it matches the committed file deterministically). ' +
      'New components bind to object.<alias>Uf_ENF_<Name> with purple ' +
      'highlighting; every field also gets a grid column. STOP guard: if ' +
      'prdOriginalFile is given and differs from the TRN original, the tool ' +
      'refuses — production has local changes that must be scoped first.',
    action: 'build',
    destructive: false,
    permission: 'syteline:forms',
    allowedClassifications: FORM_CLASSIFICATIONS,
    schema: formAddFieldInput,
    execute: async (
      input: z.infer<typeof formAddFieldInput>,
      _ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const dir = projectDirOrThrow(input.projectDir);
      const originalBytes = readExportBytes(dir, input.originalFile);

      // Hard guard: TRN/PRD original comparison.
      let prdIdentical: boolean | undefined;
      let shaPrefix: string | undefined;
      if (input.prdOriginalFile) {
        const prdBytes = readExportBytes(dir, input.prdOriginalFile);
        const trnSha = await sha256Hex(originalBytes);
        prdIdentical = (await sha256Hex(prdBytes)) === trnSha;
        shaPrefix = trnSha.slice(0, 16);
        if (!prdIdentical) {
          throw Errors.conflict(
            'FORM_ORIGINALS_DIFFER',
            'STOP: the TRN and production originals differ — production has local form changes. ' +
              'Record them under Open items in docs/Implementation-Plan.md before any design work.',
          );
        }
      }

      const fields: NewFieldSpec[] = input.fields.map((f) => {
        assertUetFieldName(f.field);
        return { ...f, stem: componentStem(f.field) };
      });
      const rendered = encodeExport(
        buildFormXml(decodeExport(originalBytes), {
          formName: basename(input.originalFile, '.xml'),
          aliasPrefix: input.aliasPrefix,
          newFields: fields,
          relabels: input.relabels ?? [],
          resizes: input.resizes ?? [],
          addGridColumns: input.addGridColumns ?? true,
          highlight: input.highlight ?? true,
        }),
      );
      const outPath = join(dir, `${basename(input.originalFile, '.xml')}.xml`);
      if (input.checkOnly ?? false) {
        const ok = existsSync(outPath) && rendered.equals(readFileSync(outPath));
        if (!ok) {
          throw Errors.conflict(
            'FORM_XML_NOT_DETERMINISTIC',
            `rebuilt <Form>.xml does not match the committed file — commit the build output before shipping`,
          );
        }
        return { deterministic: true, prdIdentical, shaPrefix };
      }
      writeFileSync(outPath, rendered);
      return {
        written: outPath,
        bytes: rendered.length,
        components: fields.flatMap((f) => [
          `${f.stem}Static`,
          `${f.stem}Edit`,
          ...(f.kind === 'notes' ? [] : [`${f.stem}GridCol`]),
        ]),
        prdIdentical,
        shaPrefix,
      };
    },
  },
  {
    name: 'syteline.form_write_docs',
    description:
      'Write the form-project documents: README.md, docs/Implementation-Plan.md ' +
      '(seven phases: Scope → Design → Develop → Staging → Launch → Test → ' +
      'Optimize), docs/troubleshooting.md, and original/README.md with the ' +
      'TRN/production SHA-256 comparison verdict. Team-facing wording; no ' +
      'internal function names.',
    action: 'docs',
    destructive: false,
    permission: 'syteline:forms',
    allowedClassifications: FORM_CLASSIFICATIONS,
    schema: z
      .object({
        projectDir: relPathSchema('projectDir'),
        plan: z.custom<ImplementationPlanInput>((v) => typeof v === 'object' && v !== null),
        readme: z.custom<ReadmeInput>((v) => typeof v === 'object' && v !== null),
        originalReadme: z
          .object({
            formName: z.string().min(1),
            trnExportedNote: z.string().min(1),
            prdExportedNote: z.string().min(1),
            identical: z.boolean(),
            shaPrefix: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    execute: async (input: {
      projectDir: string;
      plan: ImplementationPlanInput;
      readme: ReadmeInput;
      originalReadme: { formName: string; trnExportedNote: string; prdExportedNote: string; identical: boolean; shaPrefix: string };
    }, _ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const dir = projectDirOrThrow(input.projectDir);
      mkdirSync(join(dir, 'docs'), { recursive: true });
      mkdirSync(join(dir, 'original'), { recursive: true });
      const files: string[] = [];
      const write = (rel: string, content: string) => {
        const path = join(dir, rel);
        writeFileSync(path, content, 'utf8');
        files.push(rel);
      };
      write('README.md', renderReadme(input.readme));
      write('docs/Implementation-Plan.md', renderImplementationPlan(input.plan));
      write('docs/troubleshooting.md', renderTroubleshooting(input.originalReadme.formName));
      write('original/README.md', renderOriginalReadme(input.originalReadme));
      return { files };
    },
  },
  {
    name: 'syteline.form_build_deck',
    description:
      'Generate plan/deck.config.js and build the implementation-plan PPTX ' +
      'in the Enflite brand style via the project\'s npm build.',
    action: 'build',
    destructive: false,
    permission: 'syteline:forms',
    allowedClassifications: FORM_CLASSIFICATIONS,
    schema: z
      .object({
        projectDir: relPathSchema('projectDir'),
        deck: deckInputSchema,
        skipInstall: z.boolean().default(false),
      })
      .strict(),
    execute: async (input: { projectDir: string; deck: DeckInput; skipInstall: boolean }, _ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const dir = projectDirOrThrow(input.projectDir);
      const pptx = buildDeck(input.deck, { projectDir: dir, skipInstall: input.skipInstall });
      return { deckConfig: join(dir, 'plan', 'deck.config.js'), pptx };
    },
  },
  {
    name: 'syteline.form_open_pr',
    description:
      'Create the GitHub repo (if needed), push the form project, and open ' +
      'its review PR via `gh` (or the REST API with GITHUB_TOKEN). Opens the ' +
      'PR only — form-project PRs are always reviewed and merged by a ' +
      'person, never by automation.',
    action: 'publish',
    destructive: false,
    permission: 'syteline:forms',
    allowedClassifications: FORM_CLASSIFICATIONS,
    schema: z
      .object({
        projectDir: relPathSchema('projectDir'),
        repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        branch: z.string().regex(/^[A-Za-z0-9_.-]+$/).default('main'),
        base: z.string().regex(/^[A-Za-z0-9_.-]+$/).default('main'),
        prTitle: z.string().min(1).max(200),
        prBody: z.string().min(1).max(20000),
      })
      .strict(),
    execute: async (
      input: { projectDir: string; repo: string; branch: string; base: string; prTitle: string; prBody: string },
      _ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const dir = projectDirOrThrow(input.projectDir);
      const result = await pushProjectAndOpenPr({
        repo: input.repo,
        projectDir: dir,
        branch: input.branch,
        base: input.base,
        commitMessage: input.prTitle,
        prTitle: input.prTitle,
        prBody: input.prBody,
      });
      return { repo: result.repo, prUrl: result.prUrl, via: result.via };
    },
  },
];
