/**
 * formAgent/payload.ts — client-side validation and multipart assembly for
 * a SyteLine Form AI Agent customization request.
 *
 * Mirrors the backend's input contract (backend/src/formAgent/types.ts):
 * formName, title, instructions[], formXml (.xml), idoPropertiesCsv (.csv),
 * sqlColumnsCsv (.csv), attachments[] (optional). The backend is the
 * authority on sizes and shapes; this module catches the obvious mistakes
 * early with friendly messages.
 */

export interface NewCustomizationValues {
  formName: string;
  title: string;
  requestedBy: string;
  instructionsText: string;
  formXml: File | null;
  idoPropertiesCsv: File | null;
  sqlColumnsCsv: File | null;
  attachments: File[];
}

export const FORM_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

export function emptyValues(): NewCustomizationValues {
  return {
    formName: '',
    title: '',
    requestedBy: '',
    instructionsText: '',
    formXml: null,
    idoPropertiesCsv: null,
    sqlColumnsCsv: null,
    attachments: [],
  };
}

/** One instruction per non-empty line. */
export function parseInstructions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function checkExtension(file: File, ext: string, label: string, errors: string[]): void {
  if (!file.name.toLowerCase().endsWith(ext)) {
    errors.push(`${label} must be a ${ext} file (got "${file.name}")`);
  }
}

/** Returns a list of human-readable validation errors (empty = valid). */
export function validateNewCustomization(values: NewCustomizationValues): string[] {
  const errors: string[] = [];
  const formName = values.formName.trim();
  if (!formName) {
    errors.push('Form name is required (the SyteLine form name, e.g. PurchaseOrderDetailReportViewer)');
  } else if (!FORM_NAME_PATTERN.test(formName)) {
    errors.push('Form name may only contain letters, digits, and underscores');
  }
  if (!values.title.trim()) errors.push('Title is required (used for the project and the review PR)');
  if (parseInstructions(values.instructionsText).length === 0) {
    errors.push('Add at least one instruction describing the customization');
  }
  if (!values.formXml) {
    errors.push('The current form .XML is required (the FormSync export)');
  } else {
    checkExtension(values.formXml, '.xml', 'Form XML', errors);
  }
  if (!values.idoPropertiesCsv) {
    errors.push('The IDO properties CSV is required');
  } else {
    checkExtension(values.idoPropertiesCsv, '.csv', 'IDO properties CSV', errors);
  }
  if (!values.sqlColumnsCsv) {
    errors.push('The SQL columns CSV is required');
  } else {
    checkExtension(values.sqlColumnsCsv, '.csv', 'SQL columns CSV', errors);
  }
  const seen = new Set<string>();
  for (const file of values.attachments) {
    if (seen.has(file.name)) errors.push(`Duplicate attachment filename: "${file.name}"`);
    seen.add(file.name);
  }
  if (values.attachments.length > 20) errors.push('At most 20 attachments are accepted');
  return errors;
}

/**
 * Assemble the multipart request the backend accepts: file parts named
 * formXml / idoPropertiesCsv / sqlColumnsCsv / attachments, text fields
 * formName / title / requestedBy / instructions (JSON array).
 */
export function buildCreateFormData(values: NewCustomizationValues): FormData {
  const form = new FormData();
  form.append('formName', values.formName.trim());
  form.append('title', values.title.trim());
  if (values.requestedBy.trim()) form.append('requestedBy', values.requestedBy.trim());
  form.append('instructions', JSON.stringify(parseInstructions(values.instructionsText)));
  form.append('formXml', values.formXml as File, (values.formXml as File).name);
  form.append('idoPropertiesCsv', values.idoPropertiesCsv as File, (values.idoPropertiesCsv as File).name);
  form.append('sqlColumnsCsv', values.sqlColumnsCsv as File, (values.sqlColumnsCsv as File).name);
  for (const file of values.attachments) {
    form.append('attachments', file, file.name);
  }
  return form;
}
