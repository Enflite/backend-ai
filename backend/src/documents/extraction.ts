import { load } from 'cheerio';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import yauzl from 'yauzl';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { PPTX_MIME_TYPE } from './fileValidation.js';

export interface ExtractedSection {
  text: string;
  page?: number;
  section?: string;
  sourceLocation?: string;
}

function enforceTextLimit(sections: ExtractedSection[]): ExtractedSection[] {
  const total = sections.reduce((sum, section) => sum + section.text.length, 0);
  if (total > config.MAX_EXTRACTED_CHARACTERS) {
    throw Errors.badRequest('EXTRACTED_TEXT_TOO_LARGE', 'Extracted document text exceeds the configured limit');
  }
  return sections.filter((section) => section.text.trim().length > 0);
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Errors.badRequest('INVALID_TEXT_ENCODING', 'Text documents must use valid UTF-8');
  }
}

function extractHtml(html: string): ExtractedSection[] {
  const $ = load(html);
  $('script,style,noscript,iframe,object,embed').remove();
  const sections: ExtractedSection[] = [];
  let heading: string | undefined;
  $('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,table').each((_index, element) => {
    const tag = element.tagName.toLowerCase();
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (/^h[1-6]$/.test(tag)) {
      heading = text;
      return;
    }
    sections.push({ text, ...(heading ? { section: heading } : {}) });
  });
  return sections;
}

async function validateArchive(bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(Errors.badRequest('INVALID_ARCHIVE', 'Office document archive is malformed'));
      let entries = 0;
      let expandedBytes = 0;
      zip.on('entry', (entry) => {
        entries += 1;
        expandedBytes += entry.uncompressedSize;
        const compressed = Math.max(1, entry.compressedSize);
        if (entries > config.MAX_ARCHIVE_ENTRIES
          || expandedBytes > config.MAX_ARCHIVE_UNCOMPRESSED_BYTES
          || entry.uncompressedSize / compressed > 200) {
          zip.close();
          reject(Errors.badRequest('ARCHIVE_LIMIT_EXCEEDED', 'Office document exceeds safe archive limits'));
          return;
        }
        zip.readEntry();
      });
      zip.once('end', resolve);
      zip.once('error', () => reject(Errors.badRequest('INVALID_ARCHIVE', 'Office document archive is malformed')));
      zip.readEntry();
    });
  });
}

export async function extractDocument(
  bytes: Uint8Array,
  mimeType: string
): Promise<ExtractedSection[]> {
  // Images are vision inputs, not text documents: they carry no extractable
  // text. The ingestion pipeline marks image documents READY without chunks;
  // the raw bytes are served to vision-capable models at chat time.
  if (mimeType.startsWith('image/')) return [];
  if (mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'text/markdown') {
    return enforceTextLimit([{ text: decodeText(bytes), sourceLocation: 'document' }]);
  }
  if (mimeType === 'text/html') return enforceTextLimit(extractHtml(decodeText(bytes)));
  if (mimeType === 'application/pdf') {
    const parser = new PDFParse({ data: Buffer.from(bytes) });
    try {
      const result = await parser.getText();
      return enforceTextLimit(result.pages.map((page) => ({
        text: page.text,
        page: page.num,
        sourceLocation: `page:${page.num}`,
      })));
    } catch {
      throw Errors.badRequest('EXTRACTION_FAILED', 'PDF text extraction failed');
    } finally {
      await parser.destroy();
    }
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    await validateArchive(bytes);
    try {
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
      return enforceTextLimit(extractHtml(result.value));
    } catch {
      throw Errors.badRequest('EXTRACTION_FAILED', 'DOCX text extraction failed');
    }
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    await validateArchive(bytes);
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
      const sections: ExtractedSection[] = [];
      workbook.eachSheet((sheet) => {
        sheet.eachRow((row) => {
          const values: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            const value = cell.value;
            values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? ''));
          });
          const text = values.join('\t').trim();
          if (text) sections.push({ text, section: sheet.name, sourceLocation: `${sheet.name}!${row.number}` });
        });
      });
      return enforceTextLimit(sections);
    } catch {
      throw Errors.badRequest('EXTRACTION_FAILED', 'XLSX text extraction failed');
    }
  }
  if (mimeType === PPTX_MIME_TYPE) {
    return enforceTextLimit(await extractPptx(bytes));
  }
  throw Errors.badRequest('UNSUPPORTED_FILE_TYPE', 'Document type is not supported');
}

/** Read the UTF-8 contents of the named entries of a ZIP archive. */
async function readZipEntries(bytes: Uint8Array, names: string[]): Promise<Map<string, string>> {
  const wanted = new Set(names);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(Errors.badRequest('INVALID_ARCHIVE', 'Office document archive is malformed'));
      const found = new Map<string, string>();
      const fail = () => {
        zip.close();
        reject(Errors.badRequest('INVALID_ARCHIVE', 'Office document archive is malformed'));
      };
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!wanted.has(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError: Error | null, stream: NodeJS.ReadableStream) => {
          if (streamError || !stream) {
            fail();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('end', () => {
            found.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
          stream.once('error', fail);
        });
      });
      zip.once('end', () => resolve(found));
      zip.once('error', fail);
      zip.readEntry();
    });
  });
}

/** Names of ZIP entries matching a pattern, in archive order. */
async function listZipEntries(bytes: Uint8Array, pattern: RegExp): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(Errors.badRequest('INVALID_ARCHIVE', 'Office document archive is malformed'));
      const names: string[] = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        if (pattern.test(entry.fileName)) names.push(entry.fileName);
        zip.readEntry();
      });
      zip.once('end', () => resolve(names));
      zip.once('error', () => reject(Errors.badRequest('INVALID_ARCHIVE', 'Office document archive is malformed')));
      zip.readEntry();
    });
  });
}

const SLIDE_ENTRY_PATTERN = /^ppt\/slides\/slide(\d+)\.xml$/;

/** Visible text of one slide: the DrawingML <a:t> runs, in document order. */
function extractSlideText(slideXml: string): string {
  const $ = load(slideXml, { xmlMode: true });
  const parts: string[] = [];
  $('*').each((_index, element) => {
    if (element.type === 'tag' && element.tagName === 'a:t') {
      const text = $(element).text().replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    }
  });
  return parts.join(' ');
}

async function extractPptx(bytes: Uint8Array): Promise<ExtractedSection[]> {
  // Zip-bomb and malformation limits, same as DOCX/XLSX.
  await validateArchive(bytes);
  // A renamed .docx/.xlsx also starts with PK: verify the OOXML content
  // type is really a presentation before extracting.
  const contentTypes = (await readZipEntries(bytes, ['[Content_Types].xml'])).get('[Content_Types].xml') ?? '';
  if (!contentTypes.includes('presentationml')) {
    throw Errors.badRequest('EXTRACTION_FAILED', 'File is not a valid PowerPoint presentation');
  }
  const slideNames = (await listZipEntries(bytes, SLIDE_ENTRY_PATTERN)).sort((a, b) => {
    const slideNumber = (name: string) => Number(SLIDE_ENTRY_PATTERN.exec(name)?.[1] ?? 0);
    return slideNumber(a) - slideNumber(b);
  });
  const slideXml = await readZipEntries(bytes, slideNames);
  const sections: ExtractedSection[] = [];
  for (const name of slideNames) {
    const slideNumber = SLIDE_ENTRY_PATTERN.exec(name)?.[1];
    const text = extractSlideText(slideXml.get(name) ?? '');
    if (text) {
      sections.push({ text, section: `Slide ${slideNumber}`, sourceLocation: `slide:${slideNumber}` });
    }
  }
  return sections;
}
