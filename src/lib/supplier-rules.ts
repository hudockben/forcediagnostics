// System Admin > Supplier: the shop's suppliers (Supplier ID, Supplier Code,
// Supplier Name, Category Code, Category ID), as its dealer or accounting
// system lists them. What a supplier holds, how what's typed is checked, and
// reading a supplier list from a spreadsheet. No server imports, so the
// browser plans an import the way the server checks it.

import { headingKey } from "@/lib/customer-import-rules";

export const SUPPLIER_FIELDS = ["supplierId", "supplierCode", "supplierName", "categoryCode", "categoryId"] as const;
export type SupplierField = (typeof SUPPLIER_FIELDS)[number];

// The headings, as the list is kept.
export const SUPPLIER_FIELD_LABELS: Record<SupplierField, string> = {
  supplierId: "Supplier ID",
  supplierCode: "Supplier Code",
  supplierName: "Supplier Name",
  categoryCode: "Category Code",
  categoryId: "Category ID",
};

export const SUPPLIER_LIMITS: Record<SupplierField, number> = {
  supplierId: 40,
  supplierCode: 40,
  supplierName: 120,
  categoryCode: 40,
  categoryId: 40,
};

export const SUPPLIER_PAGE_SIZE = 25;

export type SupplierFields = {
  supplierId: string;
  supplierCode: string | null;
  supplierName: string;
  categoryCode: string | null;
  categoryId: string | null;
};

// One line, spaces evened out; nothing a spreadsheet or the database would
// choke on.
const line = (value: unknown) =>
  (typeof value === "string" ? value : typeof value === "number" ? String(value) : "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Supplier IDs are matched without case: "v100" and "V100" are one supplier.
export const supplierKey = (supplierId: string) => line(supplierId).toLowerCase();

// A Supplier ID that's all digits, as a number: a spreadsheet opening the
// list reads "0042" as 42, so an import matches it to the one on file.
export const numericSupplierId = (supplierId: string) => (/^[0-9]{1,15}$/.test(supplierId) ? Number(supplierId) : null);

// What the form (or a row of an import) gives, checked: a Supplier ID and a
// Supplier Name are needed; the codes and the category are optional.
export function checkSupplier(input: Partial<Record<SupplierField, unknown>>): { supplier: SupplierFields } | { error: string } {
  const values = Object.fromEntries(SUPPLIER_FIELDS.map((field) => [field, line(input[field])])) as Record<SupplierField, string>;
  if (!values.supplierId) return { error: "Enter the Supplier ID." };
  if (!values.supplierName) return { error: "Enter the Supplier Name." };
  for (const field of SUPPLIER_FIELDS) {
    if (values[field].length > SUPPLIER_LIMITS[field]) return { error: `The ${SUPPLIER_FIELD_LABELS[field]} is too long (${SUPPLIER_LIMITS[field]} characters at most).` };
  }
  return {
    supplier: {
      supplierId: values.supplierId,
      supplierCode: values.supplierCode || null,
      supplierName: values.supplierName,
      categoryCode: values.categoryCode || null,
      categoryId: values.categoryId || null,
    },
  };
}

// The next Supplier ID when every ID so far is a number: one more than the
// highest. Otherwise none (IDs like "V100" are the shop's own scheme).
export function nextSupplierId(ids: string[]): string | null {
  if (ids.length === 0) return "1";
  if (!ids.every((id) => /^\d{1,15}$/.test(id))) return null;
  const highest = ids.reduce((max, id) => (Number(id) > max ? Number(id) : max), 0);
  const width = Math.max(...ids.map((id) => (id.startsWith("0") ? id.length : 0)));
  return String(highest + 1).padStart(width, "0");
}

// --- Importing a list -----------------------------------------------------------

// The headings each field goes by in supplier (or vendor) lists, best first.
const HEADINGS: Record<SupplierField, string[]> = {
  supplierId: ["supplierid", "vendorid", "suppliernumber", "supplierno", "vendornumber", "vendorno", "suppid", "id"],
  supplierCode: ["suppliercode", "vendorcode", "suppcode", "code"],
  supplierName: ["suppliername", "vendorname", "supplier", "vendor", "name", "company", "companyname"],
  categoryCode: ["categorycode", "catcode", "category", "suppliercategory", "vendorcategory"],
  categoryId: ["categoryid", "catid", "categorynumber", "categoryno", "catno"],
};

const fieldFor = new Map<string, { field: SupplierField; rank: number }>();
for (const field of SUPPLIER_FIELDS) {
  HEADINGS[field].forEach((heading, rank) => {
    if (!fieldFor.has(heading)) fieldFor.set(heading, { field, rank });
  });
}

// Which field each column is, by its heading: each field from one column,
// its best heading winning.
export function supplierColumns(headings: string[]): (SupplierField | null)[] {
  const best = new Map<SupplierField, { column: number; rank: number }>();
  headings.forEach((heading, column) => {
    const found = fieldFor.get(headingKey(heading));
    if (!found) return;
    const taken = best.get(found.field);
    if (!taken || found.rank < taken.rank) best.set(found.field, { column, rank: found.rank });
  });
  const mapping: (SupplierField | null)[] = headings.map(() => null);
  for (const [field, { column }] of best) mapping[column] = field;
  return mapping;
}

// The headings row: the one among the first ten naming the most fields.
export function findSupplierHeader(rows: string[][]): number {
  let best = -1;
  let bestCount = 0;
  for (let index = 0; index < rows.length && index < 10; index++) {
    const count = supplierColumns(rows[index]).filter(Boolean).length;
    if (count > bestCount) [best, bestCount] = [index, count];
  }
  return best;
}

// The apostrophe Download CSV puts before a cell starting with = + - or @
// (so a spreadsheet keeps it as text) comes off again, so the list imports
// back as it was.
const FORMULA_START = /^[=+\-@\t\r]/;
const unguard = (cell: string) => (cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell);

export type SupplierImportRow = SupplierFields & { row: number };
export type SupplierImportNote = { row: number; message: string };
export type SupplierImportPlan = { suppliers: SupplierImportRow[]; notes: SupplierImportNote[]; rowsRead: number };

export const MAX_SUPPLIER_ROWS = 20_000;

// What importing a list would do: one supplier per Supplier ID (a later row
// with the same ID is the one used, and said so), each checked like the
// form checks it. Rows without an ID or a name are left out, with a note.
export function planSupplierImport(rows: string[][], headerRow: number, mapping: (SupplierField | null)[]): SupplierImportPlan {
  const columns = new Map<SupplierField, number>();
  mapping.forEach((field, column) => {
    if (field && !columns.has(field)) columns.set(field, column);
  });
  const byKey = new Map<string, SupplierImportRow>();
  const notes: SupplierImportNote[] = [];
  let rowsRead = 0;
  for (let index = headerRow + 1; index < rows.length; index++) {
    const cells = rows[index];
    if (!cells.some((cell) => cell.trim())) continue;
    const row = index + 1;
    rowsRead++;
    if (rowsRead > MAX_SUPPLIER_ROWS) {
      notes.push({ row, message: `Only the first ${MAX_SUPPLIER_ROWS.toLocaleString("en-US")} rows are imported; split the file to import the rest.` });
      break;
    }
    const input = Object.fromEntries(SUPPLIER_FIELDS.map((field) => [field, unguard(cells[columns.get(field) ?? -1] ?? "")]));
    const checked = checkSupplier(input);
    if ("error" in checked) {
      notes.push({ row, message: `${checked.error.replace(/\.$/, "")}: row left out.` });
      continue;
    }
    const key = supplierKey(checked.supplier.supplierId);
    const earlier = byKey.get(key);
    if (earlier) notes.push({ row, message: `Supplier ID ${checked.supplier.supplierId} is also on row ${earlier.row}: this row is the one used.` });
    // A later row goes in the earlier one's place, keeping the list in order.
    byKey.delete(key);
    byKey.set(key, { ...checked.supplier, row });
  }
  return { suppliers: [...byKey.values()].sort((a, b) => a.row - b.row), notes, rowsRead };
}

export const MAX_SUPPLIER_BATCH = 500;

// What the server did with each supplier of an import batch: added, its
// details changed to the file's, already as the file has it, or left out.
export type SupplierImportOutcome = {
  row: number;
  result: "created" | "updated" | "unchanged" | "failed";
  error: string | null;
};

// The list as CSV, with its headings, for a spreadsheet: a byte order mark
// for Excel, and a cell starting with = + - or @ kept as text.
export function suppliersCsv(suppliers: SupplierFields[]): string {
  const cell = (value: string | null) => {
    const raw = value ?? "";
    const text = FORMULA_START.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    SUPPLIER_FIELDS.map((field) => SUPPLIER_FIELD_LABELS[field]).join(","),
    ...suppliers.map((supplier) => SUPPLIER_FIELDS.map((field) => cell(supplier[field])).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
