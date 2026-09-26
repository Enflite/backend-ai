/**
 * naming.ts — Enflite UET naming standard (Form-Project-Templates SOP §3).
 *
 * `ENF` marks Enflite-created objects; anything without it is Infor's.
 *
 * | Object                  | Pattern              | Example                |
 * |-------------------------|----------------------|------------------------|
 * | UET User Field          | `Uf_ENF_<Name>`      | `Uf_ENF_Test`          |
 * | UET Class               | `ENF_<Area>`         | `ENF_Lot`              |
 * | User Defined Type       | `ENF_<Name>`         | `ENF_ZeroTime`         |
 * | Form component for a    | `Uf<Name>Static/Edit`| `UfTestStatic`         |
 * |   UET field             | `/GridCol`           |                        |
 *
 * A form binds to a UET field as `object.<table alias>Uf_ENF_<Name>`
 * (e.g. `object.lotUf_ENF_Test`). The alias is confirmed in Design Mode
 * (Staging check A) and is ALWAYS surfaced as an assumption until then.
 */

/** `Uf_ENF_Test` -> `Test`; `Uf_Test` -> `Test`. */
export function stripUetPrefix(fieldName: string): string {
  return fieldName.replace(/^Uf_ENF_/, '').replace(/^Uf_/, '');
}

/** "Date Of Manufacture" -> "DateOfManufacture"; "test" -> "Test". */
export function toPascalCase(label: string): string {
  const words = label
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0);
  if (words.length === 0) throw new Error(`cannot derive a name from label "${label}"`);
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** "Test" -> `Uf_ENF_Test`. */
export function uetFieldName(label: string): string {
  return `Uf_ENF_${toPascalCase(label)}`;
}

/** "Lot" -> `ENF_Lot`. */
export function uetClassName(area: string): string {
  return `ENF_${toPascalCase(area)}`;
}

/** "Test" -> `ENF_Test` (User Defined Type for a fixed drop-down list). */
export function userDefinedTypeName(name: string): string {
  return `ENF_${toPascalCase(name)}`;
}

/**
 * Component name stem for a UET field: `Uf_ENF_Test` -> `UfTest`, giving
 * `UfTestStatic`, `UfTestEdit`, `UfTestGridCol`.
 */
export function componentStem(fieldName: string): string {
  return `Uf${stripUetPrefix(fieldName)}`;
}

export interface ComponentNames {
  static: string;
  edit: string;
  gridCol: string;
}

export function componentNames(fieldName: string): ComponentNames {
  const stem = componentStem(fieldName);
  return { static: `${stem}Static`, edit: `${stem}Edit`, gridCol: `${stem}GridCol` };
}

/**
 * Form binding for a UET field: `object.<alias>Uf_ENF_<Name>`.
 * The alias is an assumption until Staging check A confirms it.
 */
export function formBinding(alias: string, fieldName: string): string {
  return `object.${alias}${fieldName}`;
}

/**
 * Hard guard: new fields are UET-only and must follow the Enflite naming
 * standard. Never bind a new component to an Infor-owned property.
 */
export function assertUetFieldName(fieldName: string): void {
  if (!/^Uf_ENF_[A-Z][A-Za-z0-9]*$/.test(fieldName)) {
    throw new Error(
      `invalid UET user field name "${fieldName}": expected Uf_ENF_<PascalCaseName>. ` +
        'New fields are UET-only; never change Infor-owned objects.',
    );
  }
}

/** Hard guard: UET class names follow `ENF_<Area>`. */
export function assertUetClassName(className: string): void {
  if (!/^ENF_[A-Z][A-Za-z0-9]*$/.test(className)) {
    throw new Error(
      `invalid UET class name "${className}": expected ENF_<PascalCaseArea>.`,
    );
  }
}
