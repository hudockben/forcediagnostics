// Importing the Sticker & Plate log from a spreadsheet (Sticker & Plate log >
// Import): which column is which, the plate classification as people write
// it, and what importing the rows would do, each row checked as the log's
// form checks it. No server imports: the browser plans the import to show
// what will happen, and the server checks every row again as it saves them
// (importStickers in src/lib/sticker-log.ts).

import { HEADER_SEARCH_ROWS, headingKey, nameKey } from "@/lib/customer-import-rules";
import { checkCustomer, normalizePhone, type CustomerFields } from "@/lib/customer-rules";
import { checkStickerEntry, normalizeSticker, type PlateClass } from "@/lib/sticker-log-rules";

export const STICKER_IMPORT_FIELDS = ["stickerNumber", "customerName", "phone", "plateClass"] as const;
export type StickerImportField = (typeof STICKER_IMPORT_FIELDS)[number];

// The log's own headings, as its Download CSV has them.
export const STICKER_IMPORT_LABELS: Record<StickerImportField, string> = {
  stickerNumber: "Sticker #",
  customerName: "Customer Name",
  phone: "Phone",
  plateClass: "Plate Classification",
};

// The columns a list needs. Its Plate Classification comes from a column
// or, for a list of one class (the stickers on one list, the plates on
// another), is picked on the page; a phone number only helps find the
// customer.
export const REQUIRED_STICKER_FIELDS: StickerImportField[] = ["stickerNumber", "customerName"];

// Whom a name is, either way round: "Rudd, Benjamin" (last name first, one
// comma) is Benjamin Rudd. Without case or extra spaces, as nameKey.
// importStickers works the same out in SQL to find customers on file.
export function personKey(name: string): string {
  const key = nameKey(name);
  const parts = key.split(",").map((part) => part.trim());
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : key;
}

// The headings each field goes by, best first ("Sticker #" is
// "stickernumber" to headingKey).
const HEADINGS: Record<StickerImportField, string[]> = {
  stickerNumber: [
    "stickernumber", "sticker", "stickerno", "stickernum", "stickerplatenumber", "stickerorplatenumber",
    "decalnumber", "decal", "decalno", "registrationsticker", "regsticker",
    "registrationnumber", "registrationno", "regnumber", "regno", "platenumber", "plateno", "plate",
  ],
  customerName: ["customername", "customer", "name", "fullname", "ownername", "owner", "registeredowner", "buyername", "buyer", "purchaser", "clientname", "client"],
  phone: ["phone", "phonenumber", "customerphone", "mobile", "mobilephone", "cell", "cellphone", "telephone", "tel", "homephone", "workphone"],
  plateClass: ["plateclassification", "plateclass", "classification", "class", "platetype", "stickerclass"],
};

const fieldFor = new Map<string, { field: StickerImportField; rank: number }>();
for (const field of STICKER_IMPORT_FIELDS) {
  HEADINGS[field].forEach((heading, rank) => {
    if (!fieldFor.has(heading)) fieldFor.set(heading, { field, rank });
  });
}

// Which field each column is, by its heading: each field from one column,
// its best heading winning. Anything else ("Logged", "Logged by") is left
// out.
export function stickerColumns(headings: string[]): (StickerImportField | null)[] {
  const best = new Map<StickerImportField, { column: number; rank: number }>();
  headings.forEach((heading, column) => {
    const found = fieldFor.get(headingKey(heading));
    if (!found) return;
    const taken = best.get(found.field);
    if (!taken || found.rank < taken.rank) best.set(found.field, { column, rank: found.rank });
  });
  const mapping: (StickerImportField | null)[] = headings.map(() => null);
  for (const [field, { column }] of best) mapping[column] = field;
  return mapping;
}

// The headings row: the one among the first ten naming the most fields
// (a title line or two above it is fine). -1 when none does.
export function findStickerHeader(rows: string[][]): number {
  let best = -1;
  let bestCount = 0;
  for (let index = 0; index < rows.length && index < HEADER_SEARCH_ROWS; index++) {
    const count = stickerColumns(rows[index]).filter(Boolean).length;
    if (count > bestCount) [best, bestCount] = [index, count];
  }
  return best;
}

const CLASS_WORDS: Record<string, PlateClass> = { "1": 1, "2": 2, i: 1, ii: 2, one: 1, two: 2 };

// "1", "Class 2", "CLASS II", "Plate class #1", "2.0" (a number from Excel)
// -> 1 or 2. Null for anything else.
export function parsePlateClass(text: string): PlateClass | null {
  const key = text
    .toLowerCase()
    .replace(/\b(?:plate|classification|class|type)\b|\bno\b\.?|[#:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^0+(?=\d)/, "")
    .replace(/^(\d)\.0+$/, "$1");
  return CLASS_WORDS[key] ?? null;
}

// One row of an import, as the browser sends it: the sticker number as the
// log keeps it, the class, and whose it is.
export type StickerImportRow = {
  row: number;
  stickerNumber: string;
  customerName: string;
  phone: string | null;
  plateClass: PlateClass;
};
export type StickerImportNote = { row: number; message: string };
export type StickerImportPlan = { stickers: StickerImportRow[]; notes: StickerImportNote[]; rowsRead: number };

export type StickerImportEntry = { stickerNumber: string; plateClass: PlateClass; customer: CustomerFields };

// A row checked the way the log's form checks a sticker and Customers
// checks a name and a phone number. The server checks each row it's sent
// with this, whatever the browser did.
export function checkStickerImport(input: unknown): { entry: StickerImportEntry } | { error: string } {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sticker = checkStickerEntry({ stickerNumber: value.stickerNumber, plateClass: value.plateClass });
  if ("error" in sticker) return sticker;
  const customer = checkCustomer({
    name: value.customerName,
    phone: value.phone ?? "",
    email: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    notes: "",
  });
  if ("error" in customer) return customer;
  return { entry: { ...sticker.entry, customer: customer.customer } };
}

export const MAX_STICKER_IMPORT_ROWS = 20_000;

const quoted = (text: string) => `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;

// What importing the rows would do: one sticker per row, in the file's
// order. A row with no class takes the one picked on the page, if any. A
// row without a Sticker #, a Customer Name or a class of 1 or 2 is left
// out, with a note, and so is a sticker number already on an earlier row
// (only the first is logged). A phone number that isn't one is left out,
// keeping the row.
export function planStickerImport(
  rows: string[][],
  headerRow: number,
  mapping: (StickerImportField | null)[],
  { plateClass: picked = null }: { plateClass?: PlateClass | null } = {},
): StickerImportPlan {
  const columns = new Map<StickerImportField, number>();
  mapping.forEach((field, column) => {
    if (field && !columns.has(field)) columns.set(field, column);
  });
  const cell = (cells: string[], field: StickerImportField) => (cells[columns.get(field) ?? -1] ?? "").trim();
  const stickers: StickerImportRow[] = [];
  const byNumber = new Map<string, StickerImportRow>();
  const notes: StickerImportNote[] = [];
  let rowsRead = 0;
  for (let index = headerRow + 1; index < rows.length; index++) {
    const cells = rows[index];
    if (!cells.some((value) => value.trim())) continue;
    const row = index + 1;
    rowsRead++;
    if (rowsRead > MAX_STICKER_IMPORT_ROWS) {
      notes.push({ row, message: `Only the first ${MAX_STICKER_IMPORT_ROWS.toLocaleString("en-US")} rows are imported; split the file to import the rest.` });
      break;
    }
    const note = (message: string) => notes.push({ row, message });
    const [number, name, phone, plate] = [cell(cells, "stickerNumber"), cell(cells, "customerName"), cell(cells, "phone"), cell(cells, "plateClass")];
    if (!normalizeSticker(number)) {
      note("No Sticker #: row left out.");
      continue;
    }
    if (!name) {
      note("No Customer Name: row left out.");
      continue;
    }
    const plateClass = plate ? parsePlateClass(plate) : picked;
    if (plateClass === null) {
      note(plate ? `Plate Classification ${quoted(plate)} isn't 1 or 2: row left out.` : "No Plate Classification: row left out.");
      continue;
    }
    const sticker = checkStickerEntry({ stickerNumber: number, plateClass });
    if ("error" in sticker) {
      note(`Sticker # ${quoted(number)}: ${sticker.error} Row left out.`);
      continue;
    }
    const typedPhone = normalizePhone(phone);
    if ("error" in typedPhone) note(`Phone ${quoted(phone)} left out: ${typedPhone.error}`);
    const checked = checkStickerImport({ stickerNumber: number, customerName: name, phone: "error" in typedPhone ? "" : phone, plateClass });
    if ("error" in checked) {
      note(`Customer Name ${quoted(name)}: ${checked.error} Row left out.`);
      continue;
    }
    const { stickerNumber, customer } = checked.entry;
    const earlier = byNumber.get(stickerNumber);
    if (earlier) {
      note(
        personKey(earlier.customerName) === personKey(customer.name) && earlier.plateClass === plateClass
          ? `Sticker ${stickerNumber} is on row ${earlier.row} too: logged once.`
          : `Sticker ${stickerNumber} is also on row ${earlier.row}, for ${earlier.customerName} (Class ${earlier.plateClass}): only row ${earlier.row} is logged.`,
      );
      continue;
    }
    const entry: StickerImportRow = { row, stickerNumber, customerName: customer.name, phone: customer.phone, plateClass };
    byNumber.set(stickerNumber, entry);
    stickers.push(entry);
  }
  return { stickers, notes, rowsRead };
}

export const MAX_STICKER_IMPORT_BATCH = 500;

// What the server did with each row of an import batch.
export type StickerImportOutcome = {
  row: number;
  // logged: added to the log; already: that sticker is in the log already
  // (left as it is); failed: left out.
  result: "logged" | "already" | "failed";
  // For a sticker logged: its customer was found on Customers, or added.
  customer: "found" | "added" | null;
  // Why a row was left out, or how the log's entry differs from the file.
  message: string | null;
};
