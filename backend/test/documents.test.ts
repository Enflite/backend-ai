import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '../src/documents/extraction.js';
import { chunkSections } from '../src/documents/ingestion.js';
import { scanMayProceed } from '../src/documents/malware.js';

describe('document ingestion primitives', () => {
  it('extracts HTML as untrusted text without executable elements', async () => {
    const sections = await extractDocument(
      new TextEncoder().encode('<h1>Policy</h1><p>Approved content</p><script>stealSecrets()</script>'),
      'text/html'
    );
    expect(sections).toEqual([{ text: 'Approved content', section: 'Policy' }]);
  });

  it('extracts XLSX rows with stable sheet source locations', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventory');
    sheet.addRow(['Item', 'Quantity']);
    sheet.addRow(['A-100', 12]);
    const bytes = await workbook.xlsx.writeBuffer();
    const sections = await extractDocument(
      new Uint8Array(bytes),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(sections[1]).toMatchObject({ text: 'A-100\t12', section: 'Inventory', sourceLocation: 'Inventory!2' });
  });

  it('retains citation metadata through deterministic chunking', () => {
    const chunks = chunkSections([{ text: 'policy text '.repeat(300), page: 7, section: 'Security', sourceLocation: 'page:7' }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.page === 7 && chunk.section === 'Security' && chunk.sourceLocation === 'page:7')).toBe(true);
  });

  it('fails closed for unavailable CUI scanning while allowing explicit non-production development mode', () => {
    const unavailable = { verdict: 'UNAVAILABLE', scanner: 'disabled-development' } as const;
    expect(scanMayProceed(unavailable, 'CUI')).toBe(false);
    expect(scanMayProceed(unavailable, 'INTERNAL')).toBe(true);
    expect(scanMayProceed({ verdict: 'INFECTED', scanner: 'test' }, 'PUBLIC')).toBe(false);
  });
});
