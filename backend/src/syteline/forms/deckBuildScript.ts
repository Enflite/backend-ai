/**
 * deckBuildScript.ts — the branded `plan/build_impl_deck.js` renderer.
 *
 * This is the Enflite-brand implementation-plan deck builder (pptxgenjs),
 * written to the generated form project's `plan/` directory by `buildDeck`
 * in `deck.ts`, replacing the copy that ships with the project template so
 * every AI-generated deck matches `branding/enflite-style-guide.md` from
 * Enflite/Form-Project-Templates.
 *
 * Brand rules applied (guide is authoritative; the live
 * `branding/reference-eCMRs_plan.pptx` deck confirms the look):
 * - Palette: Enflite Red #CF0C2C (exact, from the logo), Ink #1A1A1A,
 *   Body Gray #4A4A4A, Divider Gray #E5E5E5, Light Section Gray #F7F7F7,
 *   White #FFFFFF. Red used sparingly — badge, eyebrows, milestone rings.
 * - No cards: scope flow steps are separated by thin (0.75pt) Divider Gray
 *   rules and whitespace, never filled bordered boxes.
 * - Section eyebrows: small, bold, Enflite Red, uppercase, wide
 *   letter-spacing, sitting above the light-weight heading on every
 *   content slide.
 * - Type: Segoe UI Light for large display titles, Calibri body; bold
 *   reserved for the single word/number that matters.
 * - Solid Enflite Red rounded-square icon badge with a white glyph
 *   (confirmed in the reference deck).
 * - No drop shadows, no gradients-as-decoration.
 * - Cover uses the transparent `brand/enflite-logo.png` (copied into the
 *   project by the scaffold), so the build is reproducible with no manual
 *   steps.
 *
 * All project content lives in `deck.config.js` (including `cfg.brand`,
 * the palette); this file is styling only. Keep this JS free of backticks
 * and `${` so it embeds cleanly in the template literal below.
 */

export const BRANDED_BUILD_SCRIPT = `// Implementation plan deck in the Enflite brand style
// (branding/enflite-style-guide.md in Enflite/Form-Project-Templates):
// white slides, solid Enflite Red rounded icon badge + white icon, small bold
// red uppercase section eyebrows above light-weight Ink headings,
// Segoe UI Light titles, Calibri body, thin Divider Gray rules instead of
// cards, transparent Enflite logo on the cover. No drop shadows, no gradients.
//
// All project content lives in deck.config.js (including cfg.brand, the
// palette). This file is written by backend-ai's syteline deck builder —
// do not edit by hand; regenerate instead.
// Build: cd plan && npm install && npm run build
var pptxgen = require("pptxgenjs");
var cfg = require("./deck.config.js");

var pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.title = cfg.title;

var B = cfg.brand || {};
var RED = B.red || "CF0C2C";
var INK = B.ink || "1A1A1A";
var BODY = B.body || "4A4A4A";
var DIV = B.divider || "E5E5E5";
var WHITE = B.white || "FFFFFF";
var DISPLAY = "Segoe UI Light", SANS = "Calibri";
function icon(n) { return "icons/i" + n + "_white.png"; }
// Icon numbers: see branding/icons/README.md in Enflite/Form-Project-Templates
var IC = { brd: 1, scope: 2, fields: 3, design: 6, develop: 7, trn: 8, launch: 9, test: 10, optimize: 11 };

function txt(s, text, o) {
  s.addText(text, Object.assign({ isTextBox: true, fontFace: SANS, margin: 0, valign: "top", color: INK }, o));
}
function arc(s, x, y, d) {
  s.addShape(pres.shapes.OVAL, { x: x, y: y, w: d, h: d, fill: { type: "none" }, line: { color: RED, width: 1 } });
}
// Section eyebrow: small, bold, Enflite Red, uppercase, wide letter-spacing
function eyebrow(s, t, x, y, w) {
  txt(s, t, { x: x, y: y, w: w, h: 0.32, fontSize: 12.5, bold: true, color: RED, charSpacing: 2, valign: "middle" });
}
// Header: red rounded badge with white icon, red eyebrow, light Ink title, gray subtitle
function header(s, eyebrowText, title, sub, ic, right) {
  s.background = { color: WHITE };
  var bx = right ? 11.33 : 0.5, tx = right ? 0.5 : 2.4;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: bx, y: 0.55, w: 1.5, h: 1.5, rectRadius: 0.12, fill: { color: RED }, line: { color: RED } });
  s.addImage({ path: icon(ic), x: bx + 0.38, y: 0.93, w: 0.75, h: 0.75 });
  eyebrow(s, eyebrowText, tx, 0.40, 10.43);
  txt(s, title, { x: tx, y: 0.72, w: 10.43, h: 0.74, fontFace: DISPLAY, fontSize: 32, valign: "middle" });
  txt(s, sub, { x: tx, y: 1.46, w: 10.43, h: 0.62, fontSize: 15, color: BODY });
}
function label(s, t, x, y, w) {
  if (x === undefined) x = 0.9;
  if (y === undefined) y = 2.75;
  if (w === undefined) w = 10;
  txt(s, t, { x: x, y: y, w: w, h: 0.4, fontSize: 15, bold: true, valign: "middle" });
}
// Square-bullet list: a drawn marker + one text box per item (bold runs stay inline).
// Each item is a plain string, a run object {text, options}, or an array of those.
function bullets(s, items, x, y, w, h, size, gap) {
  if (size === undefined) size = 15;
  if (gap === undefined) gap = 8;
  var lineH = size / 72 * 1.22, tw = w - 0.3, perLine = Math.floor(tw * 72 / (size * 0.41));
  var yy = y;
  items.forEach(function (it) {
    var list = Array.isArray(it) ? it : [it];
    var runs = list.map(function (r) {
      return typeof r === "string" ? { text: r } : { text: r.text, options: r.options || {} };
    });
    var len = runs.reduce(function (n, r) { return n + r.text.length; }, 0);
    var bh = Math.max(1, Math.ceil(len / perLine)) * lineH;
    txt(s, "\\u25A0", { x: x, y: yy, w: 0.2, h: lineH, fontSize: size * 0.6, valign: "middle" });
    txt(s, runs.map(function (r) { return { text: r.text, options: r.options || {} }; }), { x: x + 0.3, y: yy, w: tw, h: bh, fontSize: size });
    yy += bh + gap / 72;
  });
}
// Plain numbered steps: small bold number, text
function numbered(s, items, x, y, w, rowH, size) {
  if (size === undefined) size = 15;
  items.forEach(function (t, i) {
    var yy = y + i * rowH;
    txt(s, String(i + 1), { x: x, y: yy, w: 0.35, h: 0.45, fontSize: 13, bold: true, valign: "middle" });
    txt(s, t, { x: x + 0.45, y: yy, w: w, h: 0.45, fontSize: size, valign: "middle" });
  });
}
// Table: muted header text, hairline rules, bold first column
function table(s, x, y, cols, rows, rowH, size) {
  if (rowH === undefined) rowH = 0.42;
  if (size === undefined) size = 13;
  var cx = x;
  var xs = cols.map(function (c) { var v = cx; cx += c[1]; return v; });
  var W = cx - x;
  cols.forEach(function (c, j) {
    txt(s, c[0], { x: xs[j], y: y, w: c[1] - 0.15, h: 0.3, fontSize: 12.5, color: BODY, valign: "middle" });
  });
  s.addShape(pres.shapes.LINE, { x: x, y: y + 0.33, w: W, h: 0, line: { color: DIV, width: 0.75 } });
  rows.forEach(function (r, i) {
    var yy = y + 0.36 + i * rowH;
    r.forEach(function (c, j) {
      txt(s, c, { x: xs[j], y: yy, w: cols[j][1] - 0.15, h: rowH, fontSize: size, bold: j === 0, valign: "middle" });
    });
    s.addShape(pres.shapes.LINE, { x: x, y: yy + rowH, w: W, h: 0, line: { color: DIV, width: 0.75 } });
  });
}
function note(s, t, y) {
  if (y === undefined) y = 6.55;
  txt(s, t, { x: 0.9, y: y, w: 11.5, h: 0.45, fontSize: 13, italic: true, color: BODY, valign: "middle" });
}

// Title
{
  var s = pres.addSlide(); s.background = { color: WHITE };
  s.addImage({ path: "brand/enflite-logo.png", x: 0.5, y: 0.5, w: 3.0, h: 0.63 });
  arc(s, 9.6, -1.2, 5.2);
  txt(s, "PROJECT PLAN", { x: 0.5, y: 4.55, w: 8, h: 0.4, fontSize: 14, bold: true, color: RED, charSpacing: 2, valign: "middle" });
  txt(s, cfg.title, { x: 0.5, y: 4.95, w: 11, h: 1.6, fontFace: DISPLAY, fontSize: 60, color: RED, valign: "middle" });
  txt(s, cfg.subtitle, { x: 0.5, y: 6.55, w: 10.5, h: 0.5, fontSize: 17, color: BODY });
}

// Seven milestones
{
  var s = pres.addSlide(); s.background = { color: WHITE };
  eyebrow(s, "MILESTONES", 0.9, 0.55, 11.5);
  txt(s, "Seven milestones to production", { x: 0.9, y: 0.95, w: 11.5, h: 0.85, fontFace: DISPLAY, fontSize: 36, valign: "middle" });
  txt(s, "The plan at a glance — each phase in order.", { x: 0.9, y: 1.80, w: 11.5, h: 0.5, fontSize: 16, color: BODY });
  s.addShape(pres.shapes.LINE, { x: 1.16, y: 2.62, w: 0, h: 4.0, line: { color: DIV, width: 2 } });
  cfg.phases.forEach(function (ph, i) {
    var h = ph[0], d = ph[1];
    var y = 2.42 + i * 0.66;
    s.addShape(pres.shapes.OVAL, { x: 0.95, y: y, w: 0.42, h: 0.42, fill: { color: WHITE }, line: { color: RED, width: 1.5 } });
    txt(s, String(i + 1), { x: 0.95, y: y, w: 0.42, h: 0.42, fontSize: 14, bold: true, align: "center", valign: "middle" });
    txt(s, [{ text: h, options: { bold: true, fontSize: 17, breakLine: true } }, { text: d, options: { fontSize: 13, color: BODY } }],
      { x: 1.67, y: y - 0.08, w: 10.5, h: 0.62 });
  });
}

// Scope — no cards: steps separated by thin Divider Gray rules and whitespace
{
  var s = pres.addSlide(); header(s, "SCOPE", "Scope", cfg.scope.sub, IC.scope);
  arc(s, 11.48, 5.91, 3.5);
  label(s, "The actual phase flow");
  var flow = cfg.scope.flow, step = 10.75 / flow.length;
  flow.forEach(function (pair, i) {
    var h = pair[0], d = pair[1];
    var x = 0.9 + i * step;
    if (i > 0) {
      s.addShape(pres.shapes.LINE, { x: x - 0.18, y: 3.25, w: 0, h: 2.0, line: { color: DIV, width: 0.75 } });
    }
    txt(s, [{ text: h, options: { bold: true, fontSize: 14, breakLine: true } }, { text: d, options: { fontSize: 13 } }],
      { x: x + 0.05, y: 3.3, w: step - 0.45, h: 2.0 });
  });
}

// BRD
{
  var s = pres.addSlide(); header(s, "REQUIREMENTS", "BRD", "Business requirements for the change.", IC.brd);
  label(s, "Business requirements");
  bullets(s, cfg.brd, 0.9, 3.2, 11.53, 3.9, 15, 5);
}

// Mockup (optional)
if (cfg.mockup && cfg.mockup.image) {
  var m = cfg.mockup;
  var s = pres.addSlide(); header(s, "MOCKUP", m.title || "The requested change", m.sub || "", IC.fields);
  label(s, "What changes", 0.5, 2.3, 5);
  bullets(s, m.bullets || [], 0.5, 2.8, 5.9, 3.8, 15, 8);
  s.addImage({ path: m.image, x: 6.7, y: 2.3, w: 6.1, h: 3.22, sizing: { type: "contain", w: 6.1, h: 3.22 } });
  txt(s, m.caption || "", { x: 6.7, y: 5.6, w: 6.1, h: 0.35, fontSize: 12, italic: true, color: BODY });
}

// TRN first, then production
{
  var s = pres.addSlide(); header(s, "ENVIRONMENTS", "TRN first, then production", "Everything is built and proven on TRN, then pushed to production later.", IC.trn, true);
  label(s, "On TRN", 0.9, 2.75, 5);
  numbered(s, ["Build the UET setup", "Import the form through FormSync", "Test with the team", "Export each UET form to Excel as the production checklist"], 0.9, 3.25, 5.0, 0.6);
  txt(s, "\\u2192", { x: 6.2, y: 3.2, w: 0.6, h: 2.4, fontSize: 28, color: RED, align: "center", valign: "middle" });
  label(s, "In production", 7.1, 2.75, 5);
  numbered(s, ["Same UET entries, same order, from the TRN exports", "Run UET Impact Schema in a scheduled window", "Import the same form XML through FormSync", "Smoke test, then hand over to the team"], 7.1, 3.25, 5.2, 0.6);
}

// Design, one slide per UET form (badge alternates sides)
cfg.design.forEach(function (d, i) {
  var s = pres.addSlide(); header(s, "DESIGN", "Design", d.sub, IC.design, i % 2 === 1);
  label(s, d.label);
  var rowH = d.rows.length > 5 ? 0.36 : 0.5, size = d.rows.length > 5 ? 13 : 14;
  table(s, 0.9, 3.2, d.cols, d.rows, rowH, size);
  if (d.note) note(s, d.note);
});

// Develop
{
  var s = pres.addSlide(); header(s, "BUILD", "Develop", "Build on TRN first — never directly in production.", IC.develop);
  label(s, "Actual build steps");
  bullets(s, cfg.develop, 0.9, 3.2, 11.53, 3.3, 15, 6);
}

// Develop · FormSync
{
  var s = pres.addSlide(); header(s, "FORMSYNC", "Develop", "The form is built as XML and imported through FormSync.", IC.launch, true);
  label(s, "Building the form with FormSync");
  numbered(s, cfg.formsync, 0.9, 3.25, 11.1, 0.72);
}

// Staging
{
  var s = pres.addSlide(); header(s, "STAGING", "Staging", "Freeze the TRN build and run final validation before production.", IC.trn, true);
  label(s, "Actual staging approach");
  numbered(s, cfg.staging, 0.9, 3.2, 11.1, 0.72);
}

// Launch + rollback
{
  var s = pres.addSlide(); header(s, "LAUNCH", "Launch", "Deploy to production.", IC.launch);
  label(s, "Production steps");
  numbered(s, cfg.launch, 0.9, 3.2, 11.1, 0.72);
  label(s, "Rollback", 0.9, 5.45);
  bullets(s, [cfg.rollback], 0.9, 5.9, 11.53, 0.6, 15);
}

// Test
{
  var s = pres.addSlide(); header(s, "TEST", "Test", "Run tests to make sure everything looks good.", IC.test, true);
  label(s, "Actual test list");
  bullets(s, cfg.test, 0.9, 3.2, 11.53, 3.4, 15, 10);
}

// Optimize (centered)
{
  var s = pres.addSlide(); s.background = { color: WHITE };
  arc(s, -3.4, 4.9, 6.0); arc(s, 10.5, -1.5, 5.0);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 5.92, y: 0.55, w: 1.5, h: 1.5, rectRadius: 0.12, fill: { color: RED }, line: { color: RED } });
  s.addImage({ path: icon(IC.optimize), x: 6.29, y: 0.93, w: 0.75, h: 0.75 });
  txt(s, "Optimize", { x: 0, y: 2.2, w: 13.33, h: 1.0, fontFace: DISPLAY, fontSize: 48, color: RED, align: "center", valign: "middle" });
  txt(s, "Two weeks of optimization, working closely with the team.", { x: 1.5, y: 3.15, w: 10.33, h: 0.6, fontSize: 17, color: BODY, align: "center", valign: "middle" });
  label(s, "Actual optimization backlog", 3.6, 4.42, 6);
  bullets(s, cfg.optimize, 3.6, 4.85, 7.0, 1.9, 15, 4);
}

pres.writeFile({ fileName: cfg.fileName }).then(function (f) { console.log("wrote", f); });
`;
