// Rebates (the Rebates tab): reading a Polaris rebate invoice's pages as
// OCR or a PDF's own text gives them (src/lib/rebate-rules.ts): the table's
// columns by its headings, each unit's lines, the amounts with the slips
// OCR makes on a ticked printout, the invoice's details and total, and an
// amount read again on its own; finding each unit in the NUSR by its VIN
// (OCR's slips and the NUSR's typos allowed for, the check digit saying
// which), by name and date for a sale with no VIN, a sale given to one
// line; what's noted to check; what goes in AO, AP and AQ; the workbook
// (src/lib/rebate-export.ts): the NUSR sheet with the rebate columns in AO
// to AQ and the app's moved along, and the Rebates sheet; and the lookups
// and download on the server (src/lib/rebates.ts), kept to the shop and to
// those who can open the NUSR; and Saved rebates: saving an invoice (again
// only in place of the one saved, when that's meant), its filters, the
// saved lines they find and what those come to, opening one again,
// removing one, the Activity log, and their download. Made-up invoices,
// customers and VINs only.
// The database tests need DATABASE_URL pointing at a disposable Postgres
// database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, asc, eq } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, rebateInvoices, rebateLines, shops, users } from "../src/db/schema";
import { describeAuditEntry } from "../src/lib/audit-log-rules";
import { logSale, removeSale } from "../src/lib/nusr";
import { nusrWorkbook } from "../src/lib/nusr-export";
import { blankSaleValues, monthlyComparison, withFigures, type SaleFields, type SaleValues } from "../src/lib/nusr-rules";
import { invoicesTitle, lineRebate, rebateWorkbook, rebatesBySale, type RebateInvoice, type RebateSale } from "../src/lib/rebate-export";
import {
  NO_TABLE,
  NO_UNITS,
  amountsAddUp,
  invoicePrograms,
  isWholeVin,
  matchItems,
  nameLikeness,
  pageLines,
  parseRebateFilters,
  programColumn,
  readAmount,
  readInvoice,
  readInvoiceDate,
  rebateCells,
  rebateFiltersSearch,
  rebateFiltersTitle,
  rebatesFileName,
  reconcileAmounts,
  saleNotes,
  savedRebatesFileName,
  settleAmounts,
  vinDistance,
  vinGuess,
  wordsFromTsv,
  type Invoice,
  type InvoicePage,
  type InvoiceWord,
  type MatchUnit,
} from "../src/lib/rebate-rules";
import {
  findRebateSales,
  listSavedInvoices,
  listSavedRebates,
  openSavedInvoice,
  rebateDownload,
  removeSavedInvoice,
  saveRebateInvoice,
  savedInvoiceYears,
  savedRebatesDownload,
  searchRebateSales,
} from "../src/lib/rebates";
import type { CurrentUser } from "../src/lib/session";
import { vinCheckDigit } from "../src/lib/vin";
import { readXlsx } from "../src/lib/xlsx";
import type { Cell, Sheet } from "../src/lib/xlsx-write";

// A whole VIN from its other 16 characters, "_" where the check digit goes.
const whole = (pattern: string) => pattern.replace("_", vinCheckDigit(pattern.replace("_", "0"))!);

const RANGER = whole("4XARRM99_V8000101");
const RANGER_2 = whole("4XARRM99_V8000177");
const SPORTSMAN = whole("4XASEA50_TA200301");
const SPORTSMAN_2 = whole("4XASEA50_TA200388");
const RZR = whole("3NSNEY99_TF300042");
const YOUTH = whole("RF3YKA11_TT400017");

// --- A made-up invoice, laid out as the portal prints it ----------------------

// In OCR's pixels at 300 dpi: a line of print is 24 tall and 38 apart; the
// headings sit where the portal's printout has them.
const HEIGHT = 24;
const PART_LEFT = 590;
const DESCRIPTION_LEFT = 845;
const PRICE_RIGHT = 2124;
const AMOUNT_RIGHT = 2381;

type Row = { part?: string; text?: string; price?: string; amount?: string; tick?: string };
// A printed line outside the table: each word, where it starts, and its width when it isn't the usual.
type Printed = [string, number, number?][];

// A page of words as Tesseract gives them (each with its line), or as a
// PDF's own text gives them (no lines: `text: true`).
function invoicePage({ above = [], rows = [], below = [], heading = true, text = false }: { above?: Printed[]; rows?: Row[]; below?: Printed[]; heading?: boolean; text?: boolean }): InvoicePage {
  const words: InvoiceWord[] = [];
  let y = 100;
  let line = 0;
  const put = (cells: [string, number, number?][]) => {
    line++;
    for (const [value, left, width] of cells) {
      words.push({ text: value, left, top: y, width: width ?? value.length * 20, height: HEIGHT, ...(text ? {} : { line: `1.1.${line}` }) });
    }
    y += 38;
  };
  for (const cells of above) put(cells);
  if (heading) {
    put([
      ["Part", PART_LEFT, 71],
      ["Description", DESCRIPTION_LEFT, 197],
      ["Unit", 1960, 69],
      ["Price", 2043, PRICE_RIGHT - 2043],
      ["Amount", 2244, AMOUNT_RIGHT - 2244],
    ]);
  }
  for (const row of rows) {
    const cells: [string, number, number?][] = [];
    if (row.part) cells.push([row.part, PART_LEFT, 56]);
    let x = DESCRIPTION_LEFT;
    for (const word of (row.text ?? "").split(" ").filter(Boolean)) {
      cells.push([word, x]);
      x += word.length * 20 + 14;
    }
    if (row.price) cells.push([row.price, PRICE_RIGHT - row.price.length * 17, row.price.length * 17]);
    if (row.amount) cells.push([row.amount, AMOUNT_RIGHT - row.amount.length * 17, row.amount.length * 17]);
    if (row.tick) cells.push([row.tick, AMOUNT_RIGHT + 14, 30]);
    put(cells);
  }
  for (const cells of below) put(cells);
  return { words };
}

// A unit's four lines as Polaris prints them, the credit on the first.
const unit = (part: string, vin: string, model: string, amount: string, program: string, bought: string, name: string, tick?: string): Row[] => [
  { part, text: `${vin}/${model}`, price: "$0.00", amount, tick },
  { text: program, price: "$0.00", amount: "$0.00" },
  { text: `PUR:${bought} PD:${bought}`, price: "$0.00", amount: "$0.00" },
  { text: name, price: "$0.00", amount: "$0.00" },
];

const TOP: Printed[] = [
  [
    ["10/30/26,", 206],
    ["7:01", 380],
    ["AM", 460],
    ["Invoice", 1404],
    ["Print", 1511],
  ],
  [
    ["Invoice", 228],
    ["-", 367],
    ["314886", 392],
    ["Type:Rebate", 545],
  ],
  [
    ["Customer", 330],
    ["Invoice", 1496],
    ["Date", 1639],
    ["Order", 2027],
    ["Number", 2136],
  ],
  [
    ["02106000", 330],
    ["10/29/26", 1498],
    ["R27A6V3", 2027],
  ],
];
const FOOT: Printed = [
  ["https://apps.polarisportal.com/accred/InvoicePrintNew.asp?UniqueID=1", 150, 1800],
  ["7/12", 2290],
];
const SUMMARY: Printed[] = [
  [["Summary", 210]],
  [
    ["Tax", 1880],
    ["Discount", 2010],
    ["Total", 2240, 90],
  ],
  [
    ["$0.00", 1880],
    ["$0.00", 2010],
    ["-$2,604.17", 2160, 170],
  ],
];

// Two pages: a Ranger whose amount has a tick through it, a Sportsman whose
// lines go over the page, a RZR whose minus was lost, a youth unit whose
// dollar sign was read as a 6, and a page foot and summary that aren't units
// (without the summary, there's no total).
function samplePages({ summary = true }: { summary?: boolean } = {}): InvoicePage[] {
  return [
    invoicePage({
      above: TOP,
      rows: [
        ...unit("012", RANGER, "R27RRM99A", "-$796.22y/", "US RGR NSR 2H 2026 R", "08/21/26", "DANA QUILLFEATHER"),
        ...unit("011", SPORTSMAN, "A26SEA50B", "-$227.47", "US ATV NSR 2H 2026 R", "09/04/26", "WREN HOLLOWAY").slice(0, 2),
      ],
      below: [FOOT],
    }),
    invoicePage({
      above: [[["10/30/26,", 206], ["7:01", 380]]],
      rows: [
        { text: "PUR:09/04/26 PD:09/09/26", price: "$0.00", amount: "$0.00" },
        { text: "WREN HOLLOWAY", price: "$0.00", amount: "$0.00" },
        ...unit("013", RZR, "Z26NEY99A", "$1,350.00", "US RZR NSR 2H 2026 R", "07/10/26", "NICOLE AND TODD VARGA", "V"),
        ...unit("047", YOUTH, "A26YKA11B", "-6230.48v/", "US YTH NSR 2H 2026 R", "07/15/26", "PIP ODELL"),
      ],
      below: [...(summary ? SUMMARY : []), FOOT],
    }),
  ];
}

const read = (pages: InvoicePage[]) => {
  const invoice = readInvoice(pages);
  assert.ok(!("error" in invoice), JSON.stringify(invoice));
  return invoice;
};

describe("reading an invoice", () => {
  test("its number, type, date and total, and each unit's lines, from OCR's words", () => {
    const invoice = read(samplePages());
    assert.deepEqual([invoice.number, invoice.type, invoice.date, invoice.total?.cents, invoice.pages], ["314886", "Rebate", "2026-10-29", 260417, 2]);
    assert.deepEqual(
      invoice.lines.map((line) => [line.line, line.page, line.part, line.vinRead, line.modelCode, line.amount.cents, line.unitPrice.cents]),
      [
        [1, 1, "012", RANGER, "R27RRM99A", 79622, 0],
        [2, 1, "011", SPORTSMAN, "A26SEA50B", 22747, 0],
        [3, 2, "013", RZR, "Z26NEY99A", 135000, 0],
        [4, 2, "047", YOUTH, "A26YKA11B", 23048, 0],
      ],
    );
    const [ranger, sportsman, rzr] = invoice.lines;
    assert.deepEqual([ranger.programs, ranger.dates, ranger.purchased, ranger.names], [["US RGR NSR 2H 2026 R"], ["PUR:08/21/26 PD:08/21/26"], ["2026-08-21"], ["DANA QUILLFEATHER"]]);
    // Its lines go on over the page; the page's foot isn't one of them.
    assert.deepEqual([sportsman.purchased, sportsman.names, sportsman.other], [["2026-09-04"], ["WREN HOLLOWAY"], []], "lines over the page");
    assert.deepEqual(rzr.names, ["NICOLE AND TODD VARGA"]);
    // The summary and the handwriting under it aren't a unit's.
    assert.equal(invoice.lines.at(-1)!.names.join(), "PIP ODELL");
    // The amounts add up to the total, so every one is sure, even the one
    // whose dollar sign was read as a 6.
    assert.deepEqual(amountsAddUp(invoice), { sum: 260417, total: 260417, apart: 0 });
    assert.ok(invoice.lines.every((line) => line.amount.sure));
  });

  test("where each amount is, to read it again: the Amount column's right edge, a little past it", () => {
    const [line] = read(samplePages()).lines;
    assert.ok(line.amountBox.right > AMOUNT_RIGHT && line.amountBox.right < AMOUNT_RIGHT + HEIGHT);
    assert.ok(line.amountBox.left > PRICE_RIGHT, "the Unit Price column is left out");
    assert.ok(line.amountBox.top < 100 + 38 * 5 + HEIGHT / 2 && line.amountBox.bottom > 100 + 38 * 5 + HEIGHT / 2);
  });

  test("a page whose headings row OCR missed: its head isn't taken for a unit's lines", () => {
    const pages = samplePages();
    pages[1] = invoicePage({
      above: [[["10/30/26,", 206], ["7:01", 380], ["AM", 460], ["Invoice", 1404], ["Print", 1511]], [["Parts", 211]], [["Ord", 242], ["Ship", 360], ["Part", 592], ["Descripfion", 847], ["Unit", 1960], ["Prlce", 2043], ["Am0unt", 2244]]],
      heading: false,
      rows: [{ text: "PUR:09/04/26 PD:09/09/26", price: "$0.00", amount: "$0.00" }, { text: "WREN HOLLOWAY", price: "$0.00", amount: "$0.00" }],
      below: [FOOT],
    });
    const sportsman = read(pages).lines[1];
    assert.deepEqual([sportsman.names, sportsman.other, sportsman.purchased], [["WREN HOLLOWAY"], [], ["2026-09-04"]]);
  });

  test("a PDF's own text, with no OCR lines, reads the same", () => {
    const pages = samplePages().map((page) => ({ words: page.words.map(({ text, left, top, width, height }) => ({ text, left, top, width, height })) }));
    const invoice = read(pages);
    assert.deepEqual(
      invoice.lines.map((line) => [line.vinRead, line.amount.cents, line.names.join()]),
      [
        [RANGER, 79622, "DANA QUILLFEATHER"],
        [SPORTSMAN, 22747, "WREN HOLLOWAY"],
        [RZR, 135000, "NICOLE AND TODD VARGA"],
        [YOUTH, 23048, "PIP ODELL"],
      ],
    );
  });

  test("a line OCR split in two (the amounts in a block of their own) is put back together", () => {
    const words: InvoiceWord[] = [
      { text: "012", left: 590, top: 500, width: 56, height: 24, line: "1.1.1" },
      { text: `${RANGER}/R27RRM99A`, left: 845, top: 500, width: 560, height: 24, line: "1.1.1" },
      { text: "$0.00", left: 2039, top: 506, width: 85, height: 30, line: "2.1.1" },
      { text: "-$796.22", left: 2240, top: 497, width: 141, height: 40, line: "3.1.1" },
      { text: "US", left: 845, top: 538, width: 41, height: 24, line: "1.1.2" },
    ];
    const { lines } = pageLines(words);
    assert.deepEqual(
      lines.map((line) => line.text),
      [`012 ${RANGER}/R27RRM99A $0.00 -$796.22`, "US"],
    );
  });

  test("Tesseract's TSV, every word kept with its line", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "4\t1\t1\t1\t1\t0\t590\t500\t1800\t40\t-1\t",
      "5\t1\t1\t1\t1\t1\t590\t500\t56\t24\t96\t012",
      "5\t1\t1\t1\t1\t2\t2207\t497\t210\t57\t0\t-$1,494.97y/",
      "5\t1\t1\t1\t1\t3\t2400\t497\t10\t20\t5\t ",
    ].join("\n");
    assert.deepEqual(wordsFromTsv(tsv), [
      { text: "012", left: 590, top: 500, width: 56, height: 24, line: "1.1.1" },
      { text: "-$1,494.97y/", left: 2207, top: 497, width: 210, height: 57, line: "1.1.1" },
    ]);
  });

  test("not an invoice, or one with no units", () => {
    assert.deepEqual(readInvoice([invoicePage({ above: TOP, heading: false })]), { error: NO_TABLE });
    assert.deepEqual(readInvoice([invoicePage({ above: TOP, rows: [{ text: "SHIPPING", price: "$0.00", amount: "$12.00" }] })]), { error: NO_UNITS });
  });

  test("dates as printed, with OCR's slips", () => {
    assert.equal(readInvoiceDate("08/21/26"), "2026-08-21");
    assert.equal(readInvoiceDate("PUR:(8/26/26"), "2026-08-26");
    assert.equal(readInvoiceDate("C8/26/2026"), "2026-08-26");
    assert.equal(readInvoiceDate("13/40/26"), null);
    assert.equal(readInvoiceDate("06/1-/26"), null);
  });
});

describe("amounts", () => {
  test("as printed, and as OCR reads them with a tick beside or through them", () => {
    const cases: [string, number | null, boolean][] = [
      ["-$1,494.97", 149497, true],
      ["-$1,494.97y/", 149497, true],
      ["~$549.98,/", 54998, true],
      ["“$324.97", 32497, true],
      ["$714.97", 71497, true],
      ["$0.00", 0, true],
      // The dollar sign read as a figure: the first figure goes.
      ["-6796.22v/", 79622, false],
      ["4659.72", 65972, false],
      // A comma for the decimal point, a tick read as a third figure of
      // cents, no dollar sign.
      ["-$519,97", 51997, false],
      ["$662,487", 66248, false],
      ["-$174.987", 17498, false],
      ["1,111.47", 111147, false],
      ["V", null, false],
    ];
    for (const [text, cents, sure] of cases) {
      const amount = readAmount([text]);
      assert.deepEqual([amount.cents, amount.sure], [cents, sure], text);
    }
    assert.deepEqual(readAmount(["-6796.22v/"]).others, [679622]);
    assert.equal(readAmount([]).cents, null);
  });

  test("the word that's the amount, not a stray figure or tick beside it", () => {
    assert.equal(readAmount(["-$674.98", "4"]).cents, 67498);
    assert.equal(readAmount(["1.00", "-$659.72"]).cents, 65972);
    assert.equal(readAmount(["-$779.97", "V4"]).cents, 77997);
  });

  test("the total settles a reading that could go two ways", () => {
    const amounts = [readAmount(["-$796.22"]), readAmount(["41,000.00"]), readAmount(["-$227.47"])];
    // 41,000.00 or 1,000.00: the total says which.
    assert.deepEqual(
      reconcileAmounts(amounts, -202369).map((amount) => amount.cents),
      [79622, 100000, 22747],
    );
    // No total, or none that fits: as read.
    assert.deepEqual(
      reconcileAmounts(amounts, null).map((amount) => amount.cents),
      [79622, 4100000, 22747],
    );
    assert.deepEqual(
      reconcileAmounts(amounts, -5).map((amount) => amount.cents),
      [79622, 4100000, 22747],
    );
  });

  test("an amount read again on its own: two readings that agree are sure; the second, without the tick, otherwise", () => {
    const pages = samplePages({ summary: false });
    // A tick turned -$796.22 into "-$706.22 7" and there's no total to say.
    pages[0].words.find((word) => word.text === "-$796.22y/")!.text = "~$706.227";
    const invoice = read(pages);
    assert.deepEqual([invoice.total, invoice.lines[0].amount.cents, invoice.lines[0].amount.sure], [null, 70622, false]);
    const settled = settleAmounts(invoice, new Map([[1, "-$796.22"]]));
    assert.deepEqual([settled.lines[0].amount.cents, settled.lines[0].amount.sure, settled.lines[0].amount.others], [79622, true, [70622]]);
    // The second reading agrees with the first: sure.
    const youth = invoice.lines[3];
    assert.equal(youth.amount.sure, false);
    assert.equal(settleAmounts(invoice, new Map([[4, "-$230.48,"]])).lines[3].amount.sure, true);
    // Read again with a tick still in it: the second, still to check.
    const again = settleAmounts(invoice, new Map([[1, "-$796.221"]])).lines[0].amount;
    assert.deepEqual([again.cents, again.sure], [79622, false]);
  });

  test("when they add up to the invoice's total, every amount is sure", () => {
    const invoice: Invoice = { ...read(samplePages()) };
    const unsure = { ...invoice, lines: invoice.lines.map((line) => ({ ...line, amount: { ...line.amount, sure: false } })) };
    assert.ok(settleAmounts(unsure, new Map()).lines.every((line) => line.amount.sure));
    assert.deepEqual(amountsAddUp({ lines: [], total: null }), { sum: 0, total: null, apart: null });
  });
});

describe("VINs", () => {
  test("how far a VIN as read is from one on file", () => {
    assert.equal(vinDistance(RANGER, RANGER), 0);
    // OCR's 9 for S, and an extra S in front of a 5.
    assert.equal(vinDistance(RANGER.replace("RM99", "RMS9"), RANGER), 0.4);
    assert.equal(vinDistance(SPORTSMAN.replace("A50", "AS50"), SPORTSMAN), 0.5);
    assert.equal(vinDistance(RANGER.slice(0, 14) + "?" + RANGER.slice(15), RANGER), 0.5);
    // Two swapped, as typed.
    assert.equal(vinDistance("3NSXAL1R2TM287447", "3NSAXL1R2TM287447"), 1);
    assert.ok(vinDistance(RANGER, SPORTSMAN) > 5);
  });

  test("a whole VIN has its check digit", () => {
    assert.ok(isWholeVin(RANGER));
    assert.ok(!isWholeVin(RANGER.replace("RM99", "RMS9")));
    assert.ok(!isWholeVin(RANGER.slice(1)));
    assert.ok(!isWholeVin(null));
    assert.equal(vinGuess("3NSXPEQ29TG23O663"), "3NSXPE029TG230663");
  });
});

describe("finding the units in the NUSR", () => {
  const sale = (id: string, vin: string | null, customerName: string, soldOn: string, condition: "new" | "used" = "new"): MatchUnit => ({ id, vin, customerName, soldOn, condition });
  const item = (key: string, vinRead: string, names: string[] = [], purchased: string[] = []) => ({ key, vinRead, names, purchased });
  const nusr = [
    sale("ranger", RANGER, "Dana Quillfeather", "2026-08-21"),
    sale("ranger-traded", RANGER, "Dana Quillfeather", "2027-03-02", "used"),
    sale("ranger-2", RANGER_2, "Sol Barrow", "2026-08-24"),
    sale("sportsman", SPORTSMAN, "Wren Holloway", "2026-09-04"),
    // Typed into the NUSR with two characters swapped: its check digit fails.
    sale("rzr", RZR.slice(0, 4) + RZR[5] + RZR[4] + RZR.slice(6), "Nicole and Todd Varga", "2026-07-10"),
    sale("fire-company", null, "Clymer FD", "2026-09-04"),
    sale("other", whole("4XASEA50_TA200399"), "Ida Pruitt", "2026-09-03"),
  ];

  test("by the VIN as read, the new sale nearest the purchase date", () => {
    const [match] = matchItems([item("1", RANGER, ["DANA QUILLFEATHER"], ["2026-08-21"])], nusr);
    assert.deepEqual([match.saleId, match.how, match.candidates], ["ranger", "vin", ["ranger", "ranger-traded"]]);
  });

  test("a VIN OCR got a character or two wrong, when one on file is clearly nearest", () => {
    const [ranger, sportsman] = matchItems([item("1", RANGER.replace("RM99", "RMS9")), item("2", SPORTSMAN.replace("A50", "AS50"))], nusr);
    assert.deepEqual([ranger.saleId, ranger.how], ["ranger", "read"]);
    assert.deepEqual([sportsman.saleId, sportsman.how], ["sportsman", "read"]);
  });

  test("the NUSR's typo: the invoice's VIN is whole, the one on file fails its check digit", () => {
    const [match] = matchItems([item("1", RZR)], nusr);
    assert.deepEqual([match.saleId, match.how], ["rzr", "typo"]);
  });

  test("a whole VIN a character or two from another whole VIN is a different unit", () => {
    const [match] = matchItems([item("1", SPORTSMAN_2, ["MILO GRANT"], ["2026-09-05"])], nusr);
    assert.equal(match.saleId, null);
    assert.ok(!match.candidates.includes("sportsman"));
  });

  test("two on file as near as each other: offered, not picked", () => {
    // The check digit and the last two figures not made out.
    const read = `${RANGER.slice(0, 8)}?${RANGER.slice(9, 15)}??`;
    const [match] = matchItems([item("1", read)], [sale("a", RANGER, "A", "2026-01-01"), sale("b", RANGER_2, "B", "2026-01-01")]);
    assert.equal(match.saleId, null);
    assert.deepEqual([...match.candidates].sort(), ["a", "b"]);
  });

  test("by the name and purchase date, for a sale the NUSR has no VIN for", () => {
    const [match] = matchItems([item("1", whole("3NESEA50_TN321384"), ["CLYMER VOLUNTEER FIRE COMP"], ["2026-09-04"])], nusr);
    assert.deepEqual([match.saleId, match.how], ["fire-company", "name"]);
    // Weeks away, it's only offered; nor is a sale with a whole VIN of its
    // own taken by name.
    const [late] = matchItems([item("1", whole("3NESEA50_TN321384"), ["CLYMER VOLUNTEER FIRE COMP"], ["2026-09-12"])], nusr);
    assert.deepEqual([late.saleId, late.candidates], [null, ["fire-company"]]);
    const [named] = matchItems([item("1", whole("3NESEA50_TN999999"), ["IDA PRUITT"], ["2026-09-03"])], nusr);
    assert.deepEqual([named.saleId, named.candidates], [null, ["other"]]);
  });

  test("a sale goes to one line; the same VIN twice on the invoice is noted on both", () => {
    const [first, near] = matchItems([item("1", RANGER), item("2", RANGER.replace("RM99", "RMS9"))], nusr);
    assert.deepEqual([first.saleId, near.saleId], ["ranger", null]);
    const [one, two] = matchItems([item("1", RANGER), item("2", RANGER)], nusr);
    assert.deepEqual([one.saleId, two.saleId, one.sharedWith, two.sharedWith], ["ranger", "ranger", ["2"], ["1"]]);
  });

  test("names alike, either way round and with a letter off", () => {
    assert.equal(nameLikeness("Nicole and Todd Volk", "TODD VOLK"), 1);
    assert.equal(nameLikeness("Thomas Wentroble III", "THOMAS WENTROBLE"), 1);
    assert.equal(nameLikeness("Samuel Homes", "SAMUEL HOLMES"), 1);
    assert.equal(nameLikeness("Clymer FD", "CLYMER VOLUNTEER FIRE COMP"), 0.5);
    assert.equal(nameLikeness("Andel Inc", "DAVID SHAFFER"), 0);
    assert.equal(nameLikeness("", "DAVID SHAFFER"), 0);
  });
});

describe("notes, columns and AO, AP and AQ", () => {
  test("what's worth a look about the sale a line was found as", () => {
    const fine = { vin: RANGER, condition: "new" as const, holdback: 97996 };
    assert.deepEqual(saleNotes({ vinRead: RANGER, how: "vin", sharedWith: [] }, fine, "addlHoldback"), []);
    assert.deepEqual(
      saleNotes({ vinRead: RANGER.replace("RM99", "RMS9"), how: "read", sharedWith: [] }, fine, "addlHoldback").map((note) => [note.check, note.text]),
      [[false, `VIN read as ${RANGER.replace("RM99", "RMS9")}.`]],
    );
    const swapped = RZR.slice(0, 4) + RZR[5] + RZR[4] + RZR.slice(6);
    assert.ok(!isWholeVin(swapped));
    const typo = saleNotes({ vinRead: RZR, how: "typo", sharedWith: [] }, { ...fine, vin: swapped }, "addlHoldback");
    assert.deepEqual([typo[0].check, typo[0].correct], [true, true]);
    assert.match(typo[0].text, /isn't a whole VIN.*the invoice's is/);
    assert.match(saleNotes({ vinRead: RZR, how: "name", sharedWith: [] }, { ...fine, vin: null }, "addlHoldback")[0].text, /no VIN for this sale: it was found by the name/);
    assert.match(saleNotes({ vinRead: RANGER, how: "vin", sharedWith: [3] }, fine, "addlHoldback")[0].text, /Line 3 found the same sale/);
    assert.match(saleNotes({ vinRead: RANGER, how: "vin", sharedWith: [] }, { ...fine, condition: "used", holdback: 0 }, "addlHoldback")[0].text, /as used.*no holdback for AO/);
    assert.match(saleNotes({ vinRead: RANGER, how: "vin", sharedWith: [] }, { ...fine, holdback: 0 }, "addlHoldback")[0].text, /no holdback on this sale/);
    // Retail rewards don't fill AO in: no holdback is nothing to note.
    assert.deepEqual(saleNotes({ vinRead: RANGER, how: "vin", sharedWith: [] }, { ...fine, holdback: 0 }, "retailRewards"), []);
  });

  test("which column a program's amounts go in, by Polaris's words for it", () => {
    assert.equal(programColumn("US RGR NSR 2H 2026 R"), "addlHoldback");
    assert.equal(programColumn("US RGR RETAIL REWARDS JUL-AUG 2026"), "retailRewards");
    assert.equal(programColumn("US RZR RTL RWDS 2026"), "retailRewards");
    assert.equal(programColumn("US ATV HOLDBACK Q3 2026"), "holdback");
    assert.equal(programColumn("US RGR N5R 2H 2026 R"), null);
    assert.equal(programColumn("DEALERCERT ATV-26-051-A"), null);
  });

  test("an invoice's column: what most of its lines' programs say, a misread line or two outvoted", () => {
    const lines = (...programs: string[][]) => programs.map((list) => ({ programs: list }));
    const nsr = invoicePrograms(lines(["US RGR NSR 2H 2026 R"], ["US RGR NSR 2H 2026 R"], ["US RZR NSR 2H 2026 R", "US RGR NSR 2H 2026 R"], ["US RR NSR"], ["US RGR RR 2026"], []));
    assert.deepEqual(nsr, {
      column: "addlHoldback",
      lines: { addlHoldback: 4, retailRewards: 1 },
      programs: ["US RGR NSR 2H 2026 R", "US RZR NSR 2H 2026 R", "US RR NSR", "US RGR RR 2026"],
    });
    assert.equal(invoicePrograms(lines(["US RGR RETAIL REWARDS JUL-AUG 2026"], ["US ATV RETAIL REWARDS JUL-AUG 2026"])).column, "retailRewards");
    // As many lines say one as the other, or none say: it's for someone to pick.
    assert.equal(invoicePrograms(lines(["US RGR NSR 2H 2026 R"], ["US RGR RETAIL REWARDS 2026"])).column, null);
    assert.deepEqual(invoicePrograms(lines(["US RGR SPRING 2026"], [])), { column: null, lines: {}, programs: ["US RGR SPRING 2026"] });
    assert.equal(invoicePrograms([]).column, null);
  });

  test("a sale's AO, AP and AQ: each line's amount in its column, and the NUSR's holdback in AO beside an additional holdback", () => {
    assert.deepEqual(rebateCells([{ column: "addlHoldback", cents: 149497 }], 183996), { holdback: 183996, retailRewards: null, addlHoldback: 149497 });
    assert.deepEqual(rebateCells([{ column: "retailRewards", cents: 30000 }], 183996), { holdback: null, retailRewards: 30000, addlHoldback: null });
    assert.deepEqual(
      rebateCells(
        [
          { column: "addlHoldback", cents: 100 },
          { column: "addlHoldback", cents: 50 },
          { column: "holdback", cents: 184000 },
        ],
        183996,
      ),
      { holdback: 184000, retailRewards: null, addlHoldback: 150 },
    );
    // No holdback on the sale: AO stays blank.
    assert.deepEqual(rebateCells([{ column: "addlHoldback", cents: 66248 }], 0).holdback, null);
  });

  test("Saved rebates' filters, from the address and back", () => {
    assert.deepEqual(parseRebateFilters({}, 2026), { year: 2026, month: null, column: null, salesperson: null, category: null, status: null, query: "" });
    const picked = parseRebateFilters(
      { year: "2025", month: "12", column: "retailRewards", salesperson: "  Lee   Brandvold ", category: "UTV", status: "missing", q: " quill  feather " },
      2026,
    );
    assert.deepEqual(picked, { year: 2025, month: 12, column: "retailRewards", salesperson: "Lee Brandvold", category: "UTV", status: "missing", query: "quill feather" });
    assert.deepEqual(parseRebateFilters(rebateFiltersSearch(picked, 2026).slice(1).split("&").reduce<Record<string, string>>((all, pair) => {
      const [key, value] = pair.split("=").map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
      return { ...all, [key]: value };
    }, {}), 2026), picked);
    // A month only within a year; this year unless another (or every one) is asked for.
    assert.deepEqual(parseRebateFilters({ year: "all", month: "3" }, 2026), { ...parseRebateFilters({}, 2026), year: null });
    assert.deepEqual(parseRebateFilters({ year: "1999", month: "13", column: "rebate", status: "maybe" }, 2026), parseRebateFilters({}, 2026));
    assert.equal(rebateFiltersSearch(parseRebateFilters({}, 2026), 2026), "");
    assert.equal(rebateFiltersSearch({ ...parseRebateFilters({}, 2026), year: null }, 2026, { page: 2, open: null }), "?year=all&page=2");
    assert.equal(rebateFiltersTitle(parseRebateFilters({}, 2026)), "2026");
    assert.equal(rebateFiltersTitle({ ...picked, year: 2026, month: 10, column: "addlHoldback", category: null, status: null, query: "" }), "October 2026 · Add'l holdback (AQ) · Lee Brandvold");
    assert.equal(rebateFiltersTitle({ ...picked, year: null }), "All years · Retail rewards (AP) · Lee Brandvold · UTV · Not found · “quill feather”");
    assert.equal(savedRebatesFileName("October 2026 · “dana”", "2026-11-06"), "Rebates October 2026 · “dana” 2026-11-06.xlsx");
    assert.equal(savedRebatesFileName("2026 · A/B: C?", "2026-11-06"), "Rebates 2026 · A-B- C- 2026-11-06.xlsx");
  });

  test("the download's name", () => {
    assert.equal(rebatesFileName(["314886"], "2026-11-06"), "Rebates 314886 2026-11-06.xlsx");
    assert.equal(rebatesFileName(["1", "2", "3", "4", "1"], "2026-11-06"), "Rebates 1 2 3 and 1 more 2026-11-06.xlsx");
    assert.equal(rebatesFileName([null], "2026-11-06"), "Rebates 2026-11-06.xlsx");
    assert.equal(invoicesTitle([{ number: "314886" }, { number: "314901" }, { number: null }]), "Invoices 314886 and 314901");
  });
});

// --- The workbook ---------------------------------------------------------------

const BLANK: SaleFields = {
  soldOn: "2026-01-02",
  salesperson: null,
  customerName: "Dana Quillfeather",
  customerAddress: null,
  customerPhone: null,
  unitYear: 2026,
  unitModel: null,
  condition: "new",
  unitType: "whole_good",
  vin: null,
  category: null,
  notes: null,
  financeCompany: null,
  fundingReceivedOn: null,
  paidOn: null,
  comsNumber: null,
  msrp: null,
  salesPrice: null,
  dealerCost: null,
  unitLabor: null,
  rebate: null,
  accPrice: null,
  accCost: null,
  accLabor: null,
  escPrice: null,
  escCost: null,
  rewards: null,
  amountFinanced: null,
  downPayment: null,
  bonusAdjustment: null,
  holdbackRateBp: 400,
  bonusRateBp: 1000,
};
const figured = (id: string, fields: Partial<SaleFields>): RebateSale => ({ ...withFigures({ ...BLANK, ...fields }), id });

const SALES = [
  figured("s1", { soldOn: "2026-08-21", salesperson: "Lee Brandvold", customerName: "Dana Quillfeather", unitModel: "Rngr 1000XP", vin: RANGER, category: "UTV", msrp: 2_449_900 }),
  figured("s2", { soldOn: "2026-09-04", salesperson: "Sam Ortiz", customerName: "Wren Holloway", unitModel: "Spm 450", vin: SPORTSMAN, category: "ATV", msrp: 699_900 }),
  figured("s3", { soldOn: "2026-03-01", salesperson: "Sam Ortiz", customerName: "Ida Pruitt", unitModel: "General 1000", category: "UTV", msrp: 2_999_900 }),
];

const INVOICE: RebateInvoice = {
  fileName: "invoice.pdf",
  number: "314886",
  type: "Rebate",
  date: "2026-10-29",
  total: -102369 - 10000,
  column: "addlHoldback",
  lines: [
    { line: 1, part: "012", vinRead: RANGER, modelCode: "R27RRM99A", programs: ["US RGR NSR 2H 2026 R"], dates: ["PUR:08/21/26"], names: ["DANA QUILLFEATHER"], unitPrice: 0, amount: 79622, saleId: "s1" },
    { line: 2, part: "011", vinRead: SPORTSMAN.replace("A50", "AS50"), modelCode: null, programs: [], dates: [], names: ["WREN HOLLOWAY"], unitPrice: 0, amount: 22747, saleId: "s2" },
    { line: 3, part: "011", vinRead: whole("3NESEA50_TN321384"), modelCode: null, programs: [], dates: [], names: ["NOT ON FILE"], unitPrice: 0, amount: 10000, saleId: null },
  ],
};

const rowsOf = (sheet: Sheet) => sheet.rows;
const valueOf = (cell: Cell | undefined) => (cell !== null && typeof cell === "object" && !(cell instanceof Date) ? cell.value : cell);
const formulaOf = (cell: Cell | undefined) => (cell !== null && typeof cell === "object" && !(cell instanceof Date) && "formula" in cell ? cell.formula : null);
// A cell by its address, "AO3".
function at(sheet: Sheet, address: string) {
  const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(address)!;
  const column = [...letters].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return rowsOf(sheet)[Number(digits) - 1]?.[column];
}

describe("the workbook", () => {
  test("the NUSR sheet: the rebate columns in AO to AQ, the app's moved along to AR to AU, their formulas following", () => {
    const [nusr] = rebateWorkbook([INVOICE], SALES, { generatedAt: new Date("2026-11-06T20:00:00Z"), timeZone: "America/New_York" });
    assert.equal(nusr.name, "NUSR");
    assert.deepEqual(
      ["AM1", "AN1", "AO1", "AP1", "AQ1", "AR1", "AS1", "AT1", "AU1"].map((address) => valueOf(at(nusr, address)) ?? null),
      ["Category", null, "Holdback", "Retail Rwds", "Add'l Hlbk", "Type", "Holdback %", "Bonus %", "Bonus adjustment"],
    );
    assert.equal(nusr.autoFilter, "B1:AU4");
    // The oldest first: the General (none), the Ranger, the Sportsman.
    assert.deepEqual(["D2", "D3", "D4"].map((address) => valueOf(at(nusr, address))), ["Ida Pruitt", "Dana Quillfeather", "Wren Holloway"]);
    // The Ranger: its additional holdback, and its holdback from the NUSR.
    assert.deepEqual(["AO3", "AP3", "AQ3"].map((address) => valueOf(at(nusr, address))), [979.96, null, 796.22]);
    assert.deepEqual(["AO2", "AQ2"].map((address) => valueOf(at(nusr, address))), [null, null]);
    assert.equal(formulaOf(at(nusr, "AA3")), "IF(ISNUMBER(K3),ROUND(K3*AS3,2),0)");
    assert.equal(formulaOf(at(nusr, "AD3")), "ROUND(AB3*AT3,2)");
    assert.equal(formulaOf(at(nusr, "AF3")), "AD3-AE3+AU3");
    assert.deepEqual([valueOf(at(nusr, "AS3")), valueOf(at(nusr, "AT3"))], [0.04, 0.1]);
    // TOTAL, under a spare row.
    assert.equal(valueOf(at(nusr, "C6")), "TOTAL");
    assert.deepEqual(
      ["AO6", "AQ6", "AU6"].map((address) => [formulaOf(at(nusr, address)), valueOf(at(nusr, address))]),
      [
        ["SUM(AO2:AO5)", 1259.92],
        ["SUM(AQ2:AQ5)", 1023.69],
        ["SUM(AU2:AU5)", 0],
      ],
    );
  });

  test("NUSR's own download keeps the app's columns in AN to AQ", () => {
    const [sheet] = nusrWorkbook(SALES, { title: "2026", comparison: monthlyComparison([]), generatedAt: new Date("2026-11-06T20:00:00Z") });
    assert.deepEqual(
      ["AN1", "AO1", "AP1", "AQ1"].map((address) => valueOf(at(sheet, address))),
      ["Type", "Holdback %", "Bonus %", "Bonus adjustment"],
    );
    assert.equal(rowsOf(sheet)[0].length, 43);
    assert.equal(formulaOf(at(sheet, "AA2")), "IF(ISNUMBER(K2),ROUND(K2*AO2,2),0)");
  });

  test("the Rebates sheet: the invoice against its total, every line beside its sale, by salesman and by category", () => {
    const sheets = rebateWorkbook([INVOICE], SALES, { generatedAt: new Date("2026-11-06T20:00:00Z"), timeZone: "America/New_York" });
    const rebates = sheets[1];
    assert.equal(rebates.name, "Rebates");
    const rows = rowsOf(rebates).map((row) => row.map(valueOf));
    assert.equal(rows[0][0], "Rebates · Invoice 314886");
    assert.equal(rows[1][0], "Downloaded November 6, 2026 at 3:00 PM");
    // Invoice, date, type, lines, column, its total, the lines', the difference.
    assert.deepEqual(rows[4].slice(2), ["Rebate", 3, "Add'l Hlbk (AQ)", -1123.69, -1123.69, 0]);
    const lines = rows.filter((row) => row[0] === "314886" && typeof row[1] === "number");
    assert.equal(lines.length, 3);
    const [ranger, sportsman, missing] = lines;
    assert.deepEqual(ranger.slice(8, 20), [0, -796.22, new Date("2026-08-21T00:00:00Z"), "Lee Brandvold", "Dana Quillfeather", "2026 Rngr 1000XP", "UTV", RANGER, 979.96, null, 796.22, null]);
    assert.equal(sportsman[19], `VIN read as ${SPORTSMAN.replace("A50", "AS50")}.`);
    assert.deepEqual([missing[12], missing[18], missing[19]], [null, 100, "Not found in the NUSR."]);
    const total = rows.find((row) => row[0] === "TOTAL")!;
    assert.deepEqual(total.slice(16, 19), [1259.92, 0, 1123.69]);
    const block = (heading: string) => {
      const start = rows.findIndex((row) => row[0] === heading);
      return rows.slice(start + 1, rows.findIndex((row, index) => index > start && row.length === 0));
    };
    assert.deepEqual(block("Salesman"), [
      ["Lee Brandvold", 1, 979.96, 0, 796.22],
      ["Not in the NUSR", 1, 0, 0, 100],
      ["Sam Ortiz", 1, 279.96, 0, 227.47],
    ]);
    assert.deepEqual(block("Category"), [
      ["ATV", 1, 279.96, 0, 227.47],
      ["Not in the NUSR", 1, 0, 0, 100],
      ["UTV", 1, 979.96, 0, 796.22],
    ]);
  });

  test("with nothing found in the NUSR, only the Rebates sheet", () => {
    const none = { ...INVOICE, lines: INVOICE.lines.map((line) => ({ ...line, saleId: null })) };
    assert.deepEqual(
      rebateWorkbook([none], SALES, { generatedAt: new Date(), timeZone: "UTC" }).map((sheet) => sheet.name),
      ["Rebates"],
    );
    assert.equal(rebatesBySale([none], new Map(SALES.map((sale) => [sale.id, sale]))).size, 0);
    assert.equal(lineRebate({ amount: null, unitPrice: 2500 }), 2500);
    assert.equal(lineRebate({ amount: 100, unitPrice: 2500 }), 100);
  });
});

// --- On the server --------------------------------------------------------------

describe("on the server: looking units up, the download, and Saved rebates", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let manager: CurrentUser;
  let other: CurrentUser;
  let writer: CurrentUser;
  const ids: Record<string, string> = {};

  async function person(code: string, role: "manager" | "service_writer", shop?: CurrentUser["shop"]): Promise<CurrentUser> {
    const created = shop ?? (await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name }))[0];
    if (!shop) shopIds.push(created.id);
    const id = randomUUID();
    await systemDb.insert(users).values({ id, shopId: created.id, role, name: "Morgan", username: `${created.code}.${role}`, displayUsername: role, email: `${randomUUID()}@no-email.invalid` });
    return { id, name: "Morgan", username: role, role, shop: created, bay: null };
  }

  async function sell(actor: CurrentUser, values: Partial<SaleValues>) {
    const result = await logSale(actor, { ...blankSaleValues({ soldOn: "2026-08-21", holdbackRateBp: 400, bonusRateBp: 1000 }), ...values });
    assert.ok("id" in result, JSON.stringify(result));
    return result.id;
  }

  before(async () => {
    manager = await person(`rb${suffix}`, "manager");
    other = await person(`ro${suffix}`, "manager");
    writer = await person("", "service_writer", manager.shop);
    ids.ranger = await sell(manager, { customerName: "Dana Quillfeather", salesperson: "Lee Brandvold", unitModel: "Rngr 1000XP", vin: RANGER, msrp: "24499", category: "UTV" });
    ids.fire = await sell(manager, { soldOn: "2026-09-04", customerName: "Clymer FD", unitModel: "Spm 450", category: "ATV" });
    ids.older = await sell(manager, { soldOn: "2025-12-30", customerName: "Ida Pruitt", unitModel: "General 1000", vin: RZR, msrp: "29999", category: "UTV" });
    // The same Ranger in another shop's NUSR.
    ids.elsewhere = await sell(other, { customerName: "Someone Else", vin: RANGER, msrp: "24499" });
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  test("an invoice's units found in the shop's own NUSR, with what the page shows of each", async () => {
    const result = await findRebateSales(manager, [
      { key: "1", vinRead: RANGER.replace("RM99", "RMS9"), names: ["DANA QUILLFEATHER"], purchased: ["2026-08-21"] },
      { key: "2", vinRead: whole("3NESEA50_TN321384"), names: ["CLYMER VOLUNTEER FIRE COMP"], purchased: ["2026-09-04"] },
      { key: "3", vinRead: whole("4XASEA50_TA999999"), names: [], purchased: [] },
    ]);
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.deepEqual(
      result.matches.map((match) => [match.key, match.saleId, match.how]),
      [
        ["1", ids.ranger, "read"],
        ["2", ids.fire, "name"],
        ["3", null, null],
      ],
    );
    const ranger = result.sales.find((sale) => sale.id === ids.ranger)!;
    assert.deepEqual(ranger, {
      id: ids.ranger,
      soldOn: "2026-08-21",
      customerName: "Dana Quillfeather",
      salesperson: "Lee Brandvold",
      unit: "Rngr 1000XP",
      vin: RANGER,
      category: "UTV",
      condition: "new",
      holdback: 97996,
    });
    assert.ok(!result.sales.some((sale) => sale.id === ids.elsewhere), "another shop's sale of the same VIN");
  });

  test("only for those who can open the NUSR, signed in with a password, and only an invoice's lines", async () => {
    const item = [{ key: "1", vinRead: RANGER, names: [], purchased: [] }];
    for (const actor of [writer, { ...manager, bay: { deviceId: "d", deviceName: "Bay 1", sessionId: "s" } }]) {
      assert.ok("error" in (await findRebateSales(actor, item)));
      assert.ok("error" in (await searchRebateSales(actor, "Dana")));
      assert.ok("error" in (await rebateDownload(actor, { invoices: [] })));
    }
    for (const bad of [null, [], "x", [{ key: 1, vinRead: RANGER }], [{ key: "1", vinRead: "X".repeat(40) }]]) {
      assert.ok("error" in (await findRebateSales(manager, bad)), JSON.stringify(bad));
    }
  });

  test("searching the shop's NUSR for a sale to pick", async () => {
    const found = await searchRebateSales(manager, "clymer");
    assert.ok("sales" in found);
    assert.deepEqual(
      found.sales.map((sale) => sale.customerName),
      ["Clymer FD"],
    );
    const elsewhere = await searchRebateSales(other, "clymer");
    assert.ok("sales" in elsewhere);
    assert.equal(elsewhere.sales.length, 0);
    const short = await searchRebateSales(manager, "c");
    assert.deepEqual(short, { sales: [] });
  });

  test("the download: every sale of the years the units were sold in, the rebates in AO to AQ; a sale not in this shop counts as not found", async () => {
    const result = await rebateDownload(
      manager,
      {
        timeZone: "America/New_York",
        invoices: [
          {
            ...INVOICE,
            lines: [
              { ...INVOICE.lines[0], saleId: ids.ranger },
              { ...INVOICE.lines[1], saleId: ids.elsewhere },
              { ...INVOICE.lines[2], saleId: ids.older },
            ],
          },
        ],
      },
      new Date("2026-11-06T20:00:00Z"),
    );
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.equal(result.fileName, "Rebates 314886 2026-11-06.xlsx");
    assert.match(result.contentDisposition, /^attachment; filename="Rebates 314886 2026-11-06\.xlsx"/);
    const sheets = await readXlsx(result.bytes);
    assert.deepEqual(
      sheets.map((sheet) => sheet.name),
      ["NUSR", "Rebates"],
    );
    const nusr = sheets[0].rows;
    const heading = nusr[0];
    const column = (name: string) => heading.indexOf(name);
    // 2025 and 2026: the older sale's year too.
    const customers = nusr.slice(1).map((row) => row[column("Customer Name")]).filter(Boolean);
    assert.deepEqual(customers.slice(0, 3), ["Ida Pruitt", "Dana Quillfeather", "Clymer FD"]);
    const ranger = nusr.find((row) => row[column("Customer Name")] === "Dana Quillfeather")!;
    assert.deepEqual([ranger[column("Holdback") + 14], ranger[column("Add'l Hlbk")]], ["979.96", "796.22"]);
    const rebates = sheets[1].rows;
    const notFound = rebates.filter((row) => row[19] === "Not found in the NUSR.");
    assert.equal(notFound.length, 1, "the other shop's sale isn't in this download");
  });

  test("a download that isn't one", async () => {
    for (const bad of [null, {}, { invoices: [] }, { invoices: [{ column: "rebate", lines: [] }] }, { invoices: [{ column: "addlHoldback", lines: [{ line: "1", vinRead: RANGER }] }] }]) {
      assert.ok("error" in (await rebateDownload(manager, bad)), JSON.stringify(bad));
    }
  });

  // --- Saved rebates ---

  // An invoice as the page sends it to save.
  type SentLine = { vinRead: string; names: string[]; amount: number | null; saleId: string | null; how?: string | null };
  const sent = (invoice: { number: string | null; date: string | null; column: string; total?: number | null }, lines: SentLine[]) => ({
    fileName: `${invoice.number ?? "scan"}.pdf`,
    type: "Rebate",
    total: invoice.total === undefined ? -lines.reduce((sum, line) => sum + (line.amount ?? 0), 0) : invoice.total,
    pages: 2,
    ...invoice,
    lines: lines.map((line, index) => ({
      line: index + 1,
      page: 1,
      part: "012",
      modelCode: null,
      programs: ["US RGR NSR 2H 2026 R"],
      dates: ["PUR:08/21/26"],
      purchased: ["2026-08-21"],
      other: [],
      unitPrice: 0,
      amountText: line.amount === null ? "" : (line.amount / 100).toFixed(2),
      amountSure: true,
      how: line.saleId ? "vin" : null,
      ...line,
    })),
  });
  const saved: Record<string, string> = {};
  const invoiceA = () =>
    sent({ number: "314886", date: "2026-10-29", column: "addlHoldback" }, [
      { vinRead: RANGER, names: ["DANA QUILLFEATHER"], amount: 79622, saleId: ids.ranger },
      { vinRead: whole("3NESEA50_TN321384"), names: ["CLYMER VOLUNTEER FIRE COMP"], amount: 22747, saleId: ids.fire, how: "name" },
      // Another shop's sale of it: saved as not found.
      { vinRead: RANGER_2, names: ["SOMEONE ELSE"], amount: 10000, saleId: ids.elsewhere },
    ]);
  const entriesOf = (id: string) =>
    systemDb.select().from(auditLog).where(and(eq(auditLog.targetType, "rebate_invoice"), eq(auditLog.targetId, id))).orderBy(asc(auditLog.createdAt), asc(auditLog.id));

  test("saving an invoice: its lines and sales kept; its number again only in place of the one saved, when asked; each in the Activity log", async () => {
    const first = await saveRebateInvoice(manager, { invoice: invoiceA() });
    assert.ok("saved" in first, JSON.stringify(first));
    assert.equal(first.saved.replaced, false);
    saved.a = first.saved.id;

    const [row] = await systemDb.select().from(rebateInvoices).where(eq(rebateInvoices.id, saved.a));
    assert.deepEqual(
      [row.shopId, row.number, row.invoiceType, row.invoiceDate, row.totalCents, row.rebateColumn, row.fileName, row.pages, row.savedByUserId],
      [manager.shop.id, "314886", "Rebate", "2026-10-29", 112369, "addlHoldback", "314886.pdf", 2, manager.id],
    );
    const lines = await systemDb.select().from(rebateLines).where(eq(rebateLines.invoiceId, saved.a)).orderBy(asc(rebateLines.line));
    assert.deepEqual(
      lines.map((line) => [line.line, line.vinRead, line.names, line.amountCents, line.amountText, line.saleId, line.matchHow, line.purchased]),
      [
        [1, RANGER, ["DANA QUILLFEATHER"], 79622, "796.22", ids.ranger, "vin", ["2026-08-21"]],
        [2, whole("3NESEA50_TN321384"), ["CLYMER VOLUNTEER FIRE COMP"], 22747, "227.47", ids.fire, "name", ["2026-08-21"]],
        [3, RANGER_2, ["SOMEONE ELSE"], 10000, "100.00", null, null, ["2026-08-21"]],
      ],
    );

    // The same number again: said so, and saved only when asked.
    const again = await saveRebateInvoice(manager, { invoice: invoiceA() });
    assert.ok("exists" in again, JSON.stringify(again));
    assert.deepEqual({ ...again.exists, savedAt: typeof again.exists.savedAt }, { id: saved.a, savedAt: "string", savedBy: "Morgan", lines: 3 });
    const changed = invoiceA();
    changed.lines[0].amount = 79600;
    changed.lines = changed.lines.slice(0, 2);
    const replaced = await saveRebateInvoice(manager, { invoice: changed, replace: true });
    assert.deepEqual(replaced, { saved: { id: saved.a, replaced: true } });
    const after = await systemDb.select().from(rebateLines).where(eq(rebateLines.invoiceId, saved.a)).orderBy(asc(rebateLines.line));
    assert.deepEqual(
      after.map((line) => [line.line, line.amountCents]),
      [
        [1, 79600],
        [2, 22747],
      ],
    );
    // Opened on the page and saved again: in its place, by its id.
    assert.deepEqual(await saveRebateInvoice(manager, { invoice: invoiceA(), savedId: saved.a, replace: true }), { saved: { id: saved.a, replaced: true } });
    assert.equal((await systemDb.select().from(rebateLines).where(eq(rebateLines.invoiceId, saved.a))).length, 3);

    const entries = await entriesOf(saved.a);
    assert.deepEqual(
      entries.map((entry) => entry.action),
      ["rebate_invoice.saved", "rebate_invoice.replaced", "rebate_invoice.replaced"],
    );
    const said = describeAuditEntry(entries[0]);
    assert.equal(said.summary, "Saved rebate invoice 314886");
    assert.deepEqual(
      Object.fromEntries(said.facts.map((fact) => [fact.label, fact.value])),
      { "Invoice date": "10/29/2026", Lines: "3", "Found in the NUSR": "2", Amounts: "$1,123.69", "Amounts in": "Add'l holdback (AQ)", File: "314886.pdf" },
    );
    assert.equal(describeAuditEntry(entries[1]).summary, "Saved rebate invoice 314886 again, in place of the one saved before");
  });

  test("an invoice with no number read is saved as a new one, unless it's the one opened", async () => {
    const scan = () => sent({ number: null, date: null, column: "holdback" }, [{ vinRead: whole("4XASEA50_TA999999"), names: ["NOBODY ON FILE"], amount: 1500, saleId: null }]);
    const first = await saveRebateInvoice(manager, { invoice: scan() });
    const second = await saveRebateInvoice(manager, { invoice: scan() });
    assert.ok("saved" in first && "saved" in second);
    assert.notEqual(first.saved.id, second.saved.id);
    assert.deepEqual(await saveRebateInvoice(manager, { invoice: scan(), savedId: first.saved.id, replace: true }), { saved: { id: first.saved.id, replaced: true } });
    assert.ok("ok" in (await removeSavedInvoice(manager, second.saved.id)));
    saved.scan = first.saved.id;
    // It counts on the day it was first saved, as no date was read.
    await systemDb.update(rebateInvoices).set({ createdAt: new Date("2026-06-15T16:00:00Z") }).where(eq(rebateInvoices.id, saved.scan));

    const older = await saveRebateInvoice(manager, {
      invoice: sent({ number: "298001", date: "2025-12-31", column: "retailRewards" }, [{ vinRead: RZR, names: ["IDA PRUITT"], amount: 50000, saleId: ids.older }]),
    });
    assert.ok("saved" in older);
    saved.older = older.saved.id;
  });

  test("Saved rebates by the filters: the year and month of the invoice's day, its column, the sale's salesman and category, found or not, and a search", async () => {
    const lines = async (params: Record<string, string>, page?: { page: number; perPage: number }) => {
      const result = await listSavedRebates(manager, parseRebateFilters(params, 2026), page);
      assert.ok(!("error" in result), JSON.stringify(result));
      return result;
    };
    const labels = (result: Awaited<ReturnType<typeof lines>>) => result.items.map((line) => `${line.invoiceNumber ?? "scan"}/${line.line}`);

    // This year's, the newest invoice first, each in its order.
    const thisYear = await lines({});
    assert.deepEqual(labels(thisYear), ["314886/1", "314886/2", "314886/3", "scan/1"]);
    assert.deepEqual(thisYear.totals, {
      lines: 4,
      found: 2,
      amounts: { holdback: 1500, retailRewards: 0, addlHoldback: 112369 },
      bySalesman: [
        { label: "Lee Brandvold", lines: 1, amount: 79622 },
        { label: "No salesman", lines: 1, amount: 22747 },
        { label: "Not found", lines: 2, amount: 11500 },
      ],
      byCategory: [
        { label: "UTV", lines: 1, amount: 79622 },
        { label: "ATV", lines: 1, amount: 22747 },
        { label: "Not found", lines: 2, amount: 11500 },
      ],
      // Each invoice's own, for its line in the list of invoices.
      bySalesmanOf: {
        [saved.a]: [
          { label: "Lee Brandvold", lines: 1, amount: 79622 },
          { label: "No salesman", lines: 1, amount: 22747 },
          { label: "Not found", lines: 1, amount: 10000 },
        ],
        [saved.scan]: [{ label: "Not found", lines: 1, amount: 1500 }],
      },
    });
    // Narrowed to a salesman, each invoice's are the lines found.
    assert.deepEqual((await lines({ salesperson: "lee brandvold" })).totals.bySalesmanOf, { [saved.a]: [{ label: "Lee Brandvold", lines: 1, amount: 79622 }] });
    const dana = thisYear.items[0];
    assert.deepEqual(
      [dana.invoiceDate, dana.column, dana.vinRead, dana.amount, dana.sale?.customerName, dana.sale?.salesperson],
      ["2026-10-29", "addlHoldback", RANGER, 79622, "Dana Quillfeather", "Lee Brandvold"],
    );
    assert.equal(thisYear.items[2].sale, null, "another shop's sale isn't shown");

    assert.deepEqual(labels(await lines({ year: "all" })), ["314886/1", "314886/2", "314886/3", "scan/1", "298001/1"]);
    assert.deepEqual(labels(await lines({ year: "2025" })), ["298001/1"]);
    assert.deepEqual(labels(await lines({ month: "10" })), ["314886/1", "314886/2", "314886/3"]);
    assert.deepEqual(labels(await lines({ month: "6" })), ["scan/1"]);
    assert.deepEqual(labels(await lines({ column: "holdback" })), ["scan/1"]);
    assert.deepEqual(labels(await lines({ salesperson: "lee brandvold" })), ["314886/1"]);
    assert.deepEqual(labels(await lines({ category: "atv" })), ["314886/2"]);
    assert.deepEqual(labels(await lines({ status: "missing" })), ["314886/3", "scan/1"]);
    assert.deepEqual(labels(await lines({ status: "found", year: "all" })), ["314886/1", "314886/2", "298001/1"]);
    assert.deepEqual(labels(await lines({ q: "quillfeather" })), ["314886/1"]);
    assert.deepEqual(labels(await lines({ q: "clymer fire" })), ["314886/2"]);
    assert.deepEqual(labels(await lines({ q: "314886" })), ["314886/1", "314886/2", "314886/3"]);
    assert.deepEqual(labels(await lines({ q: "pruitt", year: "all" })), ["298001/1"]);

    const paged = await lines({}, { page: 2, perPage: 3 });
    assert.deepEqual([labels(paged), paged.page, paged.pages, paged.from, paged.to, paged.total, paged.totals.lines], [["scan/1"], 2, 2, 4, 4, 4, 4]);

    // The invoices, with what the filters find of each.
    const invoices = await listSavedInvoices(manager, parseRebateFilters({}, 2026));
    assert.ok(!("error" in invoices));
    assert.deepEqual(
      invoices.map((invoice) => [invoice.number, invoice.date, invoice.day, invoice.lines, invoice.found, invoice.amount, invoice.shown, invoice.shownAmount, invoice.total, invoice.savedBy]),
      [
        ["314886", "2026-10-29", "2026-10-29", 3, 2, 112369, 3, 112369, 112369, "Morgan"],
        [null, null, "2026-06-15", 1, 0, 1500, 1, 1500, 1500, "Morgan"],
      ],
    );
    const lee = await listSavedInvoices(manager, parseRebateFilters({ salesperson: "Lee Brandvold", year: "all" }, 2026));
    assert.ok(!("error" in lee));
    assert.deepEqual(
      lee.map((invoice) => [invoice.number, invoice.lines, invoice.shown, invoice.shownAmount]),
      [["314886", 3, 1, 79622]],
    );
    assert.deepEqual(await savedInvoiceYears(manager), [2026, 2025]);

    // Another shop sees none of them.
    const elsewhere = await listSavedRebates(other, parseRebateFilters({ year: "all" }, 2026));
    assert.ok(!("error" in elsewhere));
    assert.equal(elsewhere.total, 0);
    assert.deepEqual(await listSavedInvoices(other, parseRebateFilters({ year: "all" }, 2026)), []);
    assert.deepEqual(await savedInvoiceYears(other), []);
  });

  test("opening a saved invoice: every line as saved, with the sales they were found as", async () => {
    const opened = await openSavedInvoice(manager, saved.a);
    assert.ok(!("error" in opened), JSON.stringify(opened));
    assert.deepEqual(opened.invoice, { number: "314886", type: "Rebate", date: "2026-10-29", total: 112369, column: "addlHoldback", fileName: "314886.pdf", pages: 2 });
    assert.deepEqual(
      opened.lines.map((line) => [line.line, line.page, line.part, line.vinRead, line.programs, line.dates, line.purchased, line.names, line.amount, line.amountText, line.amountSure, line.saleId, line.how]),
      [
        [1, 1, "012", RANGER, ["US RGR NSR 2H 2026 R"], ["PUR:08/21/26"], ["2026-08-21"], ["DANA QUILLFEATHER"], 79622, "796.22", true, ids.ranger, "vin"],
        [2, 1, "012", whole("3NESEA50_TN321384"), ["US RGR NSR 2H 2026 R"], ["PUR:08/21/26"], ["2026-08-21"], ["CLYMER VOLUNTEER FIRE COMP"], 22747, "227.47", true, ids.fire, "name"],
        [3, 1, "012", RANGER_2, ["US RGR NSR 2H 2026 R"], ["PUR:08/21/26"], ["2026-08-21"], ["SOMEONE ELSE"], 10000, "100.00", true, null, null],
      ],
    );
    assert.deepEqual(opened.sales.map((sale) => sale.customerName).sort(), ["Clymer FD", "Dana Quillfeather"]);
    for (const [actor, id] of [
      [other, saved.a],
      [manager, "not-an-id"],
      [manager, randomUUID()],
    ] as const) {
      assert.deepEqual(await openSavedInvoice(actor, id), { error: "That invoice isn't saved in this shop's Rebates." });
    }
  });

  test("the saved download: the rebates the filters find, in the NUSR sheet's AO to AQ, and the Rebates sheet", async () => {
    const result = await savedRebatesDownload(manager, parseRebateFilters({ year: "all" }, 2026), new Date("2026-11-06T20:00:00Z"));
    assert.ok(!("error" in result), JSON.stringify(result));
    assert.equal(result.fileName, "Rebates All years 2026-11-06.xlsx");
    const sheets = await readXlsx(result.bytes);
    assert.deepEqual(
      sheets.map((sheet) => sheet.name),
      ["NUSR", "Rebates"],
    );
    const nusr = sheets[0].rows;
    const column = (name: string) => nusr[0].indexOf(name);
    const customer = (name: string) => nusr.find((row) => row[column("Customer Name")] === name)!;
    assert.equal(customer("Dana Quillfeather")[column("Add'l Hlbk")], "796.22");
    assert.equal(customer("Ida Pruitt")[column("Retail Rwds")], "500");
    const october = await savedRebatesDownload(manager, parseRebateFilters({ month: "10", salesperson: "Lee Brandvold" }, 2026), new Date("2026-11-06T20:00:00Z"));
    assert.ok(!("error" in october));
    assert.equal(october.fileName, "Rebates October 2026 · Lee Brandvold 2026-11-06.xlsx");
    const rows = (await readXlsx(october.bytes))[0].rows;
    const pruitt = rows.find((row) => row[column("Customer Name")] === "Ida Pruitt");
    assert.ok(!pruitt?.[column("Retail Rwds")], "only the rebates the filters find");
  });

  test("removing a saved invoice; a sale with rebates saved against it stays in the NUSR until then", async () => {
    const spare = await sell(manager, { customerName: "Nell Ashgrove", vin: SPORTSMAN_2, unitModel: "Spm 570", category: "ATV" });
    const result = await saveRebateInvoice(manager, {
      invoice: sent({ number: "400001", date: "2026-11-02", column: "addlHoldback" }, [{ vinRead: SPORTSMAN_2, names: ["NELL ASHGROVE"], amount: 12000, saleId: spare }]),
    });
    assert.ok("saved" in result);
    const blocked = await removeSale(manager, spare);
    assert.ok("error" in blocked);
    assert.match(blocked.error, /Rebates are saved against this sale \(invoice 400001 on the Rebates tab\)/);

    assert.deepEqual(await removeSavedInvoice(other, result.saved.id), { error: "That invoice isn't saved in this shop's Rebates." });
    assert.deepEqual(await removeSavedInvoice(manager, result.saved.id), { ok: true, number: "400001" });
    assert.equal((await systemDb.select().from(rebateLines).where(eq(rebateLines.invoiceId, result.saved.id))).length, 0);
    const entries = await entriesOf(result.saved.id);
    assert.deepEqual(
      entries.map((entry) => entry.action),
      ["rebate_invoice.saved", "rebate_invoice.removed"],
    );
    assert.equal(describeAuditEntry(entries[1]).summary, "Removed rebate invoice 400001 from Rebates");
    assert.deepEqual(await removeSavedInvoice(manager, result.saved.id), { error: "That invoice isn't saved in this shop's Rebates." });
    assert.ok("ok" in (await removeSale(manager, spare)));
  });

  test("the database keeps a shop's saved rebates its own, and each line to a sale of its own shop", async () => {
    const seen = await withShop(other.shop.id, async (tx) => [
      ...(await tx.select({ id: rebateInvoices.id }).from(rebateInvoices).where(eq(rebateInvoices.id, saved.a))),
      ...(await tx.select({ id: rebateLines.id }).from(rebateLines).where(eq(rebateLines.invoiceId, saved.a))),
    ]);
    assert.deepEqual(seen, []);
    await assert.rejects(
      withShop(other.shop.id, (tx) => tx.insert(rebateInvoices).values({ shopId: manager.shop.id, rebateColumn: "holdback", fileName: "x.pdf", pages: 1 })),
      "another shop's invoice",
    );
    // Even as the owner, past row-level security: a line can't be for
    // another shop's sale.
    await assert.rejects(
      systemDb.insert(rebateLines).values({ shopId: manager.shop.id, invoiceId: saved.a, line: 99, page: 1, vinRead: RANGER, saleId: ids.elsewhere }),
      "another shop's sale",
    );
  });

  test("saving and Saved rebates only for those who can open the NUSR, signed in with a password; an invoice that isn't one isn't saved", async () => {
    const filters = parseRebateFilters({ year: "all" }, 2026);
    for (const actor of [writer, { ...manager, bay: { deviceId: "d", deviceName: "Bay 1", sessionId: "s" } }]) {
      assert.ok("error" in (await saveRebateInvoice(actor, { invoice: invoiceA(), replace: true })));
      assert.ok("error" in (await listSavedInvoices(actor, filters)));
      assert.ok("error" in (await listSavedRebates(actor, filters)));
      assert.ok("error" in (await openSavedInvoice(actor, saved.a)));
      assert.ok("error" in (await removeSavedInvoice(actor, saved.a)));
      assert.ok("error" in (await savedRebatesDownload(actor, filters)));
      assert.deepEqual(await savedInvoiceYears(actor), []);
    }
    for (const bad of [null, {}, { invoice: null }, { invoice: { column: "rebate", lines: [] } }, { invoice: { ...invoiceA(), lines: [{ line: 1, vinRead: "" }] } }]) {
      assert.ok("error" in (await saveRebateInvoice(manager, bad)), JSON.stringify(bad));
    }
    const same = invoiceA();
    same.lines[1].line = 1;
    assert.ok("error" in (await saveRebateInvoice(manager, { invoice: same, replace: true })), "two lines in one place");
    // Still as it was.
    assert.equal((await systemDb.select().from(rebateLines).where(eq(rebateLines.invoiceId, saved.a))).length, 3);
  });
});
