/**
 * formXml.ts — SyteLine form-export parsing and text-level form building.
 *
 * Ports the Enflite/Form-Project-Templates build script
 * (`project-template/tools/apply_form_changes.py`) to TypeScript so the AI
 * can build `<Form>.xml` from an original export without shelling out to
 * Python. The semantics are identical on purpose:
 *
 * - Form XML is UTF-8 **with BOM** and **CRLF** line endings. Exports are
 *   edited as TEXT; the XML is never re-serialized with a parser
 *   (SOP hard rule 6: keep form exports byte-for-byte).
 * - Every new or changed component is highlighted in purple so testers can
 *   find it: labels `BACKCOLOR(112,48,160) FORECOLOR(255,255,255)`, fields
 *   and grid columns `BACKCOLOR(221,204,255)`.
 * - A build script must reproduce the committed `<Form>.xml` exactly;
 *   `checkDeterministic` is the `--check` equivalent (rebuild in memory,
 *   fail when the committed file differs).
 *
 * Guards (hard rules, not suggestions):
 * - `assertExportBytes` refuses exports that lost their BOM or CRLF
 *   endings. A mangled attachment is NEVER "fixed" — the caller must ask
 *   for the file to be uploaded byte-for-byte instead (HOW-TO-USE.md).
 * - New fields must bind to `object.<alias>Uf_ENF_<Name>`: the Enflite
 *   naming standard. Anything else throws.
 * - `yes-no` (checkbox) fields are refused: the template build script only
 *   covers text/date/dropdown/notes components and inventing a checkbox
 *   shape would violate "the team's source is the source of truth".
 */

export const FORM_XML_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const CRLF = '\r\n';
export const COMP_INDENT = '            '; // 12 spaces: <Component> indent
export const PROP_INDENT = '               '; // 15 spaces: property indent
export const GRID_CONTAINER = 'FormCollectionGrid';

/** Purple highlight: strong purple + white text on labels, light purple on data. */
export const PURPLE_LABEL = 'BACKCOLOR(112,48,160) FORECOLOR(255,255,255)';
export const PURPLE_DATA = 'BACKCOLOR(221,204,255)';

/** Component Type codes seen in SyteLine form exports. */
export const COMPONENT_TYPES = {
  static: '0',
  edit: '1',
  checkbox: '5',
  groupbox: '6',
  gridcol: '15',
  notes: '18',
  date: '26',
  list: '27',
} as const;

export type NewFieldKind = 'text' | 'date' | 'dropdown' | 'notes';

/** Height the template script hard-codes for new grid columns. */
const GRID_COL_HEIGHT = 28.8666667938232;

export interface FormComponent {
  name: string;
  type: string;
  tabOrder: number;
  topPos: number;
  leftPos: number;
  height: number;
  width: number;
  containerName: string;
  containerSequence: number;
  dataSource?: string;
  caption?: string;
}

export interface FormTab {
  name: string;
  /** Human label, e.g. `s&General` -> `General`. */
  label: string;
}

export interface ParsedForm {
  formName: string;
  /** IDO qualifier + name from the fds_DataSource variable, e.g. `SL` + `SLLots`. */
  idoQualifier: string;
  idoName: string;
  components: Map<string, FormComponent>;
  /** Component names in export order. */
  componentOrder: string[];
  tabs: FormTab[];
}

export interface NewFieldSpec {
  /** UET user field name, e.g. `Uf_ENF_Test`. */
  field: string;
  /** On-form label, e.g. `Test`. */
  caption: string;
  kind: NewFieldKind;
  /** User Defined Type for a `dropdown`, else undefined. */
  userDefinedType?: string;
  /** Component name stem -> `<stem>Static`, `<stem>Edit`, `<stem>GridCol`. */
  stem: string;
  /** Tab / container the field sits in (`ContainerName` in the export). */
  container: string;
  top: number;
  labelLeft: number;
  labelWidth: number;
  editLeft: number;
  editWidth: number;
}

export interface RelabelSpec {
  component: string;
  newCaption: string;
}

export interface ResizeSpec {
  component: string;
  changes: Record<string, number | string>;
}

export interface FormBuildSpec {
  formName: string;
  /** Table alias the new fields bind with, e.g. `lot`. ALWAYS surfaced as an assumption. */
  aliasPrefix: string;
  newFields: NewFieldSpec[];
  relabels: RelabelSpec[];
  resizes: ResizeSpec[];
  addGridColumns: boolean;
  highlight: boolean;
}

// ---------------------------------------------------------------------------
// Byte-level export handling
// ---------------------------------------------------------------------------

/** Strip the BOM and decode an export to text (CRLF preserved). */
export function decodeExport(bytes: Buffer): string {
  const stripped = bytes.subarray(0, 3).equals(FORM_XML_BOM)
    ? bytes.subarray(3)
    : bytes;
  return stripped.toString('utf8');
}

/** Encode built text back to export bytes: UTF-8 with BOM. */
export function encodeExport(text: string): Buffer {
  return Buffer.concat([FORM_XML_BOM, Buffer.from(text, 'utf8')]);
}

/**
 * Hard guard: the export must be UTF-8 with BOM and CRLF line endings.
 * Throws when an attachment came through altered (no BOM, LF endings) —
 * the caller must ask for a byte-for-byte re-upload instead of "fixing" it.
 */
export function assertExportBytes(bytes: Buffer, what: string): void {
  if (!bytes.subarray(0, 3).equals(FORM_XML_BOM)) {
    throw new Error(
      `${what}: not a byte-for-byte export (missing UTF-8 BOM). ` +
        'Do not fix it — ask for the file to be uploaded to original/ unchanged.',
    );
  }
  const text = bytes.subarray(3).toString('utf8');
  if (!text.includes('\r\n')) {
    throw new Error(
      `${what}: not a byte-for-byte export (no CRLF line endings). ` +
        'Do not fix it — ask for the file to be uploaded to original/ unchanged.',
    );
  }
  if (text.replace(/\r\n/g, '').includes('\n')) {
    throw new Error(
      `${what}: mixed line endings (lone LF found). ` +
        'Do not fix it — ask for the file to be uploaded to original/ unchanged.',
    );
  }
}

// ---------------------------------------------------------------------------
// Parsing (read-only; never re-serializes)
// ---------------------------------------------------------------------------

function propOf(body: string, key: string): string | undefined {
  const m = body.match(new RegExp(`<${key}>([^<]*)</${key}>`));
  return m ? m[1] : undefined;
}

function numOf(body: string, key: string): number {
  return parseFloat(propOf(body, key) ?? '0');
}

/** Human label for a tab caption like `s&General`. */
export function tabLabel(caption: string): string {
  return caption.replace(/^s/, '').replace(/&/g, '');
}

export function parseFormXml(text: string): ParsedForm {
  const formName = text.match(/<Form Name="([^"]+)"/)?.[1] ?? '';
  const fds = text.match(
    /<Variable Name="fds_DataSource">\s*<Value>([^<]*)<\/Value>/,
  )?.[1];
  const idoMatch = fds?.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/);
  const components = new Map<string, FormComponent>();
  const componentOrder: string[] = [];
  const tabs: FormTab[] = [];

  for (const m of text.matchAll(
    /<Component Name="([^"]+)">(.*?)<\/Component>/gs,
  )) {
    const name = m[1]!;
    const body = m[2]!;
    const comp: FormComponent = {
      name,
      type: propOf(body, 'Type') ?? '',
      tabOrder: parseInt(propOf(body, 'TabOrder') ?? '0', 10),
      topPos: numOf(body, 'TopPos'),
      leftPos: numOf(body, 'LeftPos'),
      height: numOf(body, 'Height'),
      width: numOf(body, 'Width'),
      containerName: propOf(body, 'ContainerName') ?? '',
      containerSequence: parseInt(propOf(body, 'ContainerSequence') ?? '0', 10),
      dataSource: propOf(body, 'DataSource'),
      caption: propOf(body, 'Caption'),
    };
    components.set(name, comp);
    componentOrder.push(name);
    if (comp.type === COMPONENT_TYPES.groupbox && false) {
      // reserved: group boxes are Type 6 but tabs are Type 13 (below)
    }
    if (comp.type === '13') {
      tabs.push({ name, label: tabLabel(comp.caption ?? name) });
    }
  }

  return {
    formName,
    idoQualifier: idoMatch?.[1] ?? '',
    idoName: idoMatch?.[2] ?? '',
    components,
    componentOrder,
    tabs,
  };
}

// ---------------------------------------------------------------------------
// Building (text-level edits, mirroring apply_form_changes.py)
// ---------------------------------------------------------------------------

/**
 * Python `num()`: str(round(v, 13)) with trailing zeros and the trailing dot
 * stripped. Emulated exactly (not via `Math.round(v * 1e13)`, which diverges
 * from CPython on ~2% of inputs because of float multiply error):
 *
 * 1. The exact binary value is expanded to decimal with BigInt and rounded
 *    half-even to 13 fractional digits — the same correctly-rounded
 *    conversion CPython's round() uses.
 * 2. The nearest double to that decimal is taken (`parseFloat` is correctly
 *    rounded) and rendered with the shortest round-trip digits (`String`),
 *    which matches CPython's `str()` for the coordinate range form exports
 *    use (both print plain fixed notation there).
 */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`non-finite coordinate: ${v}`);
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const neg = v < 0;
  const a = Math.abs(v);

  // Exact binary decomposition of the double: value = mant * 2^exp2.
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, a);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp2: number;
  if (expBits === 0) {
    exp2 = -1074; // subnormal
  } else {
    mant += 1n << 52n;
    exp2 = expBits - 1075;
  }

  // Half-even rounding of mant * 2^exp2 to 13 fractional decimal digits:
  // q = round_half_even(value * 10^13), computed as num/den on BigInts.
  const SCALE = 13n;
  const pow10 = 10n ** SCALE;
  let num: bigint;
  let den: bigint;
  if (exp2 >= 0) {
    num = mant * (1n << BigInt(exp2)) * pow10;
    den = 1n;
  } else {
    num = mant * pow10;
    den = 1n << BigInt(-exp2);
  }
  let q = num / den;
  const rem = num % den;
  const twice = rem * 2n;
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;

  let digits = q.toString();
  if (digits.length <= 13) digits = digits.padStart(14, '0');
  const intPart = digits.slice(0, digits.length - 13);
  const fracPart = digits.slice(digits.length - 13).replace(/0+$/, '');
  const decimal = fracPart ? `${intPart}.${fracPart}` : intPart;

  // Nearest double to that decimal, shortest round-trip digits.
  const rendered = String(parseFloat(decimal));
  return neg ? `-${rendered}` : rendered;
}

function componentBlock(name: string, props: Array<[string, string]>): string {
  const lines = [`${COMP_INDENT}<Component Name="${name}">`];
  for (const [k, v] of props) {
    lines.push(v === '' ? `${PROP_INDENT}<${k} />` : `${PROP_INDENT}<${k}>${v}</${k}>`);
  }
  lines.push(`${COMP_INDENT}</Component>`);
  return lines.join(CRLF) + CRLF;
}

function kindType(kind: NewFieldKind): string {
  switch (kind) {
    case 'text':
      return COMPONENT_TYPES.edit;
    case 'date':
      return COMPONENT_TYPES.date;
    case 'dropdown':
      return COMPONENT_TYPES.list;
    case 'notes':
      return COMPONENT_TYPES.notes;
  }
}

function highlightFor(spec: FormBuildSpec, which: 'label' | 'data'): string {
  if (!spec.highlight) return '';
  return which === 'label' ? PURPLE_LABEL : PURPLE_DATA;
}

function assertEnfField(field: string): void {
  if (!/^Uf_ENF_[A-Z][A-Za-z0-9]*$/.test(field)) {
    throw new Error(
      `new field "${field}" violates the Enflite naming standard ` +
        '(expected Uf_ENF_<PascalCaseName>). New fields are UET-only; ' +
        'never bind a new component to an Infor-owned property.',
    );
  }
}

interface BuiltComponents {
  blocks: Map<string, string>;
}

function buildNewComponents(parsed: ParsedForm, spec: FormBuildSpec): BuiltComponents {
  const blocks = new Map<string, string>();
  if (spec.newFields.length === 0) return { blocks };
  if (!spec.aliasPrefix || spec.aliasPrefix.startsWith('<')) {
    throw new Error(
      'set the table alias (aliasPrefix), e.g. "lot". It is always an ' +
        'assumption until Staging check A confirms it in Design Mode.',
    );
  }

  let tabOrder = 0;
  for (const c of parsed.components.values()) {
    if (Number.isInteger(c.tabOrder) && c.tabOrder > tabOrder) tabOrder = c.tabOrder;
  }
  tabOrder += 1;
  const seqByContainer = new Map<string, number>();
  const nextSeq = (container: string): number => {
    if (!seqByContainer.has(container)) {
      let max = 0;
      for (const c of parsed.components.values()) {
        if (c.containerName === container && c.containerSequence > max) {
          max = c.containerSequence;
        }
      }
      seqByContainer.set(container, max + 1);
    }
    const next = seqByContainer.get(container)!;
    seqByContainer.set(container, next + 1);
    return next;
  };

  const common: Array<[string, string]> = [
    ['Flags', '1'],
    ['ReadOnly', 'False'],
    ['Hidden', 'False'],
    ['HelpContextID', '0'],
  ];

  const add = (
    name: string,
    type: string,
    top: number,
    left: number,
    height: number,
    width: number,
    caption: string | undefined,
    container: string,
    tail: Array<[string, string]>,
  ): void => {
    const props: Array<[string, string]> = [
      ['DeviceID', '-1'],
      ['Type', type],
      ['TabOrder', String(tabOrder++)],
      ['TopPos', formatNumber(top)],
      ['LeftPos', formatNumber(left)],
      ['Height', formatNumber(height)],
      ['ListHeight', '2'],
      ['Width', formatNumber(width)],
    ];
    if (caption !== undefined) props.push(['Caption', caption]);
    props.push(['MaxCharacters', '0'], ['ContainerName', container], [
      'ContainerSequence',
      String(nextSeq(container)),
    ]);
    blocks.set(name, componentBlock(name, [...props, ...tail]));
  };

  const dataTail = (f: NewFieldSpec, grid: boolean): Array<[string, string]> => {
    const tail: Array<[string, string]> = [
      ['DataSource', `object.${spec.aliasPrefix}${f.field}`],
      ['Binding', '1'],
    ];
    tail.push(
      ...(grid
        ? ([
            ['Flags', '0'],
            ['ReadOnly', 'False'],
            ['Hidden', 'False'],
            ['HelpContextID', '0'],
          ] as Array<[string, string]>)
        : common),
    );
    if (f.kind !== 'notes') tail.push(['MenuName', 'StdDefault']);
    if (f.userDefinedType) tail.push(['DefaultFrom', `UserDefinedType(${f.userDefinedType})`]);
    if (f.kind === 'date') tail.push(['PropertyClassName', 'Date']);
    return tail;
  };

  for (const f of spec.newFields) {
    assertEnfField(f.field);
    const stem = f.stem;
    const cap = f.caption;
    const container = f.container;
    const labFmt = (`JUSTIFY(R) ${highlightFor(spec, 'label')}`).trim();
    add(
      `${stem}Static`,
      COMPONENT_TYPES.static,
      f.top + 0.3,
      f.labelLeft,
      1,
      f.labelWidth,
      cap,
      container,
      [
        ['Binding', '0'],
        ...common,
        ['Post301Format', labFmt],
        ['EffectiveCaption', cap],
      ],
    );
    const height = f.kind === 'notes' ? 4.33333333333333 : 1.3;
    add(
      `${stem}Edit`,
      kindType(f.kind),
      f.top,
      f.editLeft,
      height,
      f.editWidth,
      `C(${stem}Static)`,
      container,
      [
        ...dataTail(f, false),
        ['Post301Format', highlightFor(spec, 'data')],
        ['EffectiveCaption', `C(${stem}Static)`],
      ],
    );
  }

  if (spec.addGridColumns) {
    let left = 0;
    for (const c of parsed.components.values()) {
      if (c.containerName === GRID_CONTAINER) {
        const right = c.leftPos + c.width;
        if (right > left) left = right;
      }
    }
    for (const f of spec.newFields) {
      if (f.kind === 'notes') continue;
      const w = f.kind === 'date' ? 19 : 14;
      add(
        `${f.stem}GridCol`,
        COMPONENT_TYPES.gridcol,
        0,
        left,
        GRID_COL_HEIGHT,
        w,
        f.caption,
        GRID_CONTAINER,
        [
          ...dataTail(f, true),
          ['Post301Format', highlightFor(spec, 'data')],
          ['EffectiveCaption', f.caption],
        ],
      );
      left += w;
    }
  }

  return { blocks };
}

/** Apply RELABELS / RESIZES to one component's opening block. */
function editComponentBlock(
  text: string,
  name: string,
  fn: (block: string) => string,
  srcWhat: string,
): string {
  const pat = new RegExp(
    `(<Component Name="${escapeRegExp(name)}">.*?)(</Component>)`,
    's',
  );
  const m = pat.exec(text);
  if (!m) throw new Error(`component ${name} not found in ${srcWhat}`);
  return text.slice(0, m.index) + fn(m[1]!) + m[2]! + text.slice(m.index + m[0].length);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setFormat(block: string, extra: string): string {
  if (!extra) return block;
  if (block.includes('<Post301Format />')) {
    return block.replace('<Post301Format />', `<Post301Format>${extra}</Post301Format>`);
  }
  if (block.includes('<Post301Format>')) {
    return block.replace(
      /<Post301Format>([^<]*)<\/Post301Format>/,
      `<Post301Format>$1 ${extra}</Post301Format>`,
    );
  }
  // No Post301Format at all: insert before <EffectiveCaption> (same quirk as the
  // template script — the new line sits at column 0).
  return block.replace(
    /(<EffectiveCaption>)/,
    `<Post301Format>${extra}</Post301Format>${CRLF}${PROP_INDENT}$1`,
  );
}

function relabel(block: string, caption: string, spec: FormBuildSpec): string {
  if (block.includes('<Caption>')) {
    block = block.replace(/<Caption>[^<]*<\/Caption>/, `<Caption>${caption}</Caption>`);
  } else {
    block = block.replace(
      /(<Width>[^<]*<\/Width>\r\n)/,
      `$1${PROP_INDENT}<Caption>${caption}</Caption>${CRLF}`,
    );
  }
  block = block.replace(
    /<EffectiveCaption>[^<]*<\/EffectiveCaption>/g,
    `<EffectiveCaption>${caption}</EffectiveCaption>`,
  );
  return setFormat(block, highlightFor(spec, 'data'));
}

/**
 * Build `<Form>.xml` text from the original export text (BOM already
 * stripped) and a build spec. Returns CRLF text without BOM — use
 * `renderFormXml` for the final bytes.
 */
export function buildFormXml(originalText: string, spec: FormBuildSpec): string {
  let text = originalText;
  const parsed = parseFormXml(text);

  for (const r of spec.relabels) {
    text = editComponentBlock(text, r.component, (b) => relabel(b, r.newCaption, spec), 'original');
  }
  for (const r of spec.resizes) {
    text = editComponentBlock(
      text,
      r.component,
      (b) => {
        for (const [k, v] of Object.entries(r.changes)) {
          const next = b.replace(
            new RegExp(`<${escapeRegExp(k)}>[^<]*</${escapeRegExp(k)}>`),
            `<${k}>${typeof v === 'number' ? formatNumber(v) : v}</${k}>`,
          );
          if (next === b) throw new Error(`${r.component} has no ${k}`);
          b = next;
        }
        return b;
      },
      'original',
    );
  }

  // Insert new components in the export's alphabetical (case-insensitive) order.
  const built = buildNewComponents(parsed, spec);
  for (const name of [...built.blocks.keys()].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
  )) {
    if (parsed.components.has(name)) {
      throw new Error(`${name} already exists in the original export`);
    }
    const block = built.blocks.get(name)!;
    const positions: Array<{ pos: number; name: string }> = [];
    const re = /^ {12}<Component Name="([^"]+)">/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      positions.push({ pos: m.index, name: m[1]! });
    }
    const target = positions.find((p) => p.name.toLowerCase() > name.toLowerCase());
    const insertAt =
      target?.pos ?? text.indexOf('         </Components>');
    if (insertAt < 0) throw new Error('</Components> not found in the original export');
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  return text;
}

/**
 * Full render: original export bytes -> final `<Form>.xml` bytes
 * (UTF-8 with BOM, CRLF). Guards the input bytes first.
 */
export function renderFormXml(originalBytes: Buffer, spec: FormBuildSpec): Buffer {
  assertExportBytes(originalBytes, 'original export');
  return encodeExport(buildFormXml(decodeExport(originalBytes), spec));
}

/**
 * Determinism check (`--check` semantics): rebuild in memory and fail when
 * the committed file differs. Returns true when they match.
 */
export function checkDeterministic(
  originalBytes: Buffer,
  spec: FormBuildSpec,
  committedBytes: Buffer,
): boolean {
  return renderFormXml(originalBytes, spec).equals(committedBytes);
}

/** SHA-256 hex of bytes (used for the TRN/PRD original comparison). */
export async function sha256Hex(bytes: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}
