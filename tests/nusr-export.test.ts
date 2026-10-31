// NUSR's download (src/lib/nusr-export.ts): the shop's NUSR sheet with its
// headings in its columns, each figure as the spreadsheet's formula over
// the row's own cells carrying the value saleFigures works out, the MSRP
// column saying Trade or Trailer, the TOTAL and AVG TOTAL rows, how it
// prints; the Summary sheet's totals, by deal type, salesman, category and
// month; the Comparison sheet's months year beside year; and the file's
// name. Made-up sales only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { attachmentHeader, nusrFileName, nusrWorkbook } from "../src/lib/nusr-export";
import {
  DEFAULT_BONUS_RATE_BP,
  DEFAULT_HOLDBACK_RATE_BP,
  monthlyComparison,
  perUnit,
  saleTotals,
  withFigures,
  type FiguredSale,
  type SaleFields,
} from "../src/lib/nusr-rules";
import type { Cell, CellValue, Sheet } from "../src/lib/xlsx-write";

const BLANK: SaleFields = {
  soldOn: "2026-01-02",
  salesperson: null,
  customerName: "Dana Quillfeather",
  customerAddress: null,
  customerPhone: null,
  unitYear: null,
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
  holdbackRateBp: DEFAULT_HOLDBACK_RATE_BP,
  bonusRateBp: DEFAULT_BONUS_RATE_BP,
};
const sale = (fields: Partial<SaleFields>): FiguredSale => withFigures({ ...BLANK, ...fields });

// A Ranger sold with everything filled in.
const ranger = sale({
  soldOn: "2026-03-14",
  salesperson: "Sam Ortiz",
  customerName: "Dana Quillfeather",
  customerAddress: "12 Example Rd, Anytown, PA 16601",
  customerPhone: "(814) 555-0101",
  unitYear: 2026,
  unitModel: "Rngr 570 NS",
  vin: "4XARAA578TE000001",
  category: "UTV",
  notes: "Plow & winch <installed>",
  msrp: 1_599_900,
  salesPrice: 1_450_000,
  dealerCost: 1_275_025,
  unitLabor: 15_000,
  rebate: 30_000,
  accPrice: 120_000,
  accCost: 80_000,
  accLabor: 10_000,
  escPrice: 99_900,
  escCost: 45_000,
  rewards: 2_500,
  financeCompany: "Keystone Credit",
  amountFinanced: 1_000_000,
  downPayment: 200_000,
  fundingReceivedOn: "2026-03-20",
  paidOn: "2026-03-25",
  comsNumber: "C-1001",
  bonusAdjustment: -5_000,
});
// A trade-in sold on, with no MSRP.
const trade = sale({
  soldOn: "2026-02-01",
  salesperson: "Pat Doyle",
  customerName: "Rhett Carver",
  unitYear: 2019,
  unitModel: "Spmn 570 EPS",
  condition: "used",
  unitType: "trade",
  category: "ATV",
  salesPrice: 600_000,
  dealerCost: 450_000,
});
// A trailer the same day as the Ranger, at a 5% holdback and 15% bonus.
const trailer = sale({
  soldOn: "2026-03-14",
  salesperson: "sam ortiz",
  customerName: "Walt Brennigan",
  unitModel: "6.5 x 14 Trailer",
  unitType: "trailer",
  category: "Trailer",
  salesPrice: 189_900,
  dealerCost: 140_000,
  holdbackRateBp: 500,
  bonusRateBp: 1_500,
});
// Nothing typed but the date, the salesman and the name, which looks like
// a formula.
const bare = sale({ soldOn: "2026-04-02", salesperson: "Sam Ortiz", customerName: '=HYPERLINK("http://example.com")' });

// Newest first, as the log lists them; the download puts them oldest first.
const SALES = [bare, trailer, ranger, trade];
const IN_ORDER = [trade, trailer, ranger, bare];
const GENERATED = new Date("2026-10-31T16:00:00Z");
const COMPARISON = monthlyComparison([
  { year: 2024, month: 3, units: 2 },
  { year: 2025, month: 3, units: 5 },
  { year: 2025, month: 11, units: 1 },
  { year: 2026, month: 3, units: 4 },
  { year: 2026, month: 11, units: 1 },
]);
const [NUSR, SUMMARY, COMPARISON_SHEET] = nusrWorkbook(SALES, { title: "2026", comparison: COMPARISON, generatedAt: GENERATED });

// A column's place by its letters (A is 0), and a cell by its reference
// ("Q2"), as given to the writer.
const columnOf = (letters: string) => [...letters].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
function cellAt(sheet: Sheet, ref: string): Cell | undefined {
  const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(ref)!;
  return sheet.rows[Number(row) - 1]?.[columnOf(letters)];
}
const isObject = (cell: Cell | undefined): cell is Exclude<Cell, CellValue> => typeof cell === "object" && cell !== null && !(cell instanceof Date);
const valueAt = (sheet: Sheet, ref: string): CellValue => {
  const cell = cellAt(sheet, ref);
  return isObject(cell) ? cell.value : (cell ?? null);
};
const formulaAt = (sheet: Sheet, ref: string) => {
  const cell = cellAt(sheet, ref);
  return isObject(cell) && "formula" in cell ? cell.formula : null;
};
const close = (actual: CellValue, expected: number, message?: string) => {
  assert.equal(typeof actual, "number", message);
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, `${message}: ${actual} isn't ${expected}`);
};

describe("the NUSR sheet", () => {
  test("the spreadsheet's headings in its columns, A left blank, then the app's own four", () => {
    const headings = NUSR.rows[0].map((cell) => (isObject(cell) ? cell.value : cell));
    assert.deepEqual(headings, [
      null,
      "Date",
      "Salesman",
      "Customer Name",
      "Address",
      "Phone",
      "Year",
      "Model",
      "New/Used",
      "VIN",
      "MSRP",
      "Sales Price",
      "Dealer Cost",
      "Unit Labor",
      "Polaris Rebate",
      "*Notes*",
      "Unit Profit",
      "Unit Profit %",
      "Acc. Sales Price",
      "Acc. Cost",
      "Acc. Labor",
      "Acc. Profit",
      "Acc. Profit %",
      "ESC Price",
      "ESC Cost",
      "Rewards",
      "Holdback",
      "TOTAL PROFIT",
      "PROFIT %",
      "TOTAL BONUS",
      "Holdback Bonus",
      "Sales Bonus",
      "Finance Company",
      "Amt Financed",
      "Down Pymt",
      "Funding Rec'd",
      "Date Paid",
      "COMS #",
      "Category",
      "Type",
      "Holdback %",
      "Bonus %",
      "Bonus adjustment",
    ]);
    // Coloured as the spreadsheet's: grey over what's typed, green over the
    // profits, yellow over the holdback, total profit and bonuses.
    const styleOf = (ref: string) => (cellAt(NUSR, ref) as { style?: string }).style;
    assert.deepEqual(["B1", "L1", "Q1", "R1", "V1", "W1", "AA1", "AF1", "AG1", "AQ1"].map(styleOf), [
      "header",
      "header",
      "headerGreen",
      "headerGreen",
      "headerGreen",
      "headerGreen",
      "headerYellow",
      "headerYellow",
      "header",
      "header",
    ]);
  });

  test("the sales, oldest first, with what was typed in the shop's columns", () => {
    assert.deepEqual(
      [2, 3, 4, 5].map((r) => valueAt(NUSR, `D${r}`)),
      IN_ORDER.map((s) => s.customerName),
    );
    const r = 4; // the Ranger, after the trailer sold the same day
    assert.deepEqual(valueAt(NUSR, `B${r}`), new Date("2026-03-14T00:00:00Z"));
    assert.deepEqual(
      ["C", "E", "F", "G", "H", "I", "J", "P", "AG", "AL", "AM", "AN"].map((column) => valueAt(NUSR, `${column}${r}`)),
      ["Sam Ortiz", "12 Example Rd, Anytown, PA 16601", "(814) 555-0101", 2026, "Rngr 570 NS", "N", "4XARAA578TE000001", "Plow & winch <installed>", "Keystone Credit", "C-1001", "UTV", "New whole good"],
    );
    // Amounts in dollars, as Excel holds them; rates as fractions, shown as
    // percentages; dates as dates.
    assert.deepEqual(
      ["K", "L", "M", "N", "O", "S", "T", "U", "X", "Y", "Z", "AH", "AI", "AQ"].map((column) => valueAt(NUSR, `${column}${r}`)),
      [15999, 14500, 12750.25, 150, 300, 1200, 800, 100, 999, 450, 25, 10000, 2000, -50],
    );
    assert.deepEqual([valueAt(NUSR, `AO${r}`), valueAt(NUSR, `AP${r}`)], [0.04, 0.1]);
    assert.deepEqual([valueAt(NUSR, `AJ${r}`), valueAt(NUSR, `AK${r}`)], [new Date("2026-03-20T00:00:00Z"), new Date("2026-03-25T00:00:00Z")]);
    assert.equal(valueAt(NUSR, "I2"), "U");
    // Each column's style shows them as the spreadsheet did.
    assert.deepEqual(
      ["B", "G", "K", "R", "AJ", "AO"].map((column) => NUSR.columns![columnOf(column)].style),
      ["date", undefined, "money", "percent", "date", "percent"],
    );
  });

  test("each figure is the spreadsheet's formula over its own row, cached as saleFigures works it out", () => {
    IN_ORDER.forEach((s, i) => {
      const r = i + 2;
      const f = s.figures;
      const expect = (column: string, formula: string, value: number | null) => {
        assert.equal(formulaAt(NUSR, `${column}${r}`), formula, `${column}${r}`);
        if (value === null) assert.equal(valueAt(NUSR, `${column}${r}`), "", `${column}${r}`);
        else close(valueAt(NUSR, `${column}${r}`), value, `${column}${r}`);
      };
      expect("Q", `L${r}-M${r}-N${r}+O${r}`, f.unitProfit / 100);
      expect("R", `IF(L${r}=0,"",Q${r}/L${r})`, f.unitProfitPct);
      expect("V", `S${r}-T${r}-U${r}`, f.accProfit / 100);
      expect("W", `IF(S${r}=0,"",V${r}/S${r})`, f.accProfitPct);
      expect("AA", `IF(ISNUMBER(K${r}),ROUND(K${r}*AO${r},2),0)`, f.holdback / 100);
      expect("AB", `ROUND(Q${r}+V${r}+X${r}-Y${r}+Z${r}+AA${r},2)`, f.totalProfit / 100);
      expect("AC", `IF(L${r}+S${r}+X${r}=0,"",AB${r}/(L${r}+S${r}+X${r}))`, f.profitPct);
      expect("AD", `ROUND(AB${r}*AP${r},2)`, f.totalBonus / 100);
      expect("AE", `ROUND(AA${r}*AP${r},2)`, f.holdbackBonus / 100);
      expect("AF", `AD${r}-AE${r}+AQ${r}`, f.salesBonus / 100);
    });
    // The Ranger's, worked out by hand: 14,500 - 12,750.25 - 150 + 300; a 4%
    // holdback on 15,999; 1,899.75 + 300 + 549 + 25 + 639.96; 10% of that,
    // less 10% of the holdback, less the 50 charged back.
    assert.deepEqual(
      ["Q4", "V4", "AA4", "AB4", "AD4", "AE4", "AF4"].map((ref) => valueAt(NUSR, ref)),
      [1899.75, 300, 639.96, 3413.71, 341.37, 64, 227.37],
    );
  });

  test("blanks stay blank; with no MSRP the MSRP column says what the deal was", () => {
    // The trade and the trailer: no MSRP, so no holdback.
    assert.equal(valueAt(NUSR, "K2"), "Trade");
    assert.equal(valueAt(NUSR, "K3"), "Trailer");
    assert.deepEqual([valueAt(NUSR, "AA2"), valueAt(NUSR, "AA3")], [0, 0]);
    // A new whole good with no MSRP is blank there, as is everything not typed.
    for (const column of ["E", "F", "G", "H", "J", "K", "L", "M", "N", "O", "P", "S", "T", "U", "X", "Y", "Z", "AG", "AH", "AI", "AJ", "AK", "AL", "AM", "AQ"]) {
      assert.equal(cellAt(NUSR, `${column}5`), null, `${column}5`);
    }
    // And its percentages, with nothing to divide by, are blank too.
    assert.deepEqual(["R5", "W5", "AC5"].map((ref) => valueAt(NUSR, ref)), ["", "", ""]);
    // A name that looks like a formula is text, not a formula.
    assert.equal(cellAt(NUSR, "D5"), '=HYPERLINK("http://example.com")');
  });

  test("a blank row, then TOTAL (SUM of each amount, the units counted) and AVG TOTAL, as saleTotals has them", () => {
    const totals = saleTotals(SALES);
    assert.deepEqual(NUSR.rows[5], []);
    const t = 7;
    assert.equal(valueAt(NUSR, `C${t}`), "TOTAL");
    assert.equal(formulaAt(NUSR, `B${t}`), "COUNTA(B2:B6)");
    assert.equal(valueAt(NUSR, `B${t}`), 4);
    const sums: [string, number][] = [
      ["K", totals.amounts.msrp],
      ["L", totals.amounts.salesPrice],
      ["M", totals.amounts.dealerCost],
      ["N", totals.amounts.unitLabor],
      ["O", totals.amounts.rebate],
      ["Q", totals.figures.unitProfit],
      ["S", totals.amounts.accPrice],
      ["T", totals.amounts.accCost],
      ["U", totals.amounts.accLabor],
      ["V", totals.figures.accProfit],
      ["X", totals.amounts.escPrice],
      ["Y", totals.amounts.escCost],
      ["Z", totals.amounts.rewards],
      ["AA", totals.figures.holdback],
      ["AB", totals.figures.totalProfit],
      ["AD", totals.figures.totalBonus],
      ["AE", totals.figures.holdbackBonus],
      ["AF", totals.figures.salesBonus],
      ["AH", totals.amounts.amountFinanced],
      ["AI", totals.amounts.downPayment],
      ["AQ", totals.amounts.bonusAdjustment],
    ];
    for (const [column, cents] of sums) {
      assert.equal(formulaAt(NUSR, `${column}${t}`), `SUM(${column}2:${column}6)`, column);
      close(valueAt(NUSR, `${column}${t}`), cents / 100, column);
    }
    // Percentages of the totals, not totals of the percentages.
    assert.equal(formulaAt(NUSR, `R${t}`), `IF(L${t}=0,"",Q${t}/L${t})`);
    close(valueAt(NUSR, `R${t}`), totals.unitProfitPct!);
    assert.equal(formulaAt(NUSR, `AC${t}`), `IF(L${t}+S${t}+X${t}=0,"",AB${t}/(L${t}+S${t}+X${t}))`);
    close(valueAt(NUSR, `AC${t}`), totals.profitPct!);
    close(valueAt(NUSR, `W${t}`), totals.accProfitPct!);
    // Per unit, as the spreadsheet's AVG row.
    assert.equal(valueAt(NUSR, "C8"), "AVG TOTAL");
    assert.equal(formulaAt(NUSR, "AB8"), `IF($B$${t}=0,"",AB${t}/$B$${t})`);
    close(valueAt(NUSR, "AB8"), totals.figures.totalProfit / 4 / 100);
    assert.equal(Math.round((valueAt(NUSR, "AB8") as number) * 100), perUnit(totals.figures.totalProfit, 4));
    assert.equal(cellAt(NUSR, "K8"), undefined);
  });

  test("with no sales, the TOTAL rows are still there, with nothing to divide by", () => {
    const [empty] = nusrWorkbook([], { title: "All years", comparison: monthlyComparison([]), generatedAt: GENERATED });
    assert.equal(empty.rows.length, 4);
    assert.equal(formulaAt(empty, "L3"), "SUM(L2:L2)");
    assert.equal(valueAt(empty, "L3"), 0);
    assert.equal(valueAt(empty, "B3"), 0);
    assert.deepEqual([valueAt(empty, "R3"), valueAt(empty, "L4")], ["", ""]);
    assert.equal(empty.autoFilter, "B1:AQ1");
  });

  test("frozen at the customer, a filter on the headings, landscape one page wide with the headings on every page", () => {
    assert.equal(NUSR.name, "NUSR");
    assert.deepEqual(NUSR.freeze, { rows: 1, columns: 4 });
    assert.equal(NUSR.autoFilter, "B1:AQ5");
    assert.deepEqual([NUSR.landscape, NUSR.fitToWidth, NUSR.printTitles, NUSR.printGridlines, NUSR.footer], [true, true, 1, true, "NUSR 2026"]);
    assert.equal(NUSR.columns!.length, 43);
  });
});

describe("the Summary sheet", () => {
  // The rows under a heading, up to the blank row after them.
  function block(heading: string): CellValue[][] {
    const at = SUMMARY.rows.findIndex((row) => isObject(row[0]) && row[0].value === heading);
    assert.ok(at >= 0, heading);
    const rows: CellValue[][] = [];
    for (let r = at + 1; SUMMARY.rows[r]?.length; r++) rows.push(SUMMARY.rows[r].map((cell) => (isObject(cell) ? cell.value : cell)));
    return rows;
  }
  const HEADINGS = ["Units", "New", "Used", "Gross", "Unit Profit", "Acc. Profit", "ESC Profit", "Holdback", "TOTAL PROFIT", "PROFIT %", "Profit per unit", "TOTAL BONUS", "Holdback Bonus", "Sales Bonus"];
  const figures = (sales: FiguredSale[]) => {
    const t = saleTotals(sales);
    const d = (cents: number) => cents / 100;
    return [
      t.units,
      t.newUnits,
      t.usedUnits,
      d(t.figures.gross),
      d(t.figures.unitProfit),
      d(t.figures.accProfit),
      d(t.figures.escProfit),
      d(t.figures.holdback),
      d(t.figures.totalProfit),
      t.profitPct,
      t.units ? d(perUnit(t.figures.totalProfit, t.units)!) : null,
      d(t.figures.totalBonus),
      d(t.figures.holdbackBonus),
      d(t.figures.salesBonus),
    ];
  };

  test("its title, when it was downloaded, and the period's totals", () => {
    assert.deepEqual(SUMMARY.rows[0], [{ value: "NUSR 2026", style: "title" }]);
    assert.match(String(SUMMARY.rows[1][0]), /^Downloaded October 31, 2026 at 12:00\sPM$/);
    const heading = SUMMARY.rows.find((row) => isObject(row[0]) && row[0].value === "Totals")!;
    assert.deepEqual(heading.slice(1).map((cell) => (isObject(cell) ? cell.value : cell)), HEADINGS);
    assert.deepEqual(block("Totals"), [["TOTAL", ...figures(SALES)]]);
  });

  test("by deal type, every type, as the spreadsheet's TOTAL NEW WG, TRADE, TRAILER and CONTEST rows", () => {
    assert.deepEqual(block("Deal type"), [
      ["New whole good", ...figures([ranger, bare])],
      ["Trade", ...figures([trade])],
      ["Trailer", ...figures([trailer])],
      ["Contest", ...figures([])],
      ["Free", ...figures([])],
    ]);
  });

  test("by salesman and by category, however their capitals were typed, the most units first", () => {
    // Typed "Sam Ortiz" twice and "sam ortiz" once.
    assert.deepEqual(block("Salesman"), [
      ["Sam Ortiz", ...figures([trailer, ranger, bare])],
      ["Pat Doyle", ...figures([trade])],
    ]);
    assert.deepEqual(
      block("Category").map((row) => [row[0], row[1]]),
      [
        ["ATV", 1],
        ["No category", 1],
        ["Trailer", 1],
        ["UTV", 1],
      ],
    );
  });

  test("by month, in the year's order", () => {
    assert.deepEqual(block("Month"), [
      ["February 2026", ...figures([trade])],
      ["March 2026", ...figures([trailer, ranger])],
      ["April 2026", ...figures([bare])],
    ]);
  });
});

describe("the Comparison sheet", () => {
  const values = (row: Cell[]) => row.map((cell) => (isObject(cell) ? cell.value : cell));

  test("units each month, year beside year, the change between each two years, and the totals", () => {
    assert.equal(COMPARISON_SHEET.name, "Comparison");
    assert.deepEqual(values(COMPARISON_SHEET.rows[0]), ["Month", "2024", "2024 to 2025", "2025", "2025 to 2026", "2026"]);
    assert.equal(COMPARISON_SHEET.rows.length, 14);
    assert.deepEqual(values(COMPARISON_SHEET.rows[1]), ["January", 0, 0, 0, 0, 0]);
    assert.deepEqual(values(COMPARISON_SHEET.rows[3]), ["March", 2, 3, 5, -1, 4]);
    assert.equal(formulaAt(COMPARISON_SHEET, "C4"), "D4-B4");
    assert.equal(formulaAt(COMPARISON_SHEET, "E4"), "F4-D4");
    // The totals: SUM of each year, and the change between them.
    assert.deepEqual(values(COMPARISON_SHEET.rows[13]), ["Total", 2, 4, 6, -1, 5]);
    assert.equal(formulaAt(COMPARISON_SHEET, "B14"), "SUM(B2:B13)");
    assert.equal(formulaAt(COMPARISON_SHEET, "E14"), "F14-D14");
  });

  test("a month that hasn't come yet is blank, not 0, unless something was sold in it", () => {
    // Downloaded at the end of October 2026: November had a sale logged
    // already; December has nothing yet.
    assert.deepEqual(values(COMPARISON_SHEET.rows[11]), ["November", 0, 1, 1, 0, 1]);
    assert.deepEqual(values(COMPARISON_SHEET.rows[12]), ["December", 0, 0, 0, null, null]);
    assert.deepEqual(values(COMPARISON_SHEET.rows[10]), ["October", 0, 0, 0, 0, 0]);
  });

  test("no sales at all is a table of months with nothing in it", () => {
    const [, , empty] = nusrWorkbook([], { title: "All years", comparison: monthlyComparison([]), generatedAt: GENERATED });
    assert.deepEqual(values(empty.rows[0]), ["Month"]);
    assert.deepEqual(values(empty.rows[13]), ["Total"]);
  });
});

describe("the download's name", () => {
  test("the title and the day, without what a file name can't have", () => {
    assert.equal(nusrFileName("2026", "2026-10-31"), "NUSR 2026 2026-10-31.xlsx");
    assert.equal(nusrFileName("October 2026 · New · UTV/ATV · “brake: rear?”", "2026-10-31"), "NUSR October 2026 · New · UTV-ATV · “brake- rear-” 2026-10-31.xlsx");
    assert.equal(nusrFileName("All years · a\u0000b\tc", "2026-10-31"), "NUSR All years · ab c 2026-10-31.xlsx");
    assert.ok(nusrFileName("x".repeat(300), "2026-10-31").length < 150);
  });

  test("as the browser saves it: the name as it is, and in plain ASCII for an old browser", () => {
    assert.equal(attachmentHeader("NUSR 2026 2026-10-31.xlsx"), `attachment; filename="NUSR 2026 2026-10-31.xlsx"; filename*=UTF-8''NUSR%202026%202026-10-31.xlsx`);
    assert.equal(
      attachmentHeader("NUSR October 2026 · Zoë’s 🏍️ 2026-10-31.xlsx"),
      `attachment; filename="NUSR October 2026 - Zoe's __ 2026-10-31.xlsx"; filename*=UTF-8''NUSR%20October%202026%20%C2%B7%20Zo%C3%AB%E2%80%99s%20%F0%9F%8F%8D%EF%B8%8F%202026-10-31.xlsx`,
    );
  });
});
