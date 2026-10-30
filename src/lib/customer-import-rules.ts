// Importing customers from a spreadsheet (System Admin > Customers >
// Import): reading a CSV or Excel file, working out which column is which,
// checking every row with the same rules as the customer and vehicle forms,
// and grouping rows into customers and their vehicles. No server imports:
// the browser does all of this to show what will happen before anything is
// saved, and the server checks every customer again as it saves them
// (importCustomers in src/lib/customers.ts).

import { CsvError, parseCsv } from "@/lib/csv";
import {
  CUSTOMER_LIMITS,
  RELATION_LABELS,
  checkCustomer,
  checkVehicle,
  type CustomerFields,
  type VehicleFields,
  type VehicleRelation,
} from "@/lib/customer-rules";
import { XlsxError, isZip, readXlsx } from "@/lib/xlsx";

// --- Reading the file ---------------------------------------------------------

export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
// Where to look for the headings: a list often starts with a title line or
// two ("Customer list, printed 10/30/2026").
export const HEADER_SEARCH_ROWS = 10;

export type Sheet = { name: string; rows: string[][] };

const OLD_EXCEL = "This is an old Excel file (.xls) or a password-protected workbook, which can't be read here. In Excel, use Save As > Excel Workbook (.xlsx) or CSV UTF-8, then choose it again.";

// Bytes 0x80-0x9F between letters: in Mac Roman those are accented letters
// (é is 0x8E, ñ 0x96), in Windows-1252 punctuation (Ž, –) that never sits
// inside a word. Letters with accents are 0xC0-0xFF in Windows-1252.
function looksMacRoman(bytes: Uint8Array) {
  const isLetter = (byte: number | undefined) => byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte >= 0x80);
  let mac = 0;
  let windows = 0;
  for (let i = 0; i < bytes.length && i < 256 * 1024; i++) {
    const byte = bytes[i];
    if (byte < 0x80 || !isLetter(bytes[i - 1]) || !isLetter(bytes[i + 1])) continue;
    if (byte <= 0x9f) mac++;
    else if (byte >= 0xc0) windows++;
  }
  return mac > windows;
}

// CSV text, as UTF-8 when it is (a byte order mark is fine), UTF-16 when a
// byte order mark says so (Excel's "Unicode Text"), and otherwise as Excel
// writes plain "CSV": Windows-1252 on Windows, Mac Roman from Excel for Mac
// (told apart by where the accented letters fall). Names with accents come
// out right either way.
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder(looksMacRoman(bytes) ? "macintosh" : "windows-1252").decode(bytes);
  }
}

// Commas, or semicolons or tabs when the first line has more of those
// (outside quotes).
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && (c === "," || c === ";" || c === "\t")) counts[c]++;
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

const isOldExcel = (bytes: Uint8Array) => bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

// The file's sheets: an Excel workbook's visible ones, or a CSV as one.
export async function readSpreadsheet(fileName: string, bytes: Uint8Array): Promise<{ sheets: Sheet[] } | { error: string }> {
  if (bytes.length === 0) return { error: "That file is empty." };
  if (bytes.length > MAX_IMPORT_FILE_BYTES) {
    return { error: `That file is over ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB. Split it into smaller files.` };
  }
  if (isOldExcel(bytes)) return { error: OLD_EXCEL };
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
  if (isZip(bytes)) {
    try {
      const sheets = await readXlsx(bytes);
      if (sheets.length === 0) return { error: "That workbook has no sheets to read (they may all be hidden)." };
      return { sheets };
    } catch (error) {
      if (error instanceof XlsxError) return { error: error.message };
      throw error;
    }
  }
  if (extension === "xlsx" || extension === "xlsm") return { error: "That file isn't a working Excel workbook. Open it in Excel and save it again, or save it as CSV." };
  if (extension === "xlsb" || extension === "ods" || extension === "numbers") {
    return { error: "That kind of spreadsheet can't be read here. Save it as an Excel Workbook (.xlsx) or as CSV, then choose it again." };
  }
  const text = decodeText(bytes);
  // A file of mostly unprintable bytes isn't a spreadsheet saved as text.
  const sample = text.slice(0, 4096);
  if ((sample.match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0) > sample.length / 20) {
    return { error: "That file isn't a CSV or an Excel workbook." };
  }
  try {
    return { sheets: [{ name: fileName, rows: parseCsv(text, detectDelimiter(text)) }] };
  } catch (error) {
    if (error instanceof CsvError) return { error: `That CSV can't be read: ${error.message} (row ${error.row}).` };
    throw error;
  }
}

// --- Columns --------------------------------------------------------------------

export const IMPORT_FIELDS = [
  "name",
  "firstName",
  "lastName",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "notes",
  "relation",
  "relationDate",
  "year",
  "make",
  "model",
  "modelNumber",
  "vin",
  "color",
  "vehicleNotes",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  name: "Name",
  firstName: "First name",
  lastName: "Last name",
  phone: "Phone",
  email: "Email",
  addressLine1: "Street address",
  addressLine2: "Apartment, suite or PO box",
  city: "City",
  state: "State",
  postalCode: "ZIP",
  notes: "Customer notes",
  relation: "Bought, sold to us or service",
  relationDate: "Date bought or sold",
  year: "Year",
  make: "Make",
  model: "Model",
  modelNumber: "Model number",
  vin: "VIN",
  color: "Color",
  vehicleNotes: "Vehicle notes",
};

export const CUSTOMER_IMPORT_FIELDS: ImportField[] = [
  "name",
  "firstName",
  "lastName",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "notes",
];
export const VEHICLE_IMPORT_FIELDS: ImportField[] = [
  "relation",
  "relationDate",
  "year",
  "make",
  "model",
  "modelNumber",
  "vin",
  "color",
  "vehicleNotes",
];

// "Model #" -> "modelnumber", "E-mail Address" -> "emailaddress".
export const headingKey = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/#/g, "number")
    .replace(/[^a-z0-9]+/g, "");

// The headings each field goes by in exports from dealer systems and
// spreadsheets people keep by hand, best first. A customer can have several
// phone numbers: a mobile one is their first, then a plain "Phone", then
// home and work.
const HEADINGS: Record<ImportField, string[]> = {
  name: ["name", "customername", "fullname", "clientname", "contactname", "ownername", "customer", "client", "contact", "owner"],
  firstName: ["firstname", "first", "fname", "givenname", "customerfirstname"],
  lastName: ["lastname", "last", "lname", "surname", "familyname", "customerlastname"],
  phone: [
    "mobile", "mobilephone", "mobilenumber", "cell", "cellphone", "cellnumber",
    "phone", "phonenumber", "primaryphone", "telephone", "tel", "phone1", "daytimephone",
    "homephone", "home", "eveningphone", "workphone", "businessphone", "work", "otherphone",
  ],
  email: ["email", "emailaddress", "mail", "primaryemail", "email1", "otheremail", "secondaryemail", "alternateemail"],
  addressLine1: ["address", "address1", "addressline1", "street", "streetaddress", "mailingaddress", "homeaddress"],
  addressLine2: ["address2", "addressline2", "apt", "apartment", "suite", "aptsuite"],
  city: ["city", "town", "citytown"],
  state: ["state", "province", "st", "stateprovince", "region"],
  postalCode: ["zip", "zipcode", "postalcode", "postcode", "zippostalcode", "zip4"],
  notes: ["notes", "note", "comments", "comment", "customernotes"],
  relation: ["boughtsoldorservice", "relation", "relationship", "dealtype", "transactiontype", "saletype", "boughtorsold", "howtheirs"],
  relationDate: ["datebought", "datesold", "dateboughtorsold", "purchasedate", "saledate", "solddate", "deliverydate", "dealdate", "tradedate", "transactiondate", "date"],
  year: ["year", "modelyear", "yr", "vehicleyear", "unityear"],
  make: ["make", "brand", "manufacturer", "mfr", "vehiclemake", "unitmake"],
  model: ["model", "vehiclemodel", "unitmodel", "modelname", "vehicle", "unit", "unitdescription", "vehicledescription"],
  modelNumber: ["modelnumber", "modelno", "modelcode", "modelnum", "unitmodelnumber"],
  vin: ["vin", "vinnumber", "serial", "serialnumber", "vinserial", "serialvin", "vinserialnumber"],
  color: ["color", "colour", "paint", "vehiclecolor"],
  vehicleNotes: ["vehiclenotes", "unitnotes", "vehiclecomments"],
};

// A heading this loose ("Customer", "Contact") is the name only when there
// are no first and last name columns.
const LOOSE_NAMES = new Set(["customer", "client", "contact", "owner"]);

const headingField = new Map<string, { field: ImportField; rank: number }>();
for (const field of IMPORT_FIELDS) {
  HEADINGS[field].forEach((heading, rank) => {
    if (!headingField.has(heading)) headingField.set(heading, { field, rank });
  });
}

// Where a column goes: a field, and a number. For a vehicle's fields it's
// which of the row's units the column is for (some files put a customer's
// units side by side: "Unit 1 Model", "Unit 2 Model"). For phone and email,
// which choice the column is: a row's first choice that has a number is the
// customer's phone, and the others go in their notes.
export type ColumnTarget = { field: ImportField; unit: number };
export const MAX_UNITS_PER_ROW = 10;

export const isVehicleField = (field: ImportField) => VEHICLE_IMPORT_FIELDS.includes(field);
export const isChoiceField = (field: ImportField) => field === "phone" || field === "email";
// Whether a field's number means anything: other fields come from one column.
export const isNumberedField = (field: ImportField) => isVehicleField(field) || isChoiceField(field);

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const UNIT_WORD = "(?:unit|vehicle|veh|machine)";
const LEADING_NUMBER = new RegExp(`^${UNIT_WORD}?(\\d{1,2})(?:st|nd|rd|th)?${UNIT_WORD}?(.+)$`);
const LEADING_ORDINAL = new RegExp(`^(${ORDINALS.join("|")})${UNIT_WORD}?(.+)$`);
const LEADING_UNIT_WORD = new RegExp(`^${UNIT_WORD}(.+)$`);
const TRAILING_NUMBER = /^(.+?)(\d{1,2})$/;

// A heading by its own words, or with "Unit"/"Vehicle" in front ("Unit
// VIN", "Vehicle Color") or "#"/"No." after ("Cell Phone #", "Serial No.").
function lookUp(key: string): { field: ImportField; rank: number } | undefined {
  const direct = headingField.get(key);
  if (direct) return direct;
  const unitWord = LEADING_UNIT_WORD.exec(key)?.[1];
  const fromUnit = unitWord ? headingField.get(unitWord) : undefined;
  if (fromUnit && isVehicleField(fromUnit.field)) return fromUnit;
  const bare = key.replace(/(?:number|no)$/, "");
  return bare !== key ? headingField.get(bare) : undefined;
}

// What a heading names: "Mobile" is the phone; "Unit 2 Model", "Vehicle 2
// VIN", "2nd Unit Year", "Second Vehicle Make", "Model 2" and "VIN #2" are
// the second unit's; "Phone 2" and "Email 2" another phone number or email.
// "Address 2" stays the second address line.
export function readHeading(heading: string): (ColumnTarget & { rank: number }) | null {
  const key = headingKey(heading);
  const direct = lookUp(key);
  if (direct) return { field: direct.field, unit: 1, rank: direct.rank };
  let unit = 0;
  let rest = "";
  const leading = LEADING_NUMBER.exec(key);
  const ordinal = LEADING_ORDINAL.exec(key);
  const trailing = TRAILING_NUMBER.exec(key);
  if (leading) [unit, rest] = [Number(leading[1]), leading[2]];
  else if (ordinal) [unit, rest] = [ORDINALS.indexOf(ordinal[1]) + 1, ordinal[2]];
  else if (trailing) [unit, rest] = [Number(trailing[2]), trailing[1]];
  const found = rest ? lookUp(rest) : undefined;
  if (!found || unit < 1 || unit > MAX_UNITS_PER_ROW) return null;
  if (!isNumberedField(found.field) && unit !== 1) return null;
  return { field: found.field, unit, rank: found.rank };
}

export const fieldForHeading = (heading: string): ImportField | null => readHeading(heading)?.field ?? null;

export const targetKey = (target: ColumnTarget) => `${target.field}:${isNumberedField(target.field) ? target.unit : 1}`;

// Which field each column goes to, from its heading: each field (and each
// unit's vehicle field) to one column at most, the best heading for it
// winning. Every phone and email column is kept, best first: a mobile
// number before a home or work one.
export function guessMapping(headings: string[]): (ColumnTarget | null)[] {
  const best = new Map<string, { column: number; rank: number; target: ColumnTarget }>();
  const choices: { column: number; rank: number; unit: number; field: ImportField }[] = [];
  headings.forEach((heading, column) => {
    const found = readHeading(heading);
    if (!found) return;
    if (isChoiceField(found.field)) {
      choices.push({ column, rank: found.rank, unit: found.unit, field: found.field });
      return;
    }
    const target = { field: found.field, unit: found.unit };
    const taken = best.get(targetKey(target));
    if (!taken || found.rank < taken.rank) best.set(targetKey(target), { column, rank: found.rank, target });
  });
  const mapping: (ColumnTarget | null)[] = headings.map(() => null);
  for (const { column, target } of best.values()) mapping[column] = target;
  for (const field of ["phone", "email"] as const) {
    choices
      .filter((choice) => choice.field === field)
      .sort((a, b) => a.unit - b.unit || a.rank - b.rank || a.column - b.column)
      .slice(0, MAX_UNITS_PER_ROW)
      .forEach((choice, index) => (mapping[choice.column] = { field, unit: index + 1 }));
  }
  // A Name column and First/Last ones: the Name column is the name, unless
  // its heading is a loose one like "Customer".
  const name = best.get("name:1");
  const parts = ["firstName:1", "lastName:1"].map((key) => best.get(key)?.column).filter((column) => column !== undefined);
  if (name && parts.length > 0) {
    if (LOOSE_NAMES.has(HEADINGS.name[name.rank])) mapping[name.column] = null;
    else for (const column of parts) mapping[column] = null;
  }
  return mapping;
}

// The row with the headings: within the first few, the one whose headings
// name the most fields. When no row's do, the first row is the headings if
// it reads like them (no digits or @ in it); otherwise there are none (-1),
// as in a list kept by hand that starts with its first customer.
export function findHeaderRow(rows: string[][]): number {
  let best = -1;
  let bestCount = 0;
  for (let index = 0; index < rows.length && index < HEADER_SEARCH_ROWS; index++) {
    const count = guessMapping(rows[index]).filter(Boolean).length;
    if (count > bestCount) {
      best = index;
      bestCount = count;
    }
  }
  if (best >= 0) return best;
  const first = rows.findIndex((row) => row.some((cell) => cell.trim()));
  if (first < 0) return -1;
  return rows[first].some((cell) => /[\d@]/.test(cell)) ? -1 : first;
}

// --- Values -----------------------------------------------------------------------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// "Jun", "June" or "Jun." -> 6 ("Sept" is September too); 0 for anything else.
const monthNumber = (name: string) => {
  const key = name.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((month) => month === key || month.slice(0, 3) === key || (month === "september" && key === "sept")) + 1;
};
const TIME = String.raw`(?:[ T]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[ap]\.?m\.?)?(?:\s*(?:z|[+-]\d{2}:?\d{2}))?)?`;
const ISO_DATE = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME}$`, "i");
const US_DATE = new RegExp(String.raw`^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})${TIME}$`, "i");
const DAY_MONTH = new RegExp(String.raw`^(\d{1,2})[\s-]+([a-z]{3,9}\.?)[\s,-]+(\d{4}|\d{2})${TIME}$`, "i");
const MONTH_DAY = new RegExp(String.raw`^([a-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}|\d{2})${TIME}$`, "i");

// "6/24/2024", "06-24-24", "2024-06-24", "24-Jun-24", "Jun 24, 2024", with
// or without a time after it ("6/24/2024 12:00:00 AM", "2024-06-24
// 00:00:00.000", as dealer systems export dates) -> "2024-06-24". Dates
// with slashes are month first, as in the US. Null when it isn't a date.
export function parseImportDate(text: string): string | null {
  const value = text.trim().replace(/\s+/g, " ");
  let year = 0;
  let month = 0;
  let day = 0;
  let match: RegExpExecArray | null;
  if ((match = ISO_DATE.exec(value))) [year, month, day] = match.slice(1, 4).map(Number);
  else if ((match = US_DATE.exec(value))) [month, day, year] = match.slice(1, 4).map(Number);
  else if ((match = DAY_MONTH.exec(value))) [day, month, year] = [Number(match[1]), monthNumber(match[2]), Number(match[3])];
  else if ((match = MONTH_DAY.exec(value))) [month, day, year] = [monthNumber(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  // Two-digit years: "24" is 2024, "98" is 1998.
  if (year < 100) year += year < 50 ? 2000 : 1900;
  if (month < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const RELATION_WORDS: Record<string, VehicleRelation> = {
  bought: "bought",
  boughtfromus: "bought",
  buy: "bought",
  purchase: "bought",
  purchased: "bought",
  new: "bought",
  used: "bought",
  delivered: "bought",
  soldtous: "sold",
  soldtodealer: "sold",
  sellingtous: "sold",
  trade: "sold",
  tradein: "sold",
  traded: "sold",
  tradedin: "sold",
  consigned: "sold",
  consignment: "sold",
  service: "owned",
  serviceonly: "owned",
  theirsforservice: "owned",
  theirs: "owned",
  owned: "owned",
  customerowned: "owned",
  repair: "owned",
};

// "Bought", "Trade-in", "Service" and the like. A bare "Sold" could mean
// either way (a dealer's sales report calls a unit the customer bought
// sold), so it isn't read as either.
export const parseRelation = (text: string): VehicleRelation | null => RELATION_WORDS[headingKey(text)] ?? null;

// A US ZIP code Excel stored as a number lost its leading zeros ("2134"
// for 02134) and a ZIP+4 its dash too ("21341234" for 02134-1234): put
// them back.
export function padZip(text: string) {
  if (/^\d{3,4}$/.test(text)) return text.padStart(5, "0");
  if (/^\d{8,9}$/.test(text)) {
    const digits = text.padStart(9, "0");
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }
  return text;
}

// Lines a report printed to CSV puts between its customers: a page break's
// "Page 1 of 2", totals and its end.
const REPORT_LINE =
  /^(?:page\s+\d+(?:\s+of\s+\d+)?|(?:grand\s+|sub)?totals?\b.*|.*\btotals?\s*:.*|end\s+of\s+(?:the\s+)?(?:report|list|file)\.?|(?:report\s+)?(?:printed|generated|run)\s+(?:on|at|by)\b.*|(?:record|row|customer)\s+count\b.*|\d+\s+(?:records?|rows?|customers?)(?:\s+(?:found|listed|printed))?\.?)$/i;

// --- Planning -------------------------------------------------------------------------

export type ImportCustomer = {
  // The spreadsheet's row numbers this customer came from (1-based, as
  // Excel numbers them).
  rows: number[];
  customer: CustomerFields;
  vehicles: VehicleFields[];
  // Every phone number and email their rows give, which say whether
  // another record is them (see matchCustomer). The first of each is the
  // customer's own.
  phones: string[];
  emails: string[];
};

// What a row's values became: left out entirely (no name), or a value left
// out or read another way.
export type ImportNote = { row: number; message: string; skipped: boolean };

export type ImportPlan = {
  customers: ImportCustomer[];
  notes: ImportNote[];
  rowsRead: number;
  rowsSkipped: number;
  vehicles: number;
};

export type ImportOptions = {
  // Index into rows of the headings, or -1 for none; data starts after it.
  headerRow: number;
  mapping: (ColumnTarget | null)[];
  // For vehicles whose row doesn't say.
  defaultRelation: VehicleRelation;
};

const CUSTOMER_KEYS: (keyof CustomerFields)[] = ["name", "phone", "email", "addressLine1", "addressLine2", "city", "state", "postalCode", "notes"];
const VEHICLE_KEYS: (keyof VehicleFields)[] = ["relation", "relationDate", "year", "make", "model", "modelNumber", "vin", "color", "notes"];

const blankCustomer = (): Record<keyof CustomerFields, string> =>
  Object.fromEntries(CUSTOMER_KEYS.map((key) => [key, ""])) as Record<keyof CustomerFields, string>;
const blankVehicle = (): Record<keyof VehicleFields, string> =>
  Object.fromEntries(VEHICLE_KEYS.map((key) => [key, ""])) as Record<keyof VehicleFields, string>;

const FIELD_NAMES: Record<string, string> = {
  phone: "Phone",
  email: "Email",
  addressLine1: "Street address",
  addressLine2: "Address line 2",
  city: "City",
  state: "State",
  postalCode: "ZIP",
  notes: "Notes",
  relationDate: "Date",
  year: "Year",
  make: "Make",
  model: "Model",
  modelNumber: "Model number",
  vin: "VIN",
  color: "Color",
};

const quoted = (text: string) => `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;

// A phone or email cell with two in it ("814-555-0100 / 555-0101"): the
// first, if the whole won't do.
const firstOf = (text: string) => text.split(/\s*(?:[/;,|]|\bor\b|\band\b)\s*/i)[0]?.trim() ?? "";

// A phone number or email as the form would keep it, or null with why not.
function checkContact(key: "phone" | "email", text: string): { value: string; first?: string } | { error: string } {
  const whole = checkCustomer({ ...blankCustomer(), name: "x", [key]: text });
  if ("customer" in whole) return { value: whole.customer[key]! };
  const first = firstOf(text);
  if (first && first !== text) {
    const part = checkCustomer({ ...blankCustomer(), name: "x", [key]: first });
    if ("customer" in part) return { value: part.customer[key]!, first };
  }
  return { error: whole.error };
}

// Checks one customer's values the way the form does, leaving out (with a
// note) any value the form would refuse, so one bad cell doesn't lose the
// whole customer. Null when there's no name to go by. Most rows pass the
// form's check as they are, so each value is only looked at on its own
// when they don't.
function checkImportCustomer(raw: Record<keyof CustomerFields, string>, note: (message: string) => void): CustomerFields | null {
  const whole = checkCustomer(raw);
  if ("customer" in whole) return whole.customer;
  const values = { ...raw };
  for (const key of CUSTOMER_KEYS) {
    if (key === "name" || !values[key]) continue;
    const checked = checkCustomer({ ...blankCustomer(), name: "x", [key]: values[key] });
    if ("error" in checked) {
      note(`${FIELD_NAMES[key]} ${quoted(values[key])} left out: ${checked.error}`);
      values[key] = "";
    }
  }
  const checked = checkCustomer(values);
  return "customer" in checked ? checked.customer : null;
}

// The same for a vehicle: values the form would refuse are left out, and
// the vehicle too when nothing says what it is.
function checkImportVehicle(raw: Record<keyof VehicleFields, string>, note: (message: string) => void): VehicleFields | null {
  const whole = checkVehicle(raw);
  if ("vehicle" in whole) return whole.vehicle;
  const values = { ...raw };
  for (const key of VEHICLE_KEYS) {
    if (key === "relation" || !values[key]) continue;
    const checked = checkVehicle({ ...blankVehicle(), relation: "bought", model: "x", [key]: values[key] });
    if ("error" in checked) {
      note(`${FIELD_NAMES[key] ?? "Vehicle notes"} ${quoted(values[key])} left out: ${checked.error}`);
      values[key] = "";
    }
  }
  const checked = checkVehicle(values);
  if ("error" in checked) {
    note(`Vehicle left out: ${checked.error}`);
    return null;
  }
  return checked.vehicle;
}

// Names are compared without case or extra spaces.
export const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
export const phoneKey = (phone: string | null) => (phone ? phone.replace(/x.*$/i, "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") : "");
const emailKey = (email: string | null) => (email ? email.toLowerCase() : "");

// Someone as matching sees them: their name, and every phone number and
// email they go by.
export type Who = {
  name: string;
  phone: string | null;
  email: string | null;
  phones?: readonly string[];
  emails?: readonly string[];
};

const phoneKeys = (who: Who) => new Set([who.phone, ...(who.phones ?? [])].map(phoneKey).filter(Boolean));
const emailKeys = (who: Who) => new Set([who.email, ...(who.emails ?? [])].map(emailKey).filter(Boolean));
const shares = (a: Set<string>, b: Set<string>) => [...a].some((key) => b.has(key));

// How two records with the same name stand: "sure" when they share a phone
// number or email; "bare" when neither has any; "could" when nothing tells
// them apart (a number on only one of them, as a customer's later rows
// often leave it out); "no" when their numbers (or emails) all differ,
// which says they're two people.
function relate(a: Who, b: Who): "sure" | "bare" | "could" | "no" {
  if (nameKey(a.name) !== nameKey(b.name)) return "no";
  const [phonesA, phonesB, emailsA, emailsB] = [phoneKeys(a), phoneKeys(b), emailKeys(a), emailKeys(b)];
  if ((phonesA.size && phonesB.size && !shares(phonesA, phonesB)) || (emailsA.size && emailsB.size && !shares(emailsA, emailsB))) return "no";
  if (shares(phonesA, phonesB) || shares(emailsA, emailsB)) return "sure";
  return !phonesA.size && !phonesB.size && !emailsA.size && !emailsB.size ? "bare" : "could";
}

// Whether two records can be one customer: the same name, and no phone
// number or email that says they're two.
export const sameCustomer = (a: Who, b: Who) => relate(a, b) !== "no";

// Which of some customers a record is, if any: one that shares a phone
// number or email with it; else the one just above it in the file, if it
// could be that one; else one with no number either, when it has none;
// else the only one it could be. When several could be, none: it's kept
// apart (and said so) rather than added to the wrong customer. Candidates
// are tried in the order given, so give them in a fixed order.
export function matchCustomer<T extends Who>(candidates: readonly T[], record: Who, nearest?: T | null): { match: T | null; ambiguous: number } {
  const relations = candidates.map((candidate) => relate(candidate, record));
  const sure = candidates.find((_, index) => relations[index] === "sure");
  if (sure) return { match: sure, ambiguous: 0 };
  const could = candidates.filter((_, index) => relations[index] !== "no");
  if (nearest && could.includes(nearest)) return { match: nearest, ambiguous: 0 };
  const bare = candidates.find((_, index) => relations[index] === "bare");
  if (bare) return { match: bare, ambiguous: 0 };
  if (could.length === 1) return { match: could[0], ambiguous: 0 };
  return { match: null, ambiguous: could.length };
}

export const ambiguousNote = (name: string, count: number, where: string) =>
  `${count} customers ${where} are called ${name}, and nothing here says which this is: added as another customer.`;

// Whether two vehicles of one customer are one: the same VIN, or with no
// VIN on either, the same deal, year, make, model and model number, and no
// date or color that differs (two of the same model bought on different
// days are two).
export function sameVehicle(a: VehicleFields, b: VehicleFields) {
  if (a.vin || b.vin) return a.vin === b.vin;
  const key = (v: VehicleFields) => [v.relation, v.year ?? "", v.make?.toLowerCase() ?? "", v.model?.toLowerCase() ?? "", v.modelNumber ?? ""].join("|");
  const differ = (x: string | null, y: string | null) => Boolean(x && y && x.toLowerCase() !== y.toLowerCase());
  return key(a) === key(b) && !differ(a.relationDate, b.relationDate) && !differ(a.color, b.color);
}

// A customer's blank details filled in from another record of them; what
// they had stays.
export function fillBlanks(into: CustomerFields, from: CustomerFields): (keyof CustomerFields)[] {
  const filled: (keyof CustomerFields)[] = [];
  for (const key of CUSTOMER_KEYS) {
    if (key !== "name" && !into[key] && from[key]) {
      into[key] = from[key];
      filled.push(key);
    }
  }
  return filled;
}

// What importing the sheet would do: one customer per person, with all
// their units, each checked like the forms check them. A customer's units
// can be on rows of their own (their name on each, with or without their
// phone number again; see matchCustomer), on rows with nothing about a
// customer under theirs (another unit of the customer above, as some dealer
// systems list them), or side by side in one row (Unit 1, Unit 2 columns).
// A report's repeated headings and its page and total lines are left out.
export function planImport(rows: string[][], options: ImportOptions): ImportPlan {
  const { headerRow, mapping, defaultRelation } = options;
  const headings = headerRow >= 0 ? (rows[headerRow] ?? []) : [];
  const headingKeys = headings.map(headingKey);
  // The first column for each field (and unit or choice).
  const columns = new Map<string, number>();
  mapping.forEach((target, column) => {
    if (target && !columns.has(targetKey(target))) columns.set(targetKey(target), column);
  });
  const numbersOf = (field: ImportField) =>
    [...new Set(mapping.flatMap((target) => (target && target.field === field ? [target.unit] : [])))].sort((a, b) => a - b);
  // The units a row can hold, and the phone and email columns in order.
  const units = [...new Set(VEHICLE_IMPORT_FIELDS.flatMap(numbersOf))].sort((a, b) => a - b);
  const choices = { phone: numbersOf("phone"), email: numbersOf("email") };
  const customers: ImportCustomer[] = [];
  const byName = new Map<string, ImportCustomer[]>();
  const notes: ImportNote[] = [];
  let rowsRead = 0;
  let rowsSkipped = 0;
  let previous: ImportCustomer | null = null;

  for (let index = headerRow + 1; index < rows.length; index++) {
    const cells = rows[index];
    const value = (field: ImportField, unit = 1) => {
      const column = columns.get(`${field}:${isNumberedField(field) ? unit : 1}`);
      return column === undefined ? "" : (cells[column] ?? "").replace(/\u0000/g, "").trim();
    };
    const filled = cells.filter((cell) => cell.trim());
    if (filled.length === 0) continue;
    const row = index + 1;
    const note = (message: string, skipped = false) => notes.push({ row, message, skipped });
    // A report repeats its headings after each page break.
    if (headingKeys.length > 0 && filled.length >= 2 && cells.every((cell, column) => !cell.trim() || headingKey(cell) === headingKeys[column])) {
      note("The headings again (a report's page break): left out.", true);
      previous = null;
      continue;
    }
    if (filled.length === 1 && REPORT_LINE.test(filled[0].trim())) {
      note(`${quoted(filled[0].trim())} looks like a line of the report, not a customer: left out.`, true);
      previous = null;
      continue;
    }
    rowsRead++;
    if (rowsRead > MAX_IMPORT_ROWS) {
      notes.push({ row, message: `Only the first ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows are imported; split the file to import the rest.`, skipped: true });
      rowsSkipped += rows.length - index;
      break;
    }

    const raw = blankCustomer();
    raw.name = value("name") || [value("firstName"), value("lastName")].filter(Boolean).join(" ");
    raw.addressLine1 = value("addressLine1");
    raw.addressLine2 = value("addressLine2");
    raw.city = value("city");
    raw.state = value("state");
    raw.postalCode = padZip(value("postalCode"));
    const extraNotes: string[] = [];
    // Phone numbers and emails: the first choice with one is theirs; the
    // others go in their notes, by their column's heading.
    const contacts = { phone: [] as string[], email: [] as string[] };
    for (const key of ["phone", "email"] as const) {
      for (const choice of choices[key]) {
        const text = value(key, choice);
        if (!text) continue;
        const checked = checkContact(key, text);
        const heading = headings[columns.get(`${key}:${choice}`) ?? -1]?.trim() || FIELD_NAMES[key];
        if ("error" in checked) {
          note(`${heading} ${quoted(text)} left out: ${checked.error}`);
          continue;
        }
        if (checked.first) note(`${heading} ${quoted(text)}: kept the first, ${quoted(checked.first)}.`);
        const keyOf = key === "phone" ? phoneKey : emailKey;
        if (contacts[key].some((other) => keyOf(other) === keyOf(checked.value))) continue;
        if (contacts[key].length > 0) extraNotes.push(`${heading}: ${checked.value}`);
        contacts[key].push(checked.value);
      }
    }
    raw.phone = contacts.phone[0] ?? "";
    raw.email = contacts.email[0] ?? "";
    raw.notes = [value("notes"), ...extraNotes].filter(Boolean).join("\n");

    // Each unit in the row with anything said about it.
    const rowUnits = units.flatMap((unit) => {
      const vehicleRaw = blankVehicle();
      vehicleRaw.year = value("year", unit).replace(/\.0+$/, "");
      vehicleRaw.make = value("make", unit);
      vehicleRaw.model = value("model", unit);
      vehicleRaw.modelNumber = value("modelNumber", unit);
      vehicleRaw.vin = value("vin", unit);
      vehicleRaw.color = value("color", unit);
      vehicleRaw.notes = value("vehicleNotes", unit);
      const described = (["year", "make", "model", "modelNumber", "vin", "color", "notes"] as const).some((key) => vehicleRaw[key]);
      return described ? [{ unit, vehicleRaw }] : [];
    });
    const hasVehicle = rowUnits.length > 0;
    const hasCustomer = CUSTOMER_KEYS.some((key) => raw[key]);

    let customer: ImportCustomer | null;
    if (!hasCustomer && hasVehicle && previous) {
      customer = previous;
      customer.rows.push(row);
    } else {
      if (!raw.name) {
        note(hasCustomer || hasVehicle ? "No name: row left out." : "Nothing to import in this row.", true);
        rowsSkipped++;
        previous = null;
        continue;
      }
      const checked = checkImportCustomer(raw, note);
      if (!checked) {
        note(`Name ${quoted(raw.name)} is too long: row left out.`, true);
        rowsSkipped++;
        previous = null;
        continue;
      }
      // Matched by what this row itself says, not by details other rows
      // filled in, so the order of the rows doesn't decide who is who.
      const record: Who = { name: checked.name, phone: null, email: null, phones: contacts.phone, emails: contacts.email };
      const key = nameKey(checked.name);
      const sameName = (byName.get(key) ?? []).map((entry) => ({ name: entry.customer.name, phone: null, email: null, phones: entry.phones, emails: entry.emails, entry }));
      const found = matchCustomer(sameName, record, sameName.find((candidate) => candidate.entry === previous));
      customer = found.match?.entry ?? null;
      if (found.ambiguous > 1) note(ambiguousNote(checked.name, found.ambiguous, "in this file"));
      if (customer) {
        const notesBefore = customer.customer.notes;
        fillBlanks(customer.customer, checked);
        // Each row's notes are kept, once.
        if (notesBefore && checked.notes && !notesBefore.includes(checked.notes)) {
          const together = `${notesBefore}\n${checked.notes}`;
          if (together.length <= CUSTOMER_LIMITS.notes) customer.customer.notes = together;
          else note(`Notes ${quoted(checked.notes)} left out: the customer's notes are full.`);
        }
        for (const phone of contacts.phone) if (!customer.phones.some((other) => phoneKey(other) === phoneKey(phone))) customer.phones.push(phone);
        for (const email of contacts.email) if (!customer.emails.some((other) => emailKey(other) === emailKey(email))) customer.emails.push(email);
        customer.rows.push(row);
      } else {
        customer = { rows: [row], customer: checked, vehicles: [], phones: [...contacts.phone], emails: [...contacts.email] };
        customers.push(customer);
        byName.set(key, [...(byName.get(key) ?? []), customer]);
      }
    }
    previous = customer;

    for (const { unit, vehicleRaw } of rowUnits) {
      // Notes say which unit when a row can hold several.
      const unitNote = (message: string) => note(units.length > 1 ? `Unit ${unit}: ${message}` : message);
      const relationText = value("relation", unit);
      vehicleRaw.relation = defaultRelation;
      if (relationText) {
        const read = parseRelation(relationText);
        if (read) vehicleRaw.relation = read;
        else unitNote(`${quoted(relationText)} isn't Bought, Sold to us or Service: counted as ${RELATION_LABELS[defaultRelation]}.`);
      }
      const dateText = value("relationDate", unit);
      if (dateText) {
        const date = parseImportDate(dateText);
        if (date) vehicleRaw.relationDate = date;
        else unitNote(`Date ${quoted(dateText)} left out: it isn't a date (write it as 6/24/2024).`);
      }
      const vehicle = checkImportVehicle(vehicleRaw, unitNote);
      if (vehicle && !customer.vehicles.some((other) => sameVehicle(other, vehicle))) customer.vehicles.push(vehicle);
    }
  }

  return {
    customers,
    notes,
    rowsRead,
    rowsSkipped,
    vehicles: customers.reduce((sum, customer) => sum + customer.vehicles.length, 0),
  };
}

// --- Sending --------------------------------------------------------------------------

// Customers go to the server in batches, well under the 1 MB Server Action
// limit, one batch at a time. A customer with more units than one batch
// takes is sent in parts, each matched to the same customer.
export const IMPORT_BATCH_BYTES = 256 * 1024;
export const MAX_IMPORT_BATCH_CUSTOMERS = 250;
export const MAX_IMPORT_VEHICLES_PER_CUSTOMER = 100;
export const MAX_IMPORT_BATCH_VEHICLES = 1000;

export function importBatches(customers: ImportCustomer[]): ImportCustomer[][] {
  const parts = customers.flatMap((customer) => {
    if (customer.vehicles.length <= MAX_IMPORT_VEHICLES_PER_CUSTOMER) return [customer];
    const pieces: ImportCustomer[] = [];
    for (let at = 0; at < customer.vehicles.length; at += MAX_IMPORT_VEHICLES_PER_CUSTOMER) {
      pieces.push({ ...customer, vehicles: customer.vehicles.slice(at, at + MAX_IMPORT_VEHICLES_PER_CUSTOMER) });
    }
    return pieces;
  });
  const batches: ImportCustomer[][] = [];
  let batch: ImportCustomer[] = [];
  let bytes = 0;
  let vehicles = 0;
  for (const customer of parts) {
    const size = JSON.stringify(customer).length * 2;
    const full =
      bytes + size > IMPORT_BATCH_BYTES ||
      batch.length >= MAX_IMPORT_BATCH_CUSTOMERS ||
      vehicles + customer.vehicles.length > MAX_IMPORT_BATCH_VEHICLES;
    if (batch.length > 0 && full) {
      batches.push(batch);
      batch = [];
      bytes = 0;
      vehicles = 0;
    }
    batch.push(customer);
    bytes += size;
    vehicles += customer.vehicles.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// What the server did with each customer of a batch.
export type ImportOutcome = {
  rows: number[];
  // created: a new customer; matched: already on file (see matchCustomer),
  // their blank details filled in; failed: left out, with why.
  result: "created" | "matched" | "failed";
  customerId: string | null;
  filled: (keyof CustomerFields)[];
  vehiclesAdded: number;
  vehiclesOnFile: number;
  error: string | null;
  // Something to look at even though it went in (it could have been one of
  // several customers on file).
  note: string | null;
};

// The import's report as CSV, for the rows that need a look: what happened
// to each, by row. It starts with a byte order mark so Excel reads it as
// UTF-8 (names with accents, the quotes in the notes).
export function reportCsv(notes: ImportNote[]): string {
  const field = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = ["Row,What happened", ...[...notes].sort((a, b) => a.row - b.row).map((note) => `${note.row},${field(note.message)}`)];
  return `﻿${lines.join("\r\n")}\r\n`;
}

// A file to start from, with the headings the import knows best.
export const TEMPLATE_CSV = [
  "Name,Phone,Email,Street address,City,State,ZIP,Bought sold or service,Date bought or sold,Year,Make,Model,Model number,VIN,Color",
  "Dana Whitfield,(814) 555-0199,dana@example.com,412 Logan Blvd,Altoona,PA,16602,Bought,6/24/2024,2021,Polaris,Sportsman 850,A21SXZ85A1,,Sage Green",
  "Dana Whitfield,(814) 555-0199,dana@example.com,412 Logan Blvd,Altoona,PA,16602,Sold to us,6/24/2024,2016,Polaris,Ranger 570,,,",
  "Rhett Carver,(814) 555-0123,,,Hollidaysburg,PA,,Service,,2019,Polaris,RZR XP 1000,Z19VDE99AM,,",
].join("\r\n");
