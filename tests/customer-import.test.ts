// Importing customers from a spreadsheet: reading CSV and Excel files
// (src/lib/customer-import-rules.ts), matching columns by their headings,
// checking each row like the forms do and grouping rows into customers and
// vehicles; then saving (importCustomers in src/lib/customers.ts): matching
// customers already on file, filling in only their blanks, never adding a
// vehicle twice, staying inside the shop, and two imports at once not adding
// the same customer twice.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { setTimeout as sleep } from "node:timers/promises";

import { systemDb } from "../src/db";
import { auditLog, customerVehicles, customers, shops, users } from "../src/db/schema";
import {
  MAX_IMPORT_BATCH_CUSTOMERS,
  TEMPLATE_CSV,
  decodeText,
  detectDelimiter,
  findHeaderRow,
  guessMapping,
  importBatches,
  parseImportDate,
  matchCustomer,
  padZip,
  parseRelation,
  planImport,
  readHeading,
  readSpreadsheet,
  reportCsv,
  sameCustomer,
  type ImportCustomer,
  type ImportField,
} from "../src/lib/customer-import-rules";
import { createCustomer, getCustomer, importCustomers, listCustomers } from "../src/lib/customers";
import type { CurrentUser } from "../src/lib/session";

const encode = (text: string) => new TextEncoder().encode(text);

async function sheetOf(fileName: string, bytes: Uint8Array) {
  const read = await readSpreadsheet(fileName, bytes);
  assert.ok("sheets" in read, JSON.stringify(read));
  return read.sheets[0].rows;
}

// Rows written as "a|b|c" lines.
const csv = (lines: string[]) => lines.map((line) => line.split("|"));

// The fields of a guessed mapping, unit 1's (as most files have one unit a row).
const fieldsOf = (headings: string[]) => guessMapping(headings).map((target) => target?.field ?? null);

// Reads a sheet as the page does: the headings found, the columns guessed.
function plan(rows: string[][], defaultRelation: "bought" | "sold" | "owned" = "bought") {
  const headerRow = findHeaderRow(rows);
  return planImport(rows, { headerRow, mapping: guessMapping(rows[headerRow]), defaultRelation });
}

describe("reading the file", () => {
  test("text is UTF-8, UTF-16 with its mark, or else Windows-1252 as Excel saves plain CSV", () => {
    assert.equal(decodeText(encode("José")), "José");
    assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...encode("Zoë")])), "Zoë");
    assert.equal(decodeText(new Uint8Array([0x4a, 0x6f, 0x73, 0xe9])), "José");
    assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])), "AB");
  });

  test("the delimiter is commas unless the first line has more semicolons or tabs", () => {
    assert.equal(detectDelimiter("Name,Phone\nA,1"), ",");
    assert.equal(detectDelimiter("Name;Phone;Email\nA;1;x"), ";");
    assert.equal(detectDelimiter("Name\tPhone\nA\t1"), "\t");
    assert.equal(detectDelimiter('"Smith; Jo",Phone\n'), ",");
    // A title line above the headings doesn't decide it.
    assert.equal(detectDelimiter("Supplier list\nSupplier ID\tSupplier Name\n1\tPolaris"), "\t");
    assert.equal(detectDelimiter("Customer list, printed 10/30/2026\nName;Phone;Email\nJo;1;x"), ";");
  });

  test("CSV, semicolon CSV and tab-separated text all read", async () => {
    assert.deepEqual(await sheetOf("a.csv", encode("Name,Phone\r\nJo,555\r\n")), [["Name", "Phone"], ["Jo", "555"]]);
    assert.deepEqual(await sheetOf("a.csv", encode("Name;Phone\nJo;555")), [["Name", "Phone"], ["Jo", "555"]]);
    assert.deepEqual(await sheetOf("a.txt", encode("Name\tPhone\nJo\t555")), [["Name", "Phone"], ["Jo", "555"]]);
  });

  test("files that can't be read say why", async () => {
    const error = async (name: string, bytes: Uint8Array) => {
      const read = await readSpreadsheet(name, bytes);
      assert.ok("error" in read, `${name} should not read`);
      return read.error;
    };
    assert.match(await error("a.csv", new Uint8Array()), /empty/);
    assert.match(await error("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), /\.xls/);
    assert.match(await error("broken.xlsx", encode("not a zip")), /isn't a working Excel workbook/);
    assert.match(await error("list.ods", encode("x")), /can't be read here/);
    assert.match(await error("junk.csv", new Uint8Array(200).fill(1)), /isn't a CSV/);
    assert.match(await error("bad.csv", encode('Name\n"Jo')), /closing quote/);
  });

  test("an Excel export with a title row, two phone columns, dates and a number ZIP", async () => {
    const rows = await sheetOf("customers.xlsx", new Uint8Array(readFileSync(new URL("./fixtures/customers/customers.xlsx", import.meta.url))));
    assert.equal(findHeaderRow(rows), 2);
    const mapping = guessMapping(rows[2]);
    assert.deepEqual(mapping[rows[2].indexOf("Mobile")], { field: "phone", unit: 1 }, "the mobile number first");
    assert.deepEqual(mapping[rows[2].indexOf("Home Phone")], { field: "phone", unit: 2 }, "then the home one");
    const result = plan(rows);
    assert.equal(result.customers.length, 2);
    const [dana, ana] = result.customers;
    assert.deepEqual(dana.rows, [4, 5]);
    assert.equal(dana.customer.name, "Dana Whitfield");
    assert.equal(dana.customer.phone, "(814) 555-0199");
    assert.equal(dana.customer.postalCode, "16602");
    assert.equal(dana.customer.notes, "Home Phone: (814) 555-0100", "the other number is kept in the notes");
    assert.deepEqual(
      dana.vehicles.map((vehicle) => [vehicle.relation, vehicle.relationDate, vehicle.year, vehicle.model, vehicle.modelNumber]),
      [
        ["bought", "2024-06-24", 2021, "Sportsman 850", "A21SXZ85A1"],
        ["sold", "2024-06-24", 2016, "Ranger 570", null],
      ],
    );
    assert.equal(ana.customer.postalCode, "02134", "Excel's number ZIP gets its leading zero back");
    assert.equal(ana.customer.email, "ANA@EXAMPLE.COM");
    assert.equal(ana.vehicles[0].relation, "owned");
    // The row with only a home phone has no name.
    assert.deepEqual(
      result.notes.map((note) => [note.row, note.skipped]),
      [[8, true]],
    );
  });
});

describe("matching columns", () => {
  test("headings from dealer systems and hand-kept lists", () => {
    const headings = ["Customer Name", "Cell Phone", "E-mail", "Street Address", "Town", "Province", "Postal Code", "Model #", "Model", "Serial Number", "Colour", "Delivery Date", "Deal Type"];
    assert.deepEqual(fieldsOf(headings), [
      "name", "phone", "email", "addressLine1", "city", "state", "postalCode", "modelNumber", "model", "vin", "color", "relationDate", "relation",
    ] satisfies (ImportField | null)[]);
  });

  test("a Name column is the name, even with first and last name columns too", () => {
    assert.deepEqual(fieldsOf(["First Name", "Last Name", "Name"]), [null, null, "name"]);
    assert.deepEqual(fieldsOf(["First Name", "Last Name"]), ["firstName", "lastName"]);
  });

  test("each field goes to one column, and unknown headings are left out", () => {
    assert.deepEqual(fieldsOf(["Name", "Name", "Favourite colour", ""]), ["name", null, null, null]);
    // Every phone column is kept, a mobile one first.
    assert.deepEqual(guessMapping(["Phone", "Mobile", "Work Phone #"]), [
      { field: "phone", unit: 2 },
      { field: "phone", unit: 1 },
      { field: "phone", unit: 3 },
    ]);
  });

  test("headings with a unit number are that unit's; a customer's own details have no number", () => {
    const read = (heading: string) => {
      const found = readHeading(heading);
      return found && [found.field, found.unit];
    };
    assert.deepEqual(read("Unit 2 Model"), ["model", 2]);
    assert.deepEqual(read("Vehicle 2 VIN"), ["vin", 2]);
    assert.deepEqual(read("2nd Unit Year"), ["year", 2]);
    assert.deepEqual(read("Second Vehicle Make"), ["make", 2]);
    assert.deepEqual(read("Unit 3 Model #"), ["modelNumber", 3]);
    assert.deepEqual(read("Model 2"), ["model", 2]);
    assert.deepEqual(read("VIN #2"), ["vin", 2]);
    assert.deepEqual(read("Unit 1 Serial Number"), ["vin", 1]);
    assert.deepEqual(read("Vehicle 2"), ["model", 2]);
    // Not units: a second address line; another phone number or email.
    assert.deepEqual(read("Address 2"), ["addressLine2", 1]);
    assert.deepEqual(read("Phone 1"), ["phone", 1]);
    assert.deepEqual(read("Phone 2"), ["phone", 2]);
    assert.deepEqual(read("Email 2"), ["email", 2]);
    assert.equal(read("City 2"), null);
    assert.equal(read("Unit 11 Model"), null);
    assert.equal(read("First Name") && read("First Name")![0], "firstName");
  });

  test("dealer systems' other spellings: Unit or Vehicle in front, # or No. after", () => {
    assert.deepEqual(fieldsOf(["Unit VIN", "Vehicle Color", "Unit Serial #", "Cell Phone #", "Cust #", "Stock #"]), ["vin", "color", null, "phone", null, null]);
    assert.deepEqual(fieldsOf(["VIN/Serial #"]), ["vin"]);
    assert.deepEqual(fieldsOf(["Serial No."]), ["vin"]);
    assert.deepEqual(fieldsOf(["Home Phone #"]), ["phone"]);
  });

  test("a loose name heading gives way to first and last name columns", () => {
    assert.deepEqual(fieldsOf(["Customer", "First Name", "Last Name"]), [null, "firstName", "lastName"]);
    assert.deepEqual(fieldsOf(["Contact", "Phone"]), ["name", "phone"]);
  });

  test("a list with no headings row starts with its first customer", () => {
    const rows = [["Jo Smith", "814-555-0100", "RZR"], ["Al Ng", "814-555-0188", "Ranger"]];
    assert.equal(findHeaderRow(rows), -1);
    const result = planImport(rows, { headerRow: -1, mapping: [{ field: "name", unit: 1 }, { field: "phone", unit: 1 }, { field: "model", unit: 1 }], defaultRelation: "bought" });
    assert.deepEqual(
      result.customers.map((customer) => [customer.rows, customer.customer.name]),
      [
        [[1], "Jo Smith"],
        [[2], "Al Ng"],
      ],
    );
    // Words with no digits read as headings.
    assert.equal(findHeaderRow([["Kunde", "Telefon"], ["Jo", "555-0100"]]), 0);
  });

  test("the template's headings are all known", () => {
    const [headings] = TEMPLATE_CSV.split("\r\n").map((line) => line.split(","));
    assert.ok(guessMapping(headings).every(Boolean));
  });
});

describe("values", () => {
  test("dates in the forms people type them, month first", () => {
    assert.equal(parseImportDate("6/24/2024"), "2024-06-24");
    assert.equal(parseImportDate("06-24-24"), "2024-06-24");
    assert.equal(parseImportDate("12/1/98"), "1998-12-01");
    assert.equal(parseImportDate("2024-06-24"), "2024-06-24");
    assert.equal(parseImportDate("2024-06-24 13:05"), "2024-06-24");
    assert.equal(parseImportDate("2/30/2024"), null);
    assert.equal(parseImportDate("June 24"), null);
  });

  test("ZIP codes Excel stored as numbers get their zeros and dash back", () => {
    assert.equal(padZip("2134"), "02134");
    assert.equal(padZip("16602"), "16602");
    assert.equal(padZip("21341234"), "02134-1234");
    assert.equal(padZip("166021234"), "16602-1234");
    assert.equal(padZip("K1A 0B1"), "K1A 0B1");
    assert.equal(padZip("12"), "12");
  });

  test("dates with a time after them, and with the month's name", () => {
    assert.equal(parseImportDate("6/24/2024 12:00:00 AM"), "2024-06-24");
    assert.equal(parseImportDate("6/24/2024 13:05"), "2024-06-24");
    assert.equal(parseImportDate("6/24/2024 0:00"), "2024-06-24");
    assert.equal(parseImportDate("2024-03-05 00:00:00.000"), "2024-03-05");
    assert.equal(parseImportDate("2024-03-05T14:30:00Z"), "2024-03-05");
    assert.equal(parseImportDate("2024/03/05"), "2024-03-05");
    assert.equal(parseImportDate("24-Jun-24"), "2024-06-24");
    assert.equal(parseImportDate("24 June 2024"), "2024-06-24");
    assert.equal(parseImportDate("Jun 24, 2024"), "2024-06-24");
    assert.equal(parseImportDate("Sept 3 2024"), "2024-09-03");
    assert.equal(parseImportDate("Junk 24, 2024"), null);
    assert.equal(parseImportDate("6/24/2024 noon"), null);
  });

  test("text from Excel for Mac (Mac Roman) and Windows (Windows-1252)", () => {
    // "José Peña, Zoë Côté" as each writes it.
    assert.equal(decodeText(new Uint8Array([0x4a, 0x6f, 0x73, 0x8e, 0x20, 0x50, 0x65, 0x96, 0x61, 0x2c, 0x5a, 0x6f, 0x91, 0x20, 0x43, 0x99, 0x74, 0x8e])), "José Peña,Zoë Côté");
    // (Node's Windows-1252 leaves 0x80-0x9F, such as curly quotes, as
    // control characters, where browsers follow the full table; letters
    // with accents are the same in both.)
    assert.equal(decodeText(new Uint8Array([0x4a, 0x6f, 0x73, 0xe9, 0x20, 0x50, 0x65, 0xf1, 0x61, 0x2c, 0x5a, 0x6f, 0xeb, 0x20, 0x43, 0xf4, 0x74, 0xe9])), "José Peña,Zoë Côté");
  });

  test("deal types; a bare Sold could mean either way", () => {
    assert.equal(parseRelation("Bought"), "bought");
    assert.equal(parseRelation("NEW"), "bought");
    assert.equal(parseRelation("Trade-In"), "sold");
    assert.equal(parseRelation("Sold to us"), "sold");
    assert.equal(parseRelation("service only"), "owned");
    assert.equal(parseRelation("Sold"), null);
  });

  test("one customer: the same name and phone or email, or neither has either", () => {
    const person = (name: string, phone: string | null, email: string | null) => ({ name, phone, email });
    assert.ok(sameCustomer(person("Jo  Smith", "(814) 555-0100", null), person("jo smith", "1-814-555-0100", null)));
    assert.ok(sameCustomer(person("Jo Smith", null, "JO@x.com"), person("Jo Smith", "555-0100", "jo@x.com")));
    assert.ok(sameCustomer(person("Jo Smith", null, null), person("Jo Smith", null, null)));
    assert.ok(!sameCustomer(person("Jo Smith", "555-0100", null), person("Jo Smith", "555-0199", null)));
    assert.ok(!sameCustomer(person("Jo Smith", "555-0100", null), person("Joe Smith", "555-0100", null)));
    // A number on only one of them doesn't tell them apart; two different
    // numbers (or emails) do.
    assert.ok(sameCustomer(person("Jo Smith", "555-0100", null), person("Jo Smith", null, null)));
    assert.ok(sameCustomer(person("Jo Smith", "555-0100", null), person("Jo Smith", null, "jo@x.com")));
    assert.ok(!sameCustomer(person("Jo Smith", "555-0100", "jo@x.com"), person("Jo Smith", "555-0199", null)));
    assert.ok(!sameCustomer(person("Jo Smith", null, "jo@x.com"), person("Jo Smith", null, "joe@y.com")));
    // Two different phone numbers say two people, even with the same email
    // (a family's shared address).
    assert.ok(!sameCustomer(person("Jo Smith", "555-0100", "jo@x.com"), person("Jo Smith", "555-0199", "jo@x.com")));
    // Any of their numbers counts.
    assert.ok(sameCustomer({ ...person("Jo Smith", "555-0100", null), phones: ["555-0100", "555-0177"] }, person("Jo Smith", "555-0177", null)));
  });

  test("of several customers of a name, the one with the same number; never a guess", () => {
    const one = { name: "Jo Smith", phone: "555-0100", email: null };
    const two = { name: "Jo Smith", phone: "555-0199", email: null };
    const bare = { name: "Jo Smith", phone: null, email: null };
    assert.equal(matchCustomer([one, two], { ...two }).match, two);
    assert.equal(matchCustomer([one], bare).match, one, "the only one it could be");
    assert.deepEqual(matchCustomer([one, two], bare), { match: null, ambiguous: 2 });
    assert.equal(matchCustomer([one, two], bare, two).match, two, "the one just above it in the file");
    // A customer with no number on file is the sure match for a row with none.
    assert.equal(matchCustomer([one, two, bare], { ...bare }).match, bare);
  });
});

describe("planning the import", () => {
  test("a customer's several units, however the file lays them out", () => {
    const layouts: [string, string[]][] = [
      ["contact on every row", ["Name|Phone|Model", "Jo Smith|814-555-0100|RZR", "Jo Smith|814-555-0100|Sportsman", "Jo Smith|814-555-0100|Ranger"]],
      ["contact on the first row only", ["Name|Phone|Model", "Jo Smith|814-555-0100|RZR", "Jo Smith||Sportsman", "Jo Smith||Ranger"]],
      ["name on the first row only", ["Name|Phone|Model", "Jo Smith|814-555-0100|RZR", "||Sportsman", "||Ranger"]],
      ["side by side", ["Name|Phone|Unit 1 Model|Unit 1 VIN|Unit 2 Model|Unit 2 VIN|Unit 3 Model", "Jo Smith|814-555-0100|RZR||Sportsman||Ranger"]],
      ["side by side, numbered after", ["Name|Phone|Model|Model 2|Model 3", "Jo Smith|814-555-0100|RZR|Sportsman|Ranger"]],
    ];
    for (const [layout, lines] of layouts) {
      const result = plan(csv(lines));
      assert.equal(result.customers.length, 1, layout);
      assert.equal(result.customers[0].customer.phone, "(814) 555-0100", layout);
      assert.deepEqual(
        result.customers[0].vehicles.map((vehicle) => vehicle.model),
        ["RZR", "Sportsman", "Ranger"],
        layout,
      );
      assert.deepEqual(result.notes, [], layout);
    }
  });

  test("units side by side each have their own deal, date and notes", () => {
    const result = plan(
      csv([
        "Name|Unit 1 Model|Unit 1 Deal Type|Unit 1 Date|Unit 2 Model|Unit 2 Deal Type|Unit 2 VIN|Unit 3 Model",
        "Jo Smith|RZR|Bought|6/24/2024|Ranger|Trade-in|SHORTVIN|",
      ]),
    );
    assert.deepEqual(
      result.customers[0].vehicles.map((vehicle) => [vehicle.model, vehicle.relation, vehicle.relationDate, vehicle.vin]),
      [
        ["RZR", "bought", "2024-06-24", null],
        ["Ranger", "sold", null, null],
      ],
    );
    assert.deepEqual(
      result.notes.map((note) => note.message.split(":")[0]),
      ["Unit 2"],
    );
  });

  test("a row with only a name, when two customers in the file have it, goes with the one above", () => {
    const result = plan(
      csv(["Name|Phone|Model", "Jo Smith|814-555-0100|RZR", "Jo Smith|814-555-0199|Ranger", "Jo Smith||Sportsman", "Al Ng||General", "Jo Smith||Scrambler"]),
    );
    assert.deepEqual(
      result.customers.map((customer) => [customer.customer.name, customer.customer.phone, customer.vehicles.map((vehicle) => vehicle.model)]),
      [
        ["Jo Smith", "(814) 555-0100", ["RZR"]],
        ["Jo Smith", "(814) 555-0199", ["Ranger", "Sportsman"]],
        ["Al Ng", null, ["General"]],
        ["Jo Smith", null, ["Scrambler"]],
      ],
    );
    assert.deepEqual(
      result.notes.map((note) => [note.row, note.message]),
      [[6, "2 customers in this file are called Jo Smith, and nothing here says which this is: added as another customer."]],
    );
  });

  test("a name-only row goes with the customer just above it, not one added apart earlier", () => {
    const result = plan(
      csv([
        "Name|Phone|Model",
        "Jo Smith|814-555-0100|RZR",
        "Jo Smith|814-555-0199|Ranger",
        "Al Ng||General",
        "Jo Smith||Scrambler",
        "Jo Smith|814-555-0199|Outlaw",
        "Jo Smith||Sportsman",
      ]),
    );
    assert.deepEqual(
      result.customers.map((customer) => [customer.customer.phone, customer.vehicles.map((vehicle) => vehicle.model)]),
      [
        ["(814) 555-0100", ["RZR"]],
        ["(814) 555-0199", ["Ranger", "Outlaw", "Sportsman"]],
        [null, ["General"]],
        [null, ["Scrambler"]],
      ],
    );
  });

  test("planning 20,000 rows takes well under a second", () => {
    const rows = [["Name", "Phone", "Email", "City", "Year", "Model", "VIN"]];
    for (let index = 0; index < 20_000; index++) rows.push([`Customer ${index}`, `814-555-${String(index % 10000).padStart(4, "0")}`, `c${index}@example.com`, "Altoona", "2021", "Sportsman 850", ""]);
    const started = performance.now();
    const result = plan(rows);
    const took = performance.now() - started;
    assert.equal(result.customers.length, 20_000);
    assert.ok(took < 1500, `took ${Math.round(took)} ms`);
  });

  test("a customer's phone is the first of the phone columns that has one; the others go in their notes", () => {
    const result = plan(
      csv([
        "Name|Home Phone|Cell Phone|Work Phone|Model",
        "Rhett Carver|(814) 555-0123||(814) 555-0777|RZR",
        "Walt Ostrowski|814-555-0145|||Ranger",
        "Ann Ames|814-555-1901|||Sportsman",
        "Ann Ames|814-555-1999|||General",
        "Dana Whitfield|814-555-0100|814-555-0199||Scrambler",
        "Dana Whitfield||814-555-0199||Outlaw",
      ]),
    );
    assert.deepEqual(
      result.customers.map((customer) => [customer.customer.name, customer.customer.phone, customer.customer.notes, customer.vehicles.length]),
      [
        ["Rhett Carver", "(814) 555-0123", "Work Phone: (814) 555-0777", 1],
        ["Walt Ostrowski", "(814) 555-0145", null, 1],
        ["Ann Ames", "(814) 555-1901", null, 1],
        ["Ann Ames", "(814) 555-1999", null, 1],
        ["Dana Whitfield", "(814) 555-0199", "Home Phone: (814) 555-0100", 2],
      ],
    );
  });

  test("who a row is doesn't depend on the order of the rows, and no number is lost", () => {
    const rows = ["Jo Smith|814-555-0100||RZR", "Jo Smith||jo@x.com|Ranger", "Jo Smith|814-555-0199|jo@x.com|Outlaw"];
    for (const order of [[0, 1, 2], [0, 2, 1], [2, 0, 1], [1, 0, 2]]) {
      const result = plan(csv(["Name|Phone|Email|Model", ...order.map((index) => rows[index])]));
      assert.deepEqual(
        result.customers.map((customer) => customer.customer.phone).sort(),
        ["(814) 555-0100", "(814) 555-0199"],
        `order ${order}`,
      );
      assert.equal(result.vehicles, 3, `order ${order}`);
    }
  });

  test("a report's repeated headings and its page and total lines are left out", () => {
    const result = plan(
      csv([
        "Units Sold by Customer||",
        "Customer Name|Phone|Unit Model",
        "Dana Whitfield|814-555-0199|Sportsman 850",
        "Page 1 of 2||",
        "Customer Name|Phone|Unit Model",
        "Rhett Carver|814-555-0123|RZR",
        "Total units sold: 2||",
        "End of Report||",
      ]),
    );
    assert.deepEqual(
      result.customers.map((customer) => customer.customer.name),
      ["Dana Whitfield", "Rhett Carver"],
    );
    assert.deepEqual(
      result.notes.map((note) => [note.row, note.skipped]),
      [
        [4, true],
        [5, true],
        [7, true],
        [8, true],
      ],
    );
    assert.equal(result.rowsRead, 2);
  });

  test("each row's notes are kept when a customer's rows are put together", () => {
    const result = plan(csv(["Name|Phone|Notes|Model", "Jo Smith|814-555-0100|Prefers texts|RZR", "Jo Smith|814-555-0100|Prefers texts|Ranger", "Jo Smith|814-555-0100|Pays cash|Outlaw"]));
    assert.equal(result.customers[0].customer.notes, "Prefers texts\nPays cash");
  });

  test("two of the same model are two units when their dates or colors differ", () => {
    const result = plan(
      csv(["Name|Model|Date|Color", "Jo Smith|RZR|6/1/2024|Red", "Jo Smith|RZR|7/1/2024|Red", "Jo Smith|RZR||Blue", "Jo Smith|RZR|6/1/2024|"]),
    );
    assert.deepEqual(
      result.customers[0].vehicles.map((vehicle) => [vehicle.relationDate, vehicle.color]),
      [
        ["2024-06-01", "Red"],
        ["2024-07-01", "Red"],
        [null, "Blue"],
      ],
    );
  });

  test("rows of one customer become one customer with their vehicles, each once", () => {
    const result = plan(
      csv([
        "Name|Phone|Year|Model|VIN",
        "Jo Smith|814-555-0100|2021|Sportsman 850|",
        "Jo Smith|(814) 555-0100|2016|Ranger 570|",
        "Jo Smith|8145550100|2021|Sportsman 850|",
        "Jo Smith|555-0199|2019|RZR|",
      ]),
    );
    assert.equal(result.customers.length, 2, "the other Jo Smith has another number");
    assert.deepEqual(result.customers[0].rows, [2, 3, 4]);
    assert.deepEqual(
      result.customers[0].vehicles.map((vehicle) => vehicle.model),
      ["Sportsman 850", "Ranger 570"],
    );
    assert.equal(result.vehicles, 3);
  });

  test("a row with only a vehicle is another vehicle of the customer above", () => {
    const result = plan(csv(["Name|Model|Model number", "Jo Smith|Sportsman 850|", "||Z19VDE99AM", "|RZR|"]));
    assert.equal(result.customers.length, 1);
    assert.deepEqual(result.customers[0].rows, [2, 3, 4]);
    assert.equal(result.customers[0].vehicles.length, 3);
  });

  test("one bad value is left out with a note, and the customer still goes in", () => {
    const result = plan(
      csv([
        "Name|Phone|Email|ZIP|Year|Model|VIN|Deal type|Date",
        "Jo Smith|call his wife|jo@|123456789012345|2021|Sportsman|1HGCM82633A00435|Lease|someday",
        "Al Ng|814-555-0100 / 814-555-0101||||||",
      ]),
    );
    const [jo, al] = result.customers;
    assert.equal(jo.customer.phone, null);
    assert.equal(jo.customer.email, null);
    assert.equal(jo.customer.postalCode, null);
    assert.equal(jo.vehicles[0].vin, null);
    assert.equal(jo.vehicles[0].relation, "bought");
    assert.equal(jo.vehicles[0].relationDate, null);
    assert.equal(al.customer.phone, "(814) 555-0100");
    const messages = result.notes.map((note) => note.message).join("\n");
    assert.match(messages, /Phone “call his wife” left out/);
    assert.match(messages, /Email “jo@” left out/);
    assert.match(messages, /ZIP .* left out/);
    assert.match(messages, /VIN .* left out/);
    assert.match(messages, /“Lease” isn't Bought, Sold to us or Service/);
    assert.match(messages, /Date “someday” left out/);
    assert.match(messages, /kept the first, “814-555-0100”/);
    assert.ok(result.notes.every((note) => !note.skipped));
  });

  test("rows with no name are left out; a vehicle with nothing to say what it is too", () => {
    const result = plan(csv(["Name|Phone|Color", "|555-0100|", "Jo Smith||Red", "Al Ng||"]));
    assert.deepEqual(
      result.customers.map((customer) => [customer.customer.name, customer.vehicles.length]),
      [
        ["Jo Smith", 0],
        ["Al Ng", 0],
      ],
    );
    assert.equal(result.rowsSkipped, 1);
    assert.deepEqual(
      result.notes.map((note) => [note.row, note.skipped, note.message.split(":")[0]]),
      [
        [2, true, "No name"],
        [3, false, "Vehicle left out"],
      ],
    );
  });

  test("first and last name columns make the name; the default deal type applies", () => {
    const result = plan(csv(["First|Last|Model", "Jo|Smith|RZR", "|Ng|"]), "owned");
    assert.deepEqual(
      result.customers.map((customer) => customer.customer.name),
      ["Jo Smith", "Ng"],
    );
    assert.equal(result.customers[0].vehicles[0].relation, "owned");
  });

  test("batches stay small enough to send", () => {
    const customer = (index: number): ImportCustomer => ({
      rows: [index],
      customer: { name: `Customer ${index}`, phone: null, email: null, addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, notes: "x".repeat(1900) },
      vehicles: [],
      phones: [],
      emails: [],
    });
    const batches = importBatches(Array.from({ length: 700 }, (_, index) => customer(index + 1)));
    assert.ok(batches.every((batch) => batch.length <= MAX_IMPORT_BATCH_CUSTOMERS));
    assert.ok(batches.every((batch) => JSON.stringify(batch).length < 300 * 1024));
    assert.equal(batches.flat().length, 700);
  });

  test("a customer with more units than a batch takes is sent in parts", () => {
    const units = Array.from({ length: 250 }, (_, index) => `Jo Smith|814-555-0100|Unit model ${index}`);
    const [jo] = plan(csv(["Name|Phone|Model", ...units])).customers;
    assert.equal(jo.vehicles.length, 250);
    const parts = importBatches([jo]).flat();
    assert.deepEqual(
      parts.map((part) => part.vehicles.length),
      [100, 100, 50],
    );
    assert.ok(parts.every((part) => part.rows === jo.rows));
  });

  test("the report is CSV, by row", () => {
    assert.equal(
      reportCsv([
        { row: 9, message: "Later", skipped: false },
        { row: 2, message: 'Phone "x, y" left out', skipped: false },
      ]),
      '\ufeffRow,What happened\r\n2,"Phone ""x, y"" left out"\r\n9,Later\r\n',
    );
  });
});

describe("saving an import", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let writer: CurrentUser;
  let other: CurrentUser;

  async function createWriter(code: string): Promise<CurrentUser> {
    const [shop] = await systemDb
      .insert(shops)
      .values({ code, name: `Shop ${code}` })
      .returning({ id: shops.id, code: shops.code, name: shops.name });
    shopIds.push(shop.id);
    const id = randomUUID();
    await systemDb.insert(users).values({
      id,
      shopId: shop.id,
      role: "service_writer",
      name: "Sam",
      username: `${code}.sam`,
      displayUsername: "sam",
      email: `${randomUUID()}@no-email.invalid`,
    });
    return { id, name: "Sam", username: "sam", role: "service_writer", shop, bay: null };
  }

  before(async () => {
    writer = await createWriter(`ia${suffix}`);
    other = await createWriter(`ib${suffix}`);
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  const fileRows = [
    "Name|Phone|Email|City|Deal type|Date|Year|Make|Model|VIN",
    "Dana Whitfield|814-555-0199|dana@example.com|Altoona|Bought|6/24/2024|2021|Polaris|Sportsman 850|1HGCM82633A004352",
    "Dana Whitfield|814-555-0199||Altoona|Trade-in|6/24/2024|2016|Polaris|Ranger 570|",
    "Rhett Carver|(814) 555-0123|||Service||2019|Polaris|RZR XP 1000|",
  ].map((line) => line.split("|"));

  const send = (actor: CurrentUser, list: ImportCustomer[], importId: string = randomUUID()) =>
    importCustomers(actor, { importId, fileName: "list.csv", customers: list });

  test("adds customers and vehicles, and importing again adds nothing", async () => {
    const { customers: planned } = plan(fileRows);
    const importId = randomUUID();
    const first = await send(writer, planned, importId);
    assert.ok("outcomes" in first, JSON.stringify(first));
    assert.deepEqual(
      first.outcomes.map((outcome) => [outcome.rows, outcome.result, outcome.vehiclesAdded, outcome.vehiclesOnFile]),
      [
        [[2, 3], "created", 2, 0],
        [[4], "created", 1, 0],
      ],
    );
    const dana = await getCustomer(writer.shop.id, first.outcomes[0].customerId!);
    assert.equal(dana?.customer.phone, "(814) 555-0199");
    assert.deepEqual(
      dana?.vehicles.map((vehicle) => [vehicle.relation, vehicle.label, vehicle.vin]),
      [
        ["bought", "2021 Polaris Sportsman 850", "1HGCM82633A004352"],
        ["sold", "2016 Polaris Ranger 570", null],
      ],
    );
    const [entry] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId));
    assert.equal(entry.action, "customers.imported");
    assert.deepEqual(entry.details, { fileName: "list.csv", created: 2, matched: 0, filled: 0, failed: 0, vehiclesAdded: 3 });

    const again = await send(writer, plan(fileRows).customers);
    assert.ok("outcomes" in again);
    assert.deepEqual(
      again.outcomes.map((outcome) => [outcome.result, outcome.vehiclesAdded, outcome.vehiclesOnFile, outcome.customerId]),
      [
        ["matched", 0, 2, first.outcomes[0].customerId],
        ["matched", 0, 1, first.outcomes[1].customerId],
      ],
    );
    assert.equal((await listCustomers(writer.shop.id, { query: "whitfield" })).total, 1);
  });

  test("a customer on file has only their blanks filled in", async () => {
    const made = await createCustomer(writer, {
      name: "Pat Lee",
      phone: "5551112222",
      email: "",
      addressLine1: "",
      addressLine2: "",
      city: "Tyrone",
      state: "",
      postalCode: "",
      notes: "",
    });
    assert.ok("id" in made);
    const result = await send(writer, plan([["Name", "Phone", "Email", "City"], ["pat lee", "555-111-2222", "pat@example.com", "Altoona"]]).customers);
    assert.ok("outcomes" in result);
    assert.deepEqual(result.outcomes[0].result, "matched");
    assert.deepEqual(result.outcomes[0].filled, ["email"]);
    const pat = await getCustomer(writer.shop.id, made.id);
    assert.equal(pat?.customer.email, "pat@example.com");
    assert.equal(pat?.customer.city, "Tyrone", "what they had stays");
    assert.equal(pat?.customer.name, "Pat Lee");
  });

  test("the server checks every customer again, whatever the browser sent", async () => {
    const result = await importCustomers(writer, {
      importId: randomUUID(),
      fileName: "x.csv",
      customers: [
        { rows: [2], customer: { name: "" }, vehicles: [] },
        { rows: [3], customer: { name: "Val Ortiz", phone: "not a phone" }, vehicles: [] },
        { rows: [4], customer: { name: "Kim Dao" }, vehicles: [{ relation: "bought", year: 2022, model: "General" }, { relation: "nope", model: "X" }, { relation: "owned", vin: "SHORT" }] },
        { rows: "4", customer: null, vehicles: "x" },
      ],
    });
    assert.ok("outcomes" in result);
    assert.deepEqual(
      result.outcomes.map((outcome) => [outcome.result, outcome.vehiclesAdded, outcome.error]),
      [
        ["failed", 0, "Enter the customer's name."],
        ["failed", 0, "A phone number is digits, with spaces, dashes or brackets if you like."],
        ["created", 1, null],
        ["failed", 0, "Enter the customer's name."],
      ],
    );
    const kim = await getCustomer(writer.shop.id, result.outcomes[2].customerId!);
    assert.equal(kim?.vehicles[0].year, 2022);
    assert.ok("error" in (await importCustomers(writer, { importId: "nope", fileName: "x", customers: [] })));
    assert.ok("error" in (await send(writer, [])));
    assert.ok(
      "error" in
        (await send(
          writer,
          Array.from({ length: MAX_IMPORT_BATCH_CUSTOMERS + 1 }, (_, index) => plan([["Name"], [`Bulk ${index}`]]).customers[0]),
        )),
    );
  });

  test("another shop's customers are never matched or changed", async () => {
    const result = await send(other, plan(fileRows).customers);
    assert.ok("outcomes" in result);
    assert.ok(result.outcomes.every((outcome) => outcome.result === "created"));
    const theirs = await systemDb.select({ shopId: customers.shopId }).from(customers).where(sql`${customers.id} in ${result.outcomes.map((o) => o.customerId!)}`);
    assert.ok(theirs.every((row) => row.shopId === other.shop.id));
    assert.equal((await listCustomers(writer.shop.id, { query: "whitfield" })).total, 1);
    const vehicles = await systemDb.select({ shopId: customerVehicles.shopId }).from(customerVehicles).where(sql`${customerVehicles.customerId} in ${result.outcomes.map((o) => o.customerId!)}`);
    assert.ok(vehicles.every((row) => row.shopId === other.shop.id));
  });

  test("units go to the customer on file even when the file leaves out their number", async () => {
    const result = await send(writer, plan([["Name", "Model"], ["Rhett Carver", "Sportsman 570"]]).customers);
    assert.ok("outcomes" in result);
    assert.equal(result.outcomes[0].result, "matched");
    assert.equal(result.outcomes[0].vehiclesAdded, 1);
    const rhett = await getCustomer(writer.shop.id, result.outcomes[0].customerId!);
    assert.equal(rhett?.customer.phone, "(814) 555-0123");
    assert.deepEqual(
      rhett?.vehicles.map((vehicle) => vehicle.model).sort(),
      ["RZR XP 1000", "Sportsman 570"],
    );
  });

  test("a name two customers on file share, with nothing to tell which, is added apart once", async () => {
    for (const phone of ["5552220001", "5552220002"]) {
      const made = await createCustomer(writer, { name: "Sam Twin", phone, email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" });
      assert.ok("id" in made);
    }
    const planned = plan([["Name", "Model"], ["Sam Twin", "RZR"]]).customers;
    const first = await send(writer, planned);
    assert.ok("outcomes" in first);
    assert.equal(first.outcomes[0].result, "created");
    assert.match(first.outcomes[0].note ?? "", /2 customers on file are called Sam Twin/);
    // Importing it again finds that one: it has no number either.
    const again = await send(writer, planned);
    assert.ok("outcomes" in again);
    assert.deepEqual([again.outcomes[0].result, again.outcomes[0].customerId, again.outcomes[0].vehiclesAdded], ["matched", first.outcomes[0].customerId, 0]);
    assert.equal((await listCustomers(writer.shop.id, { query: "sam twin" })).total, 3);
  });

  test("a customer's 250 units all go in, sent in parts", async () => {
    const units = Array.from({ length: 250 }, (_, index) => `Fleet Owner|814-555-0444|Unit model ${index}`);
    const planned = plan(csv(["Name|Phone|Model", ...units])).customers;
    const ids = new Set<string>();
    for (const batch of importBatches(planned)) {
      const result = await send(writer, batch);
      assert.ok("outcomes" in result, JSON.stringify(result));
      for (const outcome of result.outcomes) ids.add(outcome.customerId!);
    }
    assert.equal(ids.size, 1);
    const fleet = await getCustomer(writer.shop.id, [...ids][0]);
    assert.equal(fleet?.vehicles.length, 250);
    // Again: nothing new.
    for (const batch of importBatches(planned)) {
      const result = await send(writer, batch);
      assert.ok("outcomes" in result);
      assert.ok(result.outcomes.every((outcome) => outcome.vehiclesAdded === 0));
    }
    assert.ok("error" in (await send(writer, [{ ...planned[0], vehicles: Array.from({ length: 11 }, () => planned[0].vehicles).flat().slice(0, 1001) }])));
  });

  test("filling in a blank never overwrites an edit saved meanwhile", async () => {
    const made = await createCustomer(writer, { name: "Edit Race", phone: "8145550555", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" });
    assert.ok("id" in made);
    // An edit holds the row while the import reads the customer as blank.
    const client = await systemDb.$client.connect();
    await client.query("begin");
    await client.query("update customers set email = $1 where id = $2", ["edited@example.com", made.id]);
    const importing = send(writer, plan([["Name", "Phone", "Email", "City"], ["Edit Race", "814-555-0555", "imported@example.com", "Altoona"]]).customers);
    await sleep(300);
    await client.query("commit");
    client.release();
    const result = await importing;
    assert.ok("outcomes" in result);
    const after = await getCustomer(writer.shop.id, made.id);
    assert.equal(after?.customer.email, "edited@example.com");
    assert.equal(after?.customer.city, "Altoona");
  });

  test("the same file finds the same customer when two on file both fit", async () => {
    for (let i = 0; i < 2; i++) {
      const made = await createCustomer(writer, { name: "Dup Twice", phone: "8145550666", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" });
      assert.ok("id" in made);
    }
    const planned = plan([["Name", "Phone", "Model"], ["Dup Twice", "814-555-0666", "RZR"]]).customers;
    const first = await send(writer, planned);
    const second = await send(writer, planned);
    assert.ok("outcomes" in first && "outcomes" in second);
    assert.equal(first.outcomes[0].customerId, second.outcomes[0].customerId);
    assert.equal(second.outcomes[0].vehiclesAdded, 0);
  });

  test("names Postgres and JavaScript lower-case differently are still found", async () => {
    const planned = plan([["Name", "Phone"], ["ΝΙΚΟΣ ΠΑΠΑΔΟΠΟΥΛΟΣ", "814-555-0210"], ["İLKER YILMAZ", "814-555-0212"], ["JOSÉ ÁLVAREZ", "814-555-0213"]]).customers;
    const first = await send(writer, planned);
    const again = await send(writer, planned);
    assert.ok("outcomes" in first && "outcomes" in again);
    assert.deepEqual(first.outcomes.map((outcome) => outcome.result), ["created", "created", "created"]);
    assert.deepEqual(again.outcomes.map((outcome) => [outcome.result, outcome.customerId]), first.outcomes.map((outcome) => ["matched", outcome.customerId]));
  });

  test("a file name the audit log couldn't hold is tidied", async () => {
    const result = await importCustomers(writer, {
      importId: randomUUID(),
      fileName: `list\u0000${"x".repeat(253)}😀.csv`,
      customers: plan([["Name"], ["Name Tidy"]]).customers,
    });
    assert.ok("outcomes" in result, JSON.stringify(result));
  });

  test("two imports of the same people at once add each of them once", async () => {
    const rows = [["Name", "Phone", "Model"], ...Array.from({ length: 30 }, (_, index) => [`Racer ${index}`, `814-555-${String(1000 + index)}`, "RZR"])];
    const planned = plan(rows).customers;
    const [a, b] = await Promise.all([send(writer, planned), send(writer, planned)]);
    assert.ok("outcomes" in a && "outcomes" in b);
    const created = [...a.outcomes, ...b.outcomes].filter((outcome) => outcome.result === "created").length;
    assert.equal(created, 30);
    assert.equal((await listCustomers(writer.shop.id, { query: "racer", perPage: 100 })).total, 30);
    const vehicles = await systemDb
      .select({ count: sql<number>`count(*)::int` })
      .from(customerVehicles)
      .innerJoin(customers, eq(customers.id, customerVehicles.customerId))
      .where(sql`${customers.shopId} = ${writer.shop.id} and ${customers.name} like 'Racer %'`);
    assert.equal(vehicles[0].count, 30);
  });
});
