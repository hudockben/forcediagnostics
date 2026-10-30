// Importing customers from a spreadsheet (System Admin > Customers >
// Import): reading a CSV or Excel file, working out which column is which,
// checking every row with the same rules as the customer and vehicle forms,
// and grouping rows into customers and their vehicles. No server imports:
// the browser does all of this to show what will happen before anything is
// saved, and the server checks every customer again as it saves them
// (importCustomers in src/lib/customers.ts).

import { CsvError, parseCsv } from "@/lib/csv";
import {
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

// CSV text, as UTF-8 when it is (a byte order mark is fine), UTF-16 when a
// byte order mark says so (Excel's "Unicode Text"), and otherwise Windows-1252,
// what Excel writes for plain "CSV (Comma delimited)" on Windows: names
// with accents come out right either way.
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
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
// spreadsheets people keep by hand, best first. Phone has several: a mobile
// number comes before a home or work one.
const HEADINGS: Record<ImportField, string[]> = {
  name: ["name", "customername", "customer", "fullname", "client", "clientname", "contactname", "contact", "owner", "ownername"],
  firstName: ["firstname", "first", "fname", "givenname", "customerfirstname"],
  lastName: ["lastname", "last", "lname", "surname", "familyname", "customerlastname"],
  phone: [
    "mobile", "mobilephone", "mobilenumber", "cell", "cellphone", "cellnumber",
    "phone", "phonenumber", "primaryphone", "telephone", "tel", "phone1", "daytimephone",
    "homephone", "workphone", "businessphone",
  ],
  email: ["email", "emailaddress", "mail", "primaryemail", "email1"],
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
  vin: ["vin", "vinnumber", "serial", "serialnumber", "vinserial", "serialvin"],
  color: ["color", "colour", "paint", "vehiclecolor"],
  vehicleNotes: ["vehiclenotes", "unitnotes", "vehiclecomments"],
};

const headingField = new Map<string, { field: ImportField; rank: number }>();
for (const field of IMPORT_FIELDS) {
  HEADINGS[field].forEach((heading, rank) => {
    if (!headingField.has(heading)) headingField.set(heading, { field, rank });
  });
}

export const fieldForHeading = (heading: string): ImportField | null => headingField.get(headingKey(heading))?.field ?? null;

// Which field each column goes to, from its heading: each field to one
// column at most, the best heading for it winning (a "Mobile" column over a
// "Home Phone" one).
export function guessMapping(headings: string[]): (ImportField | null)[] {
  const best = new Map<ImportField, { column: number; rank: number }>();
  headings.forEach((heading, column) => {
    const found = headingField.get(headingKey(heading));
    if (!found) return;
    const taken = best.get(found.field);
    if (!taken || found.rank < taken.rank) best.set(found.field, { column, rank: found.rank });
  });
  const mapping: (ImportField | null)[] = headings.map(() => null);
  for (const [field, { column }] of best) mapping[column] = field;
  // A Name column and First/Last ones: the Name column is the name.
  if (best.has("name")) {
    for (const field of ["firstName", "lastName"] as const) {
      const column = best.get(field)?.column;
      if (column !== undefined) mapping[column] = null;
    }
  }
  return mapping;
}

// The row with the headings: within the first few, the one whose headings
// name the most fields; the first row with anything in it when none do.
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
  return first >= 0 ? first : 0;
}

// --- Values -----------------------------------------------------------------------

// "6/24/2024", "06-24-24", "2024-06-24" (or "2024-06-24 13:05", as an Excel
// date cell reads) -> "2024-06-24". Dates with slashes are month first, as
// in the US. Null when it isn't a date.
export function parseImportDate(text: string): string | null {
  const value = text.trim();
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(value);
  const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(value);
  if (iso) {
    [year, month, day] = iso.slice(1, 4).map(Number);
  } else if (us) {
    [month, day, year] = us.slice(1, 4).map(Number);
    // Two-digit years: "24" is 2024, "98" is 1998.
    if (us[3].length === 2) year += year < 50 ? 2000 : 1900;
  } else {
    return null;
  }
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
// for 02134): put them back.
const padZip = (text: string) => (/^\d{3,4}$/.test(text) ? text.padStart(5, "0") : text);

// --- Planning -------------------------------------------------------------------------

export type ImportCustomer = {
  // The spreadsheet's row numbers this customer came from (1-based, as
  // Excel numbers them).
  rows: number[];
  customer: CustomerFields;
  vehicles: VehicleFields[];
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
  // Index into rows of the headings; data starts after it.
  headerRow: number;
  mapping: (ImportField | null)[];
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

// Checks one customer's values the way the form does, leaving out (with a
// note) any value the form would refuse, so one bad cell doesn't lose the
// whole customer. Null when there's no name to go by.
function checkImportCustomer(raw: Record<keyof CustomerFields, string>, note: (message: string) => void): CustomerFields | null {
  const values = { ...raw };
  for (const key of ["phone", "email"] as const) {
    if (!values[key]) continue;
    if (!("error" in checkCustomer({ ...blankCustomer(), name: "x", [key]: values[key] }))) continue;
    const first = firstOf(values[key]);
    if (first && first !== values[key] && !("error" in checkCustomer({ ...blankCustomer(), name: "x", [key]: first }))) {
      note(`${FIELD_NAMES[key]} ${quoted(values[key])}: kept the first, ${quoted(first)}.`);
      values[key] = first;
    }
  }
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
const phoneKey = (phone: string | null) => (phone ? phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") : "");
const emailKey = (email: string | null) => (email ? email.toLowerCase() : "");

// Whether two records are one customer: the same name, and the same phone
// number or email, or neither has a phone number or email to tell them
// apart. Two people of the same name with different numbers stay two.
export function sameCustomer(a: Pick<CustomerFields, "name" | "phone" | "email">, b: Pick<CustomerFields, "name" | "phone" | "email">) {
  if (nameKey(a.name) !== nameKey(b.name)) return false;
  const [phoneA, phoneB, emailA, emailB] = [phoneKey(a.phone), phoneKey(b.phone), emailKey(a.email), emailKey(b.email)];
  if (phoneA && phoneA === phoneB) return true;
  if (emailA && emailA === emailB) return true;
  return !phoneA && !phoneB && !emailA && !emailB;
}

// Whether two vehicles of one customer are one: the same VIN, or with no
// VIN on either, the same year, make, model, model number and deal.
export function sameVehicle(a: VehicleFields, b: VehicleFields) {
  if (a.vin || b.vin) return a.vin === b.vin;
  const key = (v: VehicleFields) => [v.relation, v.year ?? "", v.make?.toLowerCase() ?? "", v.model?.toLowerCase() ?? "", v.modelNumber ?? ""].join("|");
  return key(a) === key(b);
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

// What importing the sheet would do: one customer per person (rows of the
// same customer, one per vehicle, are put together), each checked like the
// forms check them. A row with vehicle details and nothing about a customer
// is another vehicle of the customer above it, as some dealer systems list
// them.
export function planImport(rows: string[][], options: ImportOptions): ImportPlan {
  const { headerRow, mapping, defaultRelation } = options;
  const columns = new Map<ImportField, number>();
  mapping.forEach((field, column) => {
    if (field && !columns.has(field)) columns.set(field, column);
  });
  const customers: ImportCustomer[] = [];
  const byName = new Map<string, ImportCustomer[]>();
  const notes: ImportNote[] = [];
  let rowsRead = 0;
  let rowsSkipped = 0;
  let previous: ImportCustomer | null = null;

  for (let index = headerRow + 1; index < rows.length; index++) {
    const cells = rows[index];
    const value = (field: ImportField) => {
      const column = columns.get(field);
      return column === undefined ? "" : (cells[column] ?? "").replace(/\u0000/g, "").trim();
    };
    if (!cells.some((cell) => cell.trim())) continue;
    const row = index + 1;
    rowsRead++;
    if (rowsRead > MAX_IMPORT_ROWS) {
      notes.push({ row, message: `Only the first ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows are imported; split the file to import the rest.`, skipped: true });
      rowsSkipped += rows.length - index;
      break;
    }
    const note = (message: string, skipped = false) => notes.push({ row, message, skipped });

    const raw = blankCustomer();
    raw.name = value("name") || [value("firstName"), value("lastName")].filter(Boolean).join(" ");
    raw.phone = value("phone");
    raw.email = value("email");
    raw.addressLine1 = value("addressLine1");
    raw.addressLine2 = value("addressLine2");
    raw.city = value("city");
    raw.state = value("state");
    raw.postalCode = padZip(value("postalCode"));
    raw.notes = value("notes");

    const vehicleRaw = blankVehicle();
    const relationText = value("relation");
    let relation = defaultRelation;
    if (relationText) {
      const read = parseRelation(relationText);
      if (read) relation = read;
      else note(`${quoted(relationText)} isn't Bought, Sold to us or Service: counted as ${RELATION_LABELS[defaultRelation]}.`);
    }
    vehicleRaw.relation = relation;
    const dateText = value("relationDate");
    if (dateText) {
      const date = parseImportDate(dateText);
      if (date) vehicleRaw.relationDate = date;
      else note(`Date ${quoted(dateText)} left out: it isn't a date (write it as 6/24/2024).`);
    }
    vehicleRaw.year = value("year").replace(/\.0+$/, "");
    vehicleRaw.make = value("make");
    vehicleRaw.model = value("model");
    vehicleRaw.modelNumber = value("modelNumber");
    vehicleRaw.vin = value("vin");
    vehicleRaw.color = value("color");
    vehicleRaw.notes = value("vehicleNotes");
    const hasVehicle = (["year", "make", "model", "modelNumber", "vin", "color", "notes"] as const).some((key) => vehicleRaw[key]);
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
      const key = nameKey(checked.name);
      customer = byName.get(key)?.find((other) => sameCustomer(other.customer, checked)) ?? null;
      if (customer) {
        fillBlanks(customer.customer, checked);
        customer.rows.push(row);
      } else {
        customer = { rows: [row], customer: checked, vehicles: [] };
        customers.push(customer);
        byName.set(key, [...(byName.get(key) ?? []), customer]);
      }
    }
    previous = customer;

    if (hasVehicle) {
      const vehicle = checkImportVehicle(vehicleRaw, note);
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
// limit, one batch at a time.
export const IMPORT_BATCH_BYTES = 256 * 1024;
export const MAX_IMPORT_BATCH_CUSTOMERS = 250;
export const MAX_IMPORT_VEHICLES_PER_CUSTOMER = 100;

export function importBatches(customers: ImportCustomer[]): ImportCustomer[][] {
  const batches: ImportCustomer[][] = [];
  let batch: ImportCustomer[] = [];
  let bytes = 0;
  for (const customer of customers) {
    const size = JSON.stringify(customer).length * 2;
    if (batch.length > 0 && (bytes + size > IMPORT_BATCH_BYTES || batch.length >= MAX_IMPORT_BATCH_CUSTOMERS)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(customer);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// What the server did with each customer of a batch.
export type ImportOutcome = {
  rows: number[];
  // created: a new customer; matched: already on file (the same name and
  // phone number or email), their blank details filled in; failed: left
  // out, with why.
  result: "created" | "matched" | "failed";
  customerId: string | null;
  filled: (keyof CustomerFields)[];
  vehiclesAdded: number;
  vehiclesOnFile: number;
  error: string | null;
};

// The import's report as CSV, for the rows that need a look: what happened
// to each, by row.
export function reportCsv(notes: ImportNote[]): string {
  const field = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = ["Row,What happened", ...[...notes].sort((a, b) => a.row - b.row).map((note) => `${note.row},${field(note.message)}`)];
  return `${lines.join("\r\n")}\r\n`;
}

// A file to start from, with the headings the import knows best.
export const TEMPLATE_CSV = [
  "Name,Phone,Email,Street address,City,State,ZIP,Bought sold or service,Date bought or sold,Year,Make,Model,Model number,VIN,Color",
  "Dana Whitfield,(814) 555-0199,dana@example.com,412 Logan Blvd,Altoona,PA,16602,Bought,6/24/2024,2021,Polaris,Sportsman 850,A21SXZ85A1,,Sage Green",
  "Dana Whitfield,(814) 555-0199,dana@example.com,412 Logan Blvd,Altoona,PA,16602,Sold to us,6/24/2024,2016,Polaris,Ranger 570,,,",
  "Rhett Carver,(814) 555-0123,,,Hollidaysburg,PA,,Service,,2019,Polaris,RZR XP 1000,Z19VDE99AM,,",
].join("\r\n");
