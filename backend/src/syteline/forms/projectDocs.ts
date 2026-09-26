/**
 * projectDocs.ts — generate the form-project documents.
 *
 * Renders the four project documents from structured inputs, mirroring the
 * worked example (Enflite/Lots):
 *
 * - `README.md` — change bullets, Release log, Layout table of every file.
 * - `docs/Implementation-Plan.md` — the seven-phase runbook (SOP §6):
 *   Scope → Design → Develop → Staging → Launch → Test → Optimize, plus
 *   Rollback and Reference. Always TRN first, then production.
 * - `docs/troubleshooting.md` — confirmed gotchas only (SOP §8).
 * - `original/README.md` — rollback-copy table + the TRN/PRD SHA-256
 *   comparison result. When the exports differ, production has local
 *   changes: the doc says STOP and the tool refuses to design further.
 *
 * Writing style (SOP §8): plain short sentences, imperative numbered steps,
 * **bold** SyteLine screen names, `code` for field/class/table/IDO/file
 * names, tables over prose. Team-facing wording: "SQL Tables", IDO-based
 * terms; never internal function names.
 */

export interface UetFieldDesign {
  name: string;
  userDataType: string;
  dataType: string;
  precision: string;
  description: string;
  /** Rendered with an asterisk + note, e.g. `DescriptionType*`. */
  assumedNote?: string;
}

export interface BrdRow {
  id: string;
  requirement: string;
  detail: string;
}

export interface OpenItem {
  item: string;
  blocks: string;
}

export interface ScopeRow {
  tab: string;
  onForm: string;
  field: string;
  type: string;
  source: string;
}

export interface ImplementationPlanInput {
  formName: string;
  title: string;
  repo: string;
  /** One-paragraph summary of the change. */
  summary: string;
  goal: string;
  ido: string;
  /** Primary table, e.g. `lot`. */
  table: string;
  /** The `_mst` table the UET class attaches to, e.g. `lot_mst`. */
  mstTable: string;
  /** Table alias the form binds with, e.g. `lot`. Always an assumption until Staging check A. */
  alias: string;
  aliasAssumed: boolean;
  status: string;
  /** Source of truth, e.g. `Jake's written request (2026-09-25): *...*`. */
  sourceNote: string;
  scopeRows: ScopeRow[];
  layoutNote: string;
  brd: BrdRow[];
  openItems: OpenItem[];
  uetFields: UetFieldDesign[];
  uetClass: { name: string; label: string; description: string };
  /** e.g. `lotUf_ENF_Test`. */
  bindingExample: string;
  /** 3c: one bullet per form-build fact (components, binding, highlight, prefix). */
  formBuildBullets: string[];
  testChecklist: string[];
  /** Dated release line for the README, e.g. `**2026-09-25:** Project started ...`. */
  releaseLine: string;
  /** Human tab label for the new field(s), e.g. `General`. */
  tabLabel: string;
}

function assumedSuffix(assumed: boolean): string {
  return assumed ? ' (**assumed**; confirm in Staging, check A)' : '';
}

export function renderImplementationPlan(input: ImplementationPlanInput): string {
  const p = input;
  const aliasNote = p.aliasAssumed
    ? `alias \`${p.alias}\` **assumed**; confirm in Staging, check A`
    : `alias \`${p.alias}\``;
  const scopeRows = p.scopeRows
    .map((r) => `| ${r.tab} | ${r.onForm} | \`${r.field}\` | ${r.type} | ${r.source} |`)
    .join('\n');
  const brdRows = p.brd
    .map((r) => `| ${r.id} | ${r.requirement} | ${r.detail} |`)
    .join('\n');
  const openRows = p.openItems
    .map((o, i) => `| ${i + 1} | ${o.item} | ${o.blocks} |`)
    .join('\n');
  const uetFieldRows = p.uetFields
    .map((f) => {
      const udt = f.assumedNote ? `${f.userDataType}*` : f.userDataType;
      const prec = f.assumedNote ? `${f.precision}*` : f.precision;
      return `| \`${f.name}\` | \`${udt}\` | ${f.dataType} | ${prec} | ${f.description} |`;
    })
    .join('\n');
  const uetNotes = p.uetFields
    .filter((f) => f.assumedNote)
    .map((f) => `* Assumed: ${f.assumedNote}.`)
    .join('\n');
  const buildBullets = p.formBuildBullets.map((b) => `   - ${b}`).join('\n');
  const testItems = p.testChecklist.map((t) => `- [ ] ${t}`).join('\n');
  const fieldsCsv = p.uetFields.map((f) => `\`${f.name}\``).join(', ');

  return `# ${p.formName}: ${p.title} implementation plan

The runbook for getting the changes to the **${p.formName}** form live on **Infor CloudSuite**: ${p.summary} This plan follows the standard seven phases (**Scope → Design → Develop → Staging → Launch → Test → Optimize**) and sets out the full plan for the project: the UET setup, how the form is built and imported with **FormSync**, and how everything moves from **TRN** to **production**.

## At a glance

| | |
|---|---|
| **Goal** | ${p.goal} |
| **System** | Infor CloudSuite (no direct SQL access). Build and test in **TRN** first, then production. |
| **Form** | \`${p.formName}\`, imported at **Site** scope from \`${p.formName}.xml\` |
| **IDO** | \`${p.ido}\`: primary table \`${p.table}\`, a view over \`${p.mstTable}\` (${aliasNote}) |
| **Naming** | ENF = Enflite-created. User fields \`Uf_ENF_*\`; UET classes \`ENF_*\` |
| **Status** | ${p.status} |

## The seven phases

| # | Phase | What it means here |
|---|---|---|
| 1 | **Scope** | Confirm the requested changes and lock the field list |
| 2 | **Design** | Define every UET object: User Field, Class, Class/Field and Table/Class relationships |
| 3 | **Develop** | Build the UET setup and the form on **TRN** first, never directly in production |
| 4 | **Staging** | Confirm the fields on the IDO, import the form on TRN through FormSync, validate |
| 5 | **Launch** | Repeat the same UET setup and FormSync import in production |
| 6 | **Test** | Run the checklist on TRN before launch, and a smoke test after |
| 7 | **Optimize** | Two weeks of follow-up with the team |

## TRN first, then Production

Everything is built and proven on **TRN**, then repeated in **production** later.

| TRN | Production |
|---|---|
| 1. Build the UET setup (User Field, Class, Class/Field, Table/Class) | 1. Same UET entries, same order, from the TRN exports |
| 2. Import the form through **FormSync** | 2. Run UET Impact Schema in a scheduled window |
| 3. Test with the team | 3. Import the same form XML through **FormSync** |
| 4. Export each UET form to Excel as the production checklist | 4. Smoke test, then hand over to the team |

---

## 1. Scope

${p.sourceNote}

### What changes

| Tab | On the form | Field | Type | Source |
|---|---|---|---|---|
${scopeRows}

${p.layoutNote}

## Business Requirements (BRD)

| ID | Requirement | Detail |
|---|---|---|
${brdRows}

## Open items

| # | Item | Blocks |
|---|---|---|
${openRows}

## 2. Design

One design per UET form, in setup order.

### UET User Fields

| User Field Name | User Data Type | Data Type | Precision | Description |
|---|---|---|---|---|
${uetFieldRows}
${uetNotes}

### UET Classes

| Class Name | Label | Description |
|---|---|---|
| \`${p.uetClass.name}\` | ${p.uetClass.label} | ${p.uetClass.description} |

### UET Class/Field Relationships

| Class Name | Field Names |
|---|---|
| \`${p.uetClass.name}\` | ${fieldsCsv} |

### UET Table/Class Relationships

| Table Name | Class Name | Active | Extend All Records | Rule |
|---|---|---|---|---|
| \`${p.mstTable}\` | \`${p.uetClass.name}\` | ✔ | ✔ | (blank) |

### How the form reaches the field

UET fields are added to the IDO **automatically**. SyteLine names each one after the primary table's alias plus the field name, so no properties are created by hand:

| Where | Alias | Example |
|---|---|---|
| ${p.formName} (\`${p.ido}\`, table \`${p.table}\`) | \`${p.alias}\`${assumedSuffix(p.aliasAssumed)} | \`${p.bindingExample}\` |

\`${p.formName}.xml\` binds to that name (\`object.${p.bindingExample}\`). These runtime properties do **not** show in the IDOs → Properties export, so do not use that export as a check. Do not edit \`${p.ido}\`; it is Infor-owned and needs no change.

## 3. Develop (TRN)

Build on TRN first, never directly in production.

### 3a. UET setup, in this order

1. UET User Fields (${fieldsCsv})
2. UET Classes (\`${p.uetClass.name}\`)
3. UET Class/Field Relationships
4. UET Table/Class Relationships (\`${p.mstTable}\`)

Each form is filled in exactly as in **Design** above.

### 3b. UET Impact Schema

1. Get users out of ${p.formName}.
2. Tick **Commit Form Changes** and **Impact Schema** (leave Rollback Form Changes unticked), then click **Process**.
3. Check the background task finishes with no errors, then run **Unload IDO Metadata**.

Impact Schema adds the column to \`${p.mstTable}\` and rebuilds the \`${p.table}\` view the IDO reads.

### 3c. The form with FormSync

The ${p.formName} form is built as XML and imported, not hand-edited in Design Mode.

1. Export the current \`${p.formName}\` form and keep it in GitHub as the original: [\`original/${p.formName}.trn.original.xml\`](../original/${p.formName}.trn.original.xml). This is the rollback copy.
2. Apply the changes in the XML with the build (see \`tools/\` or the form-build module). Result: [\`${p.formName}.xml\`](../${p.formName}.xml):
${buildBullets}
3. Import \`${p.formName}.xml\` into TRN through **FormSync**, at **Site** scope (never over the Vendor form).
4. Check it in Design Mode, then use **FormSync** to bring the same XML to production at Launch.

## 4. Staging (TRN)

Freeze the TRN build and validate it before production.

### 4a. Confirm the fields are available (before importing the form)

Do this after Impact Schema (3b) and **Unload IDO Metadata** (sign out and back in). None of these checks change anything.

| # | Check | How | Pass |
|---|---|---|---|
| A | **Design Mode property list** (most direct) | Open the **current** ${p.formName} form → Design Mode → select any edit box → open its **Data Source** / Binding property list. Cancel without saving | \`${p.bindingExample}\` (or \`<alias>${p.uetFields.map((f) => f.name).join(', <alias>')}\`) is in the list. Note the exact alias prefix; the form XML must use it. You will also see a helper entry \`Der<alias>ExtBy${p.uetClass.name.replace(/^ENF_/, '')}\`: it proves the class is linked, but do **not** bind to it |
| B | **Dataview** (second opinion) | Create a throw-away Dataview on IDO \`${p.ido}\`, open the property picker, search \`Uf_ENF\`. Delete it afterwards | Same \`Uf_ENF\` names listed |
| C | **Final proof** | Import \`${p.formName}.xml\` (4b), open a record, enter a value in each new field, save, reopen | No "Invalid property name" errors; the values persist |

What a failure means:

- **Not listed:** Impact Schema did not run cleanly, or IDO metadata was not unloaded. Re-run UET Impact Schema (3b), then Unload IDO Metadata.
- **Listed with a different prefix than the form uses:** rebuild \`${p.formName}.xml\` with the confirmed alias and re-import.

### 4b. Refresh and import the form

| # | Step | Where | Check |
|---|---|---|---|
| 4.1 | **Unload IDO Metadata**, then sign out and back in | Unload IDO Metadata | – |
| 4.2 | Import \`${p.formName}.xml\` through **FormSync** at **Site** scope (never over the Vendor definition) | FormSync | Import succeeds |
| 4.3 | Open ${p.formName}, enter the new fields, save, reopen | ${p.formName} | **No "Invalid property name" errors**; values persist (check C) |

Then run the **Test** checklist (phase 6) on TRN and get sign-off before Launch.

## 5. Launch (production)

First export the unchanged production form to [\`original/${p.formName}.production.original.xml\`](../original/${p.formName}.production.original.xml) and compare it with the TRN export (see [\`original/README.md\`](../original/README.md)).

Then repeat **in this order**, in a scheduled window with users out of ${p.formName}:

1. UET User Fields (${fieldsCsv})
2. UET Classes (\`${p.uetClass.name}\`)
3. UET Class/Field Relationships
4. UET Table/Class Relationships (\`${p.mstTable}\`, Active, Extend All Records)
5. UET Impact Schema
6. Unload IDO Metadata (no IDO changes)
7. Import \`${p.formName}.xml\` through FormSync at Site scope
8. Smoke test: open a record, enter and save each new field, reopen it

Tip: export each UET form from TRN to Excel and use the exports as the checklist for production.

## 6. Test

Run on TRN during Staging, then repeat the key checks after Launch.

${testItems}

## 7. Optimize (2 weeks)

- Track issues from each team using the form
- Fix bugs; make sure nothing blocks normal work
- Update procedures with the new fields, and submit them for manager approval

## Rollback

Import the original form for that environment ([\`original/${p.formName}.trn.original.xml\`](../original/${p.formName}.trn.original.xml) or [\`original/${p.formName}.production.original.xml\`](../original/${p.formName}.production.original.xml)) through **FormSync**. The form goes straight back to how it was. The ${fieldsCsv} fields can stay in place; nothing on the original form uses them. Removing them (Table/Class relationship inactive + Impact Schema) **drops the columns and their data**, so only do that on purpose.

## Reference

| File | What |
|---|---|
| [\`../plan/${p.formName}_Implementation_Plan.pptx\`](../plan/${p.formName}_Implementation_Plan.pptx) | This plan as a deck |
| [\`../original/\`](../original/README.md) | Original TRN and production form exports, the rollback copies |
| [\`../${p.formName}.xml\`](../${p.formName}.xml) | Form export with the changes applied (3c), changes highlighted in purple |
| [\`troubleshooting.md\`](troubleshooting.md) | Problems hit on this project and their fixes |
| [Enflite/Form-Project-Templates](https://github.com/Enflite/Form-Project-Templates) | The SOP, templates and shared procedures this project started from |
`;
}

export interface ReadmeInput {
  repo: string;
  formName: string;
  /** e.g. `SyteLine — Lots form changes, built with UET and FormSync.` */
  tagline: string;
  changeBullets: string[];
  assumptionsNote?: string;
  releaseLines: string[];
  deckFileName: string;
  buildCommandNote: string;
}

export function renderReadme(input: ReadmeInput): string {
  const assumptions = input.assumptionsNote ? ` ${input.assumptionsNote}` : '';
  const bullets = input.changeBullets.map((b) => `- ${b}`).join('\n');
  const releases = input.releaseLines.map((r) => `- ${r}`).join('\n');
  return `# ${input.repo}

${input.tagline}

${bullets}

Requested by the team.${assumptions}

Built and tested on TRN first, then pushed to production. Follows the Enflite SOP in [\`AGENTS.md\`](AGENTS.md).

## Release

${releases}

## Layout

| Path | What |
|---|---|
| \`${input.formName}.xml\` | **Form export with the changes applied**, ready to import through FormSync at Site scope. Every change is highlighted in purple |
| \`tools/\` or the form-build module | Builds \`${input.formName}.xml\` from the original (${input.buildCommandNote}); rebuild deterministically before committing |
| \`docs/Implementation-Plan.md\` | **Start here:** phased runbook, open items, test and rollback |
| \`docs/troubleshooting.md\` | Confirmed problems and their fixes |
| \`plan/${input.deckFileName}\` | Implementation plan deck in the Enflite brand style (content in \`plan/deck.config.js\`) |
| \`plan/mockups/\` | The requested mockups (source of truth) |
| \`original/${input.formName}.trn.original.xml\`, \`original/${input.formName}.production.original.xml\` | Original form exports for TRN and production: the rollback copies. See [\`original/README.md\`](original/README.md) |
| \`AGENTS.md\` / \`CLAUDE.md\` | Enflite SOP (master copy in Form-Project-Templates) |
`;
}

export function renderTroubleshooting(formName: string): string {
  return `# ${formName} — Troubleshooting

Problems hit on this project and how they were fixed. Check here, then the shared list in [Enflite/Form-Project-Templates \`procedures/troubleshooting.md\`](https://github.com/Enflite/Form-Project-Templates/blob/main/procedures/troubleshooting.md), before starting a fresh diagnosis. If a fix here would help other projects, add it to the shared list too.

Only write **Confirmed** when it was seen working in the system; otherwise say what is assumed and how to check it.

<!-- Copy this block for each new entry.

## <Exact error text or short symptom>

**Seen:** <date>, <TRN / production>, <where in the form>

**Cause:** <what was actually wrong>

**Fix:**

1. <step, with **Screen names** in bold and \`names\` in code>
2. <step>

**Confirm:** <what "fixed" looks like>

**Environments:** <TRN done / production still to do>
-->
`;
}

export interface OriginalReadmeInput {
  formName: string;
  trnExportedNote: string;
  prdExportedNote: string;
  /** True when the two exports are byte-for-byte identical. */
  identical: boolean;
  /** First 16 hex chars of the SHA-256 (identical case). */
  shaPrefix: string;
}

export function renderOriginalReadme(input: OriginalReadmeInput): string {
  const verdict = input.identical
    ? `The two exports are byte-for-byte identical (SHA-256 \`${input.shaPrefix}…\`), so production has no local form changes. Rebuilding the form from either export produces exactly [\`../${input.formName}.xml\`](../${input.formName}.xml): the same file is imported into TRN and production.`
    : `The two exports differ: production has local form changes. **Stop** and list the differences under Open items in [\`../docs/Implementation-Plan.md\`](../docs/Implementation-Plan.md) before building the production form.`;
  return `# Original ${input.formName} form exports (rollback copies)

Exports of the **unchanged** ${input.formName} form, taken before the new form was imported. To roll back, import the matching file through **FormSync** at Site scope.

| File | Environment | Exported |
|---|---|---|
| \`${input.formName}.trn.original.xml\` | TRN | ${input.trnExportedNote} |
| \`${input.formName}.production.original.xml\` | Production | ${input.prdExportedNote} |

<!-- SHA-256 compared with the form-build module; one of these lines is kept. -->
${verdict}
`;
}
