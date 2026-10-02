# Form-Customization SOP (SyteLine Form AI Agent)

Human-readable copy of the SOP knowledge pack baked into the SyteLine Form
AI Agent's planner (`backend/src/formAgent/knowledge.ts`).
A test asserts the two stay in sync — edit the pack in ONE place and mirror
it here.

The agent already knows this SOP. A customization request carries only the
five inputs — form XML, IDO properties CSV, SQL columns CSV, instructions,
attachments — never the SOP again.

## Project layout

One SyteLine form per repo, scaffolded from `project-template/`:

- `<Form>.xml` — the built form; import into TRN through FormSync at Site scope, then test
- `original/<Form>.trn.original.xml` + `original/<Form>.production.original.xml` — byte-for-byte rollback copies, never edited, never rebuilt
- `docs/Implementation-Plan.md` — the runbook: Scope → Design → Develop → Staging → Launch → Test → Optimize, plus rollback
- `plan/<Form>_Implementation_Plan.pptx` — the implementation-plan deck in the Enflite brand style
- `tools/apply_form_changes.py` — the build script; generated files are rebuilt ONLY through it (deterministic rebuild check)

## Procedures 01–07

1. **Start** — scaffold from the template; stage the TRN + production originals byte-for-byte.
2. **UET setup** — design `Uf_ENF_*` fields + an `ENF_*` class on the existing SQL table (most projects); procedure 07 (new SQL table + IDO) only when the feature needs its own record.
3. **FormSync** — export backups BEFORE anything; import the built form at Site scope.
4. **Confirm UET fields (Staging check A)** — after UET Impact Schema + Unload IDO Metadata + sign out/in, confirm the new properties are on the IDO and note the real alias prefix — the alias is an ASSUMPTION until this check.
5. **Launch to production** — the same UET + import steps on production after sign-off.
6. **Rollback** — import the `original/*.xml` rollback copies through FormSync at Site scope.
7. **New table + IDO** — only when UET fields on the existing table are not enough.

## Hard rules

- **Backup first.** Never build without the rollback copies staged. The request's form XML is the TRN original; when a production original is also supplied and its SHA-256 differs from TRN, STOP — production has local form changes that must be scoped under Open items before any design work.
- **TRN-first.** Build and test on TRN, then production. Never design against production.
- **Byte preservation.** Form XML is UTF-8 with BOM and CRLF. Build text-level from the TRN export; never re-serialize the XML. Inline request content is normalized to CRLF+BOM on staging and flagged; file uploads must arrive byte-exact.
- **UET-only naming.** New fields bind `object.<alias>Uf_ENF_<Name>`; UET classes are `ENF_<Area>`; user defined types are `ENF_<Name>`. Anything else is rejected.
- **Purple highlighting.** Every new or changed component is highlighted purple so testers can find it; every new field also gets a grid column.
- **Deterministic rebuild.** `<Form>.xml` is always rebuilt from the original by the build script (never hand-edited); the rebuild check must pass.
- **Property patterns.** Relabels are label-only; component Type / Read-Only / Inline List changes don't survive re-import and become manual form-design steps in the implementation plan.
- **Never change Infor-owned SQL Tables, IDOs, or vendor forms.** New fields are UET-only.
- **Human steps stay human.** SyteLine, UET, and FormSync steps are numbered runbook steps for a person. Never claim one succeeded until the human confirms it.
- **PRs are reviewed by people.** Open the review PR; never merge it, never set auto-merge.

## IDO / SQL table inputs

- The IDO properties CSV is the property inventory of the form's IDO (property names, data types). New UET properties appear on the IDO only after UET Impact Schema + Unload IDO Metadata + sign out/in.
- The SQL columns CSV is the column inventory of the underlying SQL table(s). New fields attach via UET to the existing table; a new SQL table + IDO (procedure 07) only when the feature needs its own record.
- Cross-check: every planned `Uf_ENF_*` field must have a matching SQL column (existing, or planned via UET and flagged as an open item). Flag mismatches as open items; never invent columns.

## Vocabulary

Say "SQL Tables" and IDO terms; NEVER "Application Studio". Never expose internal function names.
