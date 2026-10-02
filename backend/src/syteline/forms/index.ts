/**
 * forms — SyteLine form-project automation (backend-ai port of
 * Enflite/Form-Project-Templates + the Enflite/Lots worked example).
 *
 * The AI builds form projects on Git/project files only:
 * - `formXml` — parse form exports, build new `<Form>.xml` text-level.
 * - `naming` — the `Uf_ENF_*` / `ENF_*` naming standard.
 * - `scaffold` — port of `scripts/new-project.sh`.
 * - `projectDocs` — README, Implementation-Plan, troubleshooting,
 *   original/README.
 * - `deck` — `plan/deck.config.js` + PPTX build.
 * - `github` — create repo, push, open the review PR (never merge).
 *
 * The AI never operates SyteLine, UET, FormSync, or the live IDO: those are
 * numbered human steps in the generated docs.
 */
export * from './formXml.js';
export * from './naming.js';
export * from './scaffold.js';
export * from './projectDocs.js';
export * from './deck.js';
export * from './deckBuildScript.js';
export * from './github.js';
export * from './projectPaths.js';
export * from './fieldSpec.js';
