import { describe, expect, it } from 'vitest';
import {
  blockedTitle,
  isTerminalStatus,
  mergeSteps,
  statusMeta,
  type FlowStepLog,
} from './types';
import {
  buildCreateFormData,
  emptyValues,
  parseInstructions,
  validateNewCustomization,
  type NewCustomizationValues,
} from './payload';

function file(name: string): File {
  return new File(['x'], name);
}

function validValues(): NewCustomizationValues {
  return {
    ...emptyValues(),
    formName: 'PurchaseOrderDetailReportViewer',
    title: 'Re-point collection and add T&Cs',
    instructionsText: 'Change the primary collection\nAdd terms and conditions footer',
    formXml: file('PurchaseOrderDetailReportViewer.xml'),
    idoPropertiesCsv: file('ido-properties.csv'),
    sqlColumnsCsv: file('sql-columns.csv'),
    attachments: [file('notes.txt')],
  };
}

describe('statusMeta', () => {
  it('labels every lifecycle status', () => {
    expect(statusMeta('requested').label).toBe('Requested');
    expect(statusMeta('in_progress').label).toBe('In progress');
    expect(statusMeta('awaiting_review').label).toBe('Awaiting review');
    expect(statusMeta('completed').label).toBe('Completed');
    expect(statusMeta('blocked').label).toBe('Blocked');
    expect(statusMeta('cancelled').label).toBe('Cancelled');
  });
});

describe('isTerminalStatus', () => {
  it('treats awaiting_review as terminal (agent-side) and requested/in_progress as live', () => {
    expect(isTerminalStatus('awaiting_review')).toBe(true);
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('blocked')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('requested')).toBe(false);
    expect(isTerminalStatus('in_progress')).toBe(false);
  });
});

describe('blockedTitle', () => {
  it('maps known blocked codes to friendly titles', () => {
    expect(blockedTitle('trn-prd-drift')).toBe('TRN / production drift detected');
    expect(blockedTitle('missing-github-token')).toBe('GitHub access not configured');
  });
  it('falls back to the raw code for unknown codes', () => {
    expect(blockedTitle('something-new')).toBe('something-new');
  });
});

describe('mergeSteps', () => {
  it('shows all eight canonical steps, overlaying live status by name', () => {
    const live: FlowStepLog[] = [
      { name: 'intake', status: 'done' },
      { name: 'validate-inputs', status: 'running', detail: 'malware scan' },
    ];
    const merged = mergeSteps(live);
    expect(merged).toHaveLength(8);
    expect(merged[0]!.name).toBe('intake');
    expect(merged[0]!.live?.status).toBe('done');
    expect(merged[1]!.live?.status).toBe('running');
    expect(merged[1]!.live?.detail).toBe('malware scan');
    expect(merged[2]!.live).toBeUndefined();
    expect(merged[7]!.name).toBe('open-pr');
  });
});

describe('parseInstructions', () => {
  it('splits on newlines and drops blank lines', () => {
    expect(parseInstructions('one\n\ntwo\r\n  three  \n')).toEqual(['one', 'two', 'three']);
  });
});

describe('validateNewCustomization', () => {
  it('accepts a complete, well-formed request', () => {
    expect(validateNewCustomization(validValues())).toEqual([]);
  });

  it('requires the five inputs', () => {
    const errors = validateNewCustomization(emptyValues());
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.join(' ')).toContain('Form name is required');
    expect(errors.join(' ')).toContain('form .XML is required');
    expect(errors.join(' ')).toContain('IDO properties CSV is required');
    expect(errors.join(' ')).toContain('SQL columns CSV is required');
    expect(errors.join(' ')).toContain('at least one instruction');
  });

  it('rejects bad form names and wrong file extensions', () => {
    const values = {
      ...validValues(),
      formName: 'bad name!',
      formXml: file('form.txt'),
      idoPropertiesCsv: file('ido.xml'),
    };
    const errors = validateNewCustomization(values);
    expect(errors.join(' ')).toContain('letters, digits, and underscores');
    expect(errors.join(' ')).toContain('Form XML must be a .xml file');
    expect(errors.join(' ')).toContain('IDO properties CSV must be a .csv file');
  });

  it('rejects duplicate attachment names', () => {
    const values = { ...validValues(), attachments: [file('a.txt'), file('a.txt')] };
    expect(validateNewCustomization(values).join(' ')).toContain('Duplicate attachment filename');
  });
});

describe('buildCreateFormData', () => {
  it('assembles the multipart parts the backend expects', () => {
    const form = buildCreateFormData(validValues());
    expect(form.get('formName')).toBe('PurchaseOrderDetailReportViewer');
    expect(form.get('title')).toBe('Re-point collection and add T&Cs');
    expect(JSON.parse(String(form.get('instructions')))).toEqual([
      'Change the primary collection',
      'Add terms and conditions footer',
    ]);
    expect((form.get('formXml') as File).name).toBe('PurchaseOrderDetailReportViewer.xml');
    expect((form.get('idoPropertiesCsv') as File).name).toBe('ido-properties.csv');
    expect((form.get('sqlColumnsCsv') as File).name).toBe('sql-columns.csv');
    expect(form.getAll('attachments')).toHaveLength(1);
  });
});
