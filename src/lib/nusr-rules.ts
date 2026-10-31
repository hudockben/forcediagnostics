// NUSR, the unit sales log (the NUSR tab): what an entry holds, how what's
// typed is read, and the figures worked out from it, the way the shop's
// NUSR spreadsheet works them out. No server imports, so the form works the
// figures out as they're typed, the same way the server, the download and
// the printout do.

import { normalizePhone } from "@/lib/customer-rules";

// Amounts are whole cents; rates are basis points (400 is 4%).
export type Cents = number;

// New/Used: N or U on the spreadsheet.
export const UNIT_CONDITIONS = ["new", "used"] as const;
export type UnitCondition = (typeof UNIT_CONDITIONS)[number];
export const CONDITION_LETTERS: Record<UnitCondition, string> = { new: "N", used: "U" };

// What kind of deal it is, as the spreadsheet marked it in the MSRP column:
// a number for a new whole good, or TRADE, TRAILER, CONTEST or FREE. Its
// summary rows split the totals the same way (TOTAL NEW WG = TOTAL less
// TRADE, CONTEST and TRAILER).
export const UNIT_TYPES = ["whole_good", "trade", "trailer", "contest", "free"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];
export const UNIT_TYPE_LABELS: Record<UnitType, string> = {
  whole_good: "New whole good",
  trade: "Trade",
  trailer: "Trailer",
  contest: "Contest",
  free: "Free",
};
// What the MSRP column says for a deal with no MSRP.
export const UNIT_TYPE_MARKERS: Record<UnitType, string> = {
  whole_good: "",
  trade: "Trade",
  trailer: "Trailer",
  contest: "Contest",
  free: "Free",
};

// The spreadsheet's Category: UTV, ATV, RZR, Trailer.
export const CATEGORIES = ["UTV", "ATV", "RZR", "Trailer"] as const;

const TRAILER_MODEL = /\b(?:trailer|traailer|trlr|trl|load ?rite|deck ?over)\b|\b\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\b(?!\s*(?:eps|x2))/i;

// A unit's category from its model as the shop writes it ("Rngr 570 NS",
// "Spmn 570 EPS X2", "RZR 1000 XP", "6.5 x 14 Trailer"), or null when the
// model doesn't say.
export function guessCategory(model: string | null): string | null {
  if (!model) return null;
  if (/\brzr\b/i.test(model)) return "RZR";
  if (TRAILER_MODEL.test(model) && !/\b(?:spm|spmn|6x6)\b/i.test(model)) return "Trailer";
  if (/\b(?:rngr|ranger|rnger|general|gen\b|xpedition|xped|teryx|wolverine|maverick|talon|krx|uforce|rhino|pro ?xd)/i.test(model)) return "UTV";
  if (/\b(?:spm|spmn|sptm|sportsman|scrambler|outlaw|phoenix|magnum)/i.test(model)) return "ATV";
  return null;
}

// The kind of deal a unit makes, from what's known of it: a trailer, a
// trade (a used unit), or a new whole good.
export function guessUnitType(sale: { condition: UnitCondition | null; category: string | null; model: string | null }): UnitType {
  if (sale.category?.toLowerCase() === "trailer" || guessCategory(sale.model) === "Trailer") return "trailer";
  return sale.condition === "used" ? "trade" : "whole_good";
}

export const isUnitType = (value: unknown): value is UnitType => (UNIT_TYPES as readonly string[]).includes(value as string);

// The amounts typed for a sale, in the spreadsheet's order: blank is null.
export const MONEY_FIELDS = [
  "msrp",
  "salesPrice",
  "dealerCost",
  "unitLabor",
  "rebate",
  "accPrice",
  "accCost",
  "accLabor",
  "escPrice",
  "escCost",
  "rewards",
  "amountFinanced",
  "downPayment",
  "bonusAdjustment",
] as const;
export type MoneyField = (typeof MONEY_FIELDS)[number];
export type SaleAmounts = Record<MoneyField, Cents | null>;

// What the holdback and the salesman's bonus are worked out at: 4% of MSRP
// and 10% of the deal's profit, as the spreadsheet had them for 2024-2026.
// Each sale keeps its own, so an older year's rate (5%, 7%) stays with it.
export const DEFAULT_HOLDBACK_RATE_BP = 400;
export const DEFAULT_BONUS_RATE_BP = 1000;
export const MAX_RATE_BP = 10_000;

export type SaleRates = { holdbackRateBp: number; bonusRateBp: number };

// Everything the spreadsheet worked out with a formula, by its heading:
// Unit Profit (=Sales Price-Dealer Cost-Unit Labor+Polaris Rebate), Unit
// Profit % (of the sales price), Acc. Profit (=Acc. Sales Price-Acc.
// Cost-Acc. Labor) and %, Holdback (=MSRP x the rate, so none without an
// MSRP: trades and trailers), TOTAL PROFIT (=Unit Profit+Acc. Profit+ESC
// Price-ESC Cost+Rewards+Holdback), PROFIT % (of what the customer paid
// for the unit, its accessories and the ESC), TOTAL BONUS (=TOTAL PROFIT x
// the bonus rate), Holdback Bonus (=Holdback x the rate) and Sales Bonus
// (=TOTAL BONUS-Holdback Bonus, plus any adjustment the sale carries, which
// the spreadsheet made by changing the formula). Plus the ESC's profit, the
// gross and the discount off MSRP, which the spreadsheet didn't have.
// Amounts a rate makes are rounded to the cent, half away from zero;
// percentages are fractions (0.0697 is 6.97%), null when there's nothing to
// divide by.
export type SaleFigures = {
  unitProfit: Cents;
  unitProfitPct: number | null;
  accProfit: Cents;
  accProfitPct: number | null;
  escProfit: Cents;
  holdback: Cents;
  totalProfit: Cents;
  profitPct: number | null;
  totalBonus: Cents;
  holdbackBonus: Cents;
  salesBonus: Cents;
  gross: Cents;
  discount: Cents | null;
};

const amount = (value: Cents | null) => value ?? 0;
const share = (part: Cents, whole: Cents) => (whole === 0 ? null : part / whole);
export const atRate = (cents: Cents, rateBp: number) => {
  const exact = (cents * rateBp) / 10_000;
  return Math.sign(exact) * Math.round(Math.abs(exact));
};

// --- A sale ------------------------------------------------------------------

export const SALE_LIMITS = {
  salesperson: 80,
  customerName: 120,
  customerAddress: 200,
  customerPhone: 40,
  unitModel: 80,
  vin: 30,
  category: 30,
  notes: 2000,
  financeCompany: 80,
  comsNumber: 40,
} as const;

export const MIN_UNIT_YEAR = 1950;
export const MAX_UNIT_YEAR = 2100;

// What a sale holds, checked: everything the spreadsheet had typed in.
export type SaleFields = SaleAmounts &
  SaleRates & {
    soldOn: string;
    salesperson: string | null;
    customerName: string;
    customerAddress: string | null;
    customerPhone: string | null;
    unitYear: number | null;
    unitModel: string | null;
    condition: UnitCondition;
    unitType: UnitType;
    vin: string | null;
    category: string | null;
    notes: string | null;
    financeCompany: string | null;
    fundingReceivedOn: string | null;
    paidOn: string | null;
    comsNumber: string | null;
  };

export type SaleTextField = Exclude<keyof SaleFields, MoneyField | keyof SaleRates | "unitYear" | "condition" | "unitType">;

// The spreadsheet's headings, for the form's labels, its messages, the
// download and the import.
export const SALE_LABELS: Record<keyof SaleFields, string> = {
  soldOn: "Date",
  salesperson: "Salesman",
  customerName: "Customer Name",
  customerAddress: "Address",
  customerPhone: "Phone",
  unitYear: "Year",
  unitModel: "Model",
  condition: "New/Used",
  unitType: "Type",
  vin: "VIN",
  msrp: "MSRP",
  salesPrice: "Sales Price",
  dealerCost: "Dealer Cost",
  unitLabor: "Unit Labor",
  rebate: "Polaris Rebate",
  notes: "Notes",
  accPrice: "Acc. Sales Price",
  accCost: "Acc. Cost",
  accLabor: "Acc. Labor",
  escPrice: "ESC Price",
  escCost: "ESC Cost",
  rewards: "Rewards",
  holdbackRateBp: "Holdback %",
  bonusRateBp: "Bonus %",
  financeCompany: "Finance Company",
  amountFinanced: "Amt Financed",
  downPayment: "Down Pymt",
  bonusAdjustment: "Bonus adjustment",
  fundingReceivedOn: "Funding Rec'd",
  paidOn: "Date Paid",
  comsNumber: "COMS #",
  category: "Category",
};

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\u0000/g, "") : typeof value === "number" ? String(value) : "");
// One line: runs of spaces, tabs and line breaks become one space.
const line = (value: unknown) => text(value).replace(/\s+/g, " ").trim();
const orNull = (value: string) => (value === "" ? null : value);

// "2026-10-30" (what a date box sends), checked to be a real day.
export function parseIsoDate(value: unknown): string | null {
  const typed = line(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typed);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return year >= 2000 && year <= 2100 ? typed : null;
}

// A VIN as typed: upper-cased, without spaces and dashes. A whole VIN (17
// characters) never has I, O or Q; a trailer's or an old unit's serial can
// be shorter.
export function cleanVin(value: unknown): { vin: string | null } | { error: string } {
  const vin = line(value).toUpperCase().replace(/[\s-]+/g, "").replace(/^VIN[.:#]*/, "");
  if (!vin) return { vin: null };
  if (!/^[A-Z0-9]+$/.test(vin)) return { error: "A VIN is letters and digits only." };
  if (vin.length > SALE_LIMITS.vin) return { error: "That VIN is too long." };
  if (vin.length === 17 && /[IOQ]/.test(vin)) return { error: "A VIN never has I, O or Q in it (they'd pass for 1 and 0). Check those characters." };
  return { vin };
}

export const parseCondition = (value: unknown): UnitCondition | null => {
  const typed = line(value).toLowerCase();
  if (typed === "new" || typed === "n") return "new";
  if (typed === "used" || typed === "u") return "used";
  return null;
};

// What the form sends, checked; amounts and rates may be typed as the
// spreadsheet had them (parseMoney, parseRate).
export function checkSale(input: Record<keyof SaleFields, unknown>): { sale: SaleFields } | { error: string } {
  const soldOn = parseIsoDate(input.soldOn);
  if (!soldOn) return { error: "Enter the date it was sold." };
  const customerName = line(input.customerName);
  if (!customerName) return { error: "Enter the customer's name." };
  const condition = parseCondition(input.condition);
  if (!condition) return { error: "Pick New or Used." };
  if (!isUnitType(input.unitType)) return { error: "Pick the type of deal: a new whole good, a trade, a trailer, a contest unit or a free one." };
  const vin = cleanVin(input.vin);
  if ("error" in vin) return vin;
  const yearText = line(input.unitYear);
  const unitYear = yearText === "" ? null : Number(yearText);
  if (unitYear !== null && (!Number.isInteger(unitYear) || unitYear < MIN_UNIT_YEAR || unitYear > MAX_UNIT_YEAR)) {
    return { error: `The year is a model year, ${MIN_UNIT_YEAR} to ${MAX_UNIT_YEAR}.` };
  }
  const amounts = {} as SaleAmounts;
  for (const field of MONEY_FIELDS) {
    const parsed = parseMoney(input[field]);
    if ("error" in parsed) return { error: `${SALE_LABELS[field]} ${parsed.error}.` };
    amounts[field] = parsed.cents;
  }
  const holdback = parseRate(input.holdbackRateBp);
  if ("error" in holdback) return { error: `The holdback rate ${holdback.error}.` };
  const bonus = parseRate(input.bonusRateBp);
  if ("error" in bonus) return { error: `The bonus rate ${bonus.error}.` };
  const dates: Record<"fundingReceivedOn" | "paidOn", string | null> = { fundingReceivedOn: null, paidOn: null };
  for (const field of ["fundingReceivedOn", "paidOn"] as const) {
    if (line(input[field]) === "") continue;
    const date = parseIsoDate(input[field]);
    if (!date) return { error: `${SALE_LABELS[field]} isn't a date.` };
    dates[field] = date;
  }
  const notes = text(input.notes).replace(/\r\n?/g, "\n").trim();
  // Tidied as Customers tidies it ("(814) 555-0199") when it's a phone
  // number; anything else ("call his wife") as typed.
  const phone = normalizePhone(input.customerPhone);
  const sale: SaleFields = {
    soldOn,
    salesperson: orNull(line(input.salesperson)),
    customerName,
    customerAddress: orNull(line(input.customerAddress)),
    customerPhone: orNull("error" in phone ? line(input.customerPhone) : phone.phone),
    unitYear,
    unitModel: orNull(line(input.unitModel)),
    condition,
    unitType: input.unitType,
    vin: vin.vin,
    category: orNull(line(input.category)),
    notes: orNull(notes),
    financeCompany: orNull(line(input.financeCompany)),
    comsNumber: orNull(line(input.comsNumber)),
    ...amounts,
    // A blank holdback rate is none (a trade, a trailer); a blank bonus
    // rate the usual one.
    holdbackRateBp: holdback.bp ?? 0,
    bonusRateBp: bonus.bp ?? DEFAULT_BONUS_RATE_BP,
    ...dates,
  };
  for (const field of Object.keys(SALE_LIMITS) as (keyof typeof SALE_LIMITS)[]) {
    const value = sale[field];
    if (typeof value === "string" && value.length > SALE_LIMITS[field]) return { error: `${SALE_LABELS[field]} is too long.` };
  }
  return { sale };
}

// --- Reading what's typed ----------------------------------------------------

// The most a single amount can be: well past any unit's price.
export const MAX_AMOUNT_CENTS = 10_000_000_00;

// An amount as it's typed in a money box, or as a spreadsheet shows it:
// "1,234.56", "$1234.5", " 38,500.25 ", "(96.25)" or "-96.25" for a
// minus, blank or a lone "-" (Excel's accounting zero) for none. A sum or
// difference too, as the spreadsheet's cells often were: "1250+89.99
// +45.51+300", "980.40-300" (a leading "=" is fine). Whole cents, null
// when blank, or why it isn't an amount.
// One number in an amount: thousands with commas ("38,500.25") or without.
const TERM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+`;
const AMOUNT = new RegExp(String.raw`^[+-]?(?:${TERM})(?:[+-](?:${TERM}))*$`);

export function parseMoney(text: unknown): { cents: Cents | null } | { error: string } {
  let value = String(text ?? "")
    .replace(/\u0000/g, "")
    .replace(/[\s$]/g, "")
    .replace(/^=/, "");
  if (value === "" || value === "-") return { cents: null };
  const negative = /^\(.*\)$/.test(value);
  if (negative) value = value.slice(1, -1);
  if (!AMOUNT.test(value)) return { error: "isn't an amount" };
  let cents = 0;
  for (const term of value.match(/[+-]?[^+-]+/g) ?? []) {
    // Past the cent, as a formula's result can be: rounded to the cent.
    cents += Math.round(Number(term.replace(/,/g, "")) * 100);
  }
  if (negative) cents = -cents;
  if (Math.abs(cents) > MAX_AMOUNT_CENTS) return { error: "is too large" };
  return { cents };
}

// A rate as it's typed, in percent: "4", "4%", "4.5" -> 400, 400, 450
// basis points. Null when blank.
export function parseRate(text: unknown): { bp: number | null } | { error: string } {
  const value = String(text ?? "").replace(/[\s%]/g, "");
  if (value === "") return { bp: null };
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return { error: "isn't a percentage" };
  const bp = Math.round(Number(value) * 100);
  if (bp > MAX_RATE_BP) return { error: "is over 100%" };
  return { bp };
}

export function saleFigures(sale: SaleAmounts & SaleRates): SaleFigures {
  const unitProfit = amount(sale.salesPrice) - amount(sale.dealerCost) - amount(sale.unitLabor) + amount(sale.rebate);
  const accProfit = amount(sale.accPrice) - amount(sale.accCost) - amount(sale.accLabor);
  const escProfit = amount(sale.escPrice) - amount(sale.escCost);
  const holdback = sale.msrp === null ? 0 : atRate(sale.msrp, sale.holdbackRateBp);
  const totalProfit = unitProfit + accProfit + escProfit + amount(sale.rewards) + holdback;
  const gross = amount(sale.salesPrice) + amount(sale.accPrice) + amount(sale.escPrice);
  const totalBonus = atRate(totalProfit, sale.bonusRateBp);
  const holdbackBonus = atRate(holdback, sale.bonusRateBp);
  return {
    unitProfit,
    unitProfitPct: share(unitProfit, amount(sale.salesPrice)),
    accProfit,
    accProfitPct: share(accProfit, amount(sale.accPrice)),
    escProfit,
    holdback,
    totalProfit,
    profitPct: share(totalProfit, gross),
    totalBonus,
    holdbackBonus,
    salesBonus: totalBonus - holdbackBonus + amount(sale.bonusAdjustment),
    gross,
    discount: sale.msrp === null || sale.salesPrice === null ? null : sale.msrp - sale.salesPrice,
  };
}

// --- Showing it --------------------------------------------------------------

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// "$38,500.25", "-$96.25"; blank for none.
export const formatMoney = (cents: Cents | null) => (cents === null ? "" : MONEY.format(cents / 100));
// "6.97%"; a dash when there's nothing to divide by.
export const formatPct = (fraction: number | null) => (fraction === null ? "—" : `${(fraction * 100).toFixed(2)}%`);
// "4%", "4.5%".
export const formatRate = (bp: number) => `${Number((bp / 100).toFixed(2))}%`;
// What a form's box shows for an amount or a rate, as it would be typed.
export const moneyInput = (cents: Cents | null) => (cents === null ? "" : (cents / 100).toFixed(2));
export const rateInput = (bp: number) => String(Number((bp / 100).toFixed(2)));

// "2026-10-28" -> "10/28/2026", as the spreadsheet wrote its dates.
export function formatDay(iso: string | null) {
  const match = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return match ? `${Number(match[2])}/${Number(match[3])}/${match[1]}` : "";
}

// "2026 Xpedition ADV 5P NS", or the VIN when there's nothing else.
export function unitLabel(sale: Pick<SaleFields, "unitYear" | "unitModel" | "vin">) {
  const label = [sale.unitYear, sale.unitModel].filter(Boolean).join(" ");
  return label || (sale.vin ? `VIN ${sale.vin}` : "Unit");
}

// What's still to do on a sale: a lender hasn't paid what it financed yet,
// or a new unit isn't paid off.
export type SaleFlags = { awaitingFunding: boolean; notPaidOff: boolean };
export const saleFlags = (sale: Pick<SaleFields, "amountFinanced" | "fundingReceivedOn" | "condition" | "paidOn">): SaleFlags => ({
  awaitingFunding: (sale.amountFinanced ?? 0) > 0 && sale.fundingReceivedOn === null,
  notPaidOff: sale.condition === "new" && sale.paidOn === null,
});

// --- Totals ------------------------------------------------------------------

// The figures added up, as the spreadsheet's TOTAL rows; the percentages
// of the totals; and each per unit, as its AVG rows.
export const FIGURE_SUMS = ["unitProfit", "accProfit", "escProfit", "holdback", "totalProfit", "totalBonus", "holdbackBonus", "salesBonus", "gross"] as const;
export type FigureSum = (typeof FIGURE_SUMS)[number];

export type SaleTotals = {
  units: number;
  newUnits: number;
  usedUnits: number;
  amounts: Record<MoneyField, Cents>;
  figures: Record<FigureSum, Cents>;
  unitProfitPct: number | null;
  accProfitPct: number | null;
  profitPct: number | null;
};

export type FiguredSale = SaleFields & { figures: SaleFigures };

export const withFigures = <T extends SaleFields>(sale: T): T & { figures: SaleFigures } => ({ ...sale, figures: saleFigures(sale) });

export function saleTotals(sales: readonly FiguredSale[]): SaleTotals {
  const amounts = Object.fromEntries(MONEY_FIELDS.map((field) => [field, 0])) as Record<MoneyField, Cents>;
  const figures = Object.fromEntries(FIGURE_SUMS.map((field) => [field, 0])) as Record<FigureSum, Cents>;
  let newUnits = 0;
  for (const sale of sales) {
    if (sale.condition === "new") newUnits++;
    for (const field of MONEY_FIELDS) amounts[field] += sale[field] ?? 0;
    for (const field of FIGURE_SUMS) figures[field] += sale.figures[field];
  }
  return {
    units: sales.length,
    newUnits,
    usedUnits: sales.length - newUnits,
    amounts,
    figures,
    unitProfitPct: share(figures.unitProfit, amounts.salesPrice),
    accProfitPct: share(figures.accProfit, amounts.accPrice),
    profitPct: share(figures.totalProfit, figures.gross),
  };
}

// Per unit: a total over the units, to the cent.
export const perUnit = (cents: Cents, units: number) => (units === 0 ? null : Math.round(cents / units));

// Totals for each salesman, category or month, the most units first (by
// month, in the year's order).
// Grouped as the log's filters match them, whatever the capitals and
// spacing ("Ben" and "BEN " are one salesman), under the spelling met first.
export function totalsBy(sales: readonly FiguredSale[], keyOf: (sale: FiguredSale) => string): { key: string; totals: SaleTotals }[] {
  const groups = new Map<string, { key: string; sales: FiguredSale[] }>();
  for (const sale of sales) {
    const key = keyOf(sale).trim().replace(/\s+/g, " ");
    const folded = key.toLowerCase();
    const group = groups.get(folded);
    if (group) group.sales.push(sale);
    else groups.set(folded, { key, sales: [sale] });
  }
  return [...groups.values()].map((group) => ({ key: group.key, totals: saleTotals(group.sales) }));
}

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Units sold each month, year beside year, with the change from the year
// before: the spreadsheet's Comparison table, counted instead of typed.
export type MonthlyComparison = {
  years: number[];
  months: { month: number; units: Record<number, number> }[];
  totals: Record<number, number>;
};

export function monthlyComparison(counts: readonly { year: number; month: number; units: number }[]): MonthlyComparison {
  const years = [...new Set(counts.map((count) => count.year))].sort((a, b) => a - b);
  const months = MONTH_NAMES.map((_, index) => ({ month: index + 1, units: Object.fromEntries(years.map((year) => [year, 0])) as Record<number, number> }));
  const totals = Object.fromEntries(years.map((year) => [year, 0])) as Record<number, number>;
  for (const count of counts) {
    months[count.month - 1].units[count.year] += count.units;
    totals[count.year] += count.units;
  }
  return { years, months, totals };
}

// --- Finding sales -------------------------------------------------------------

// What's still to do, to list the sales it's left on.
export const SALE_STATUSES = ["funding", "unpaid"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];
export const SALE_STATUS_LABELS: Record<SaleStatus, string> = { funding: "Awaiting funding", unpaid: "Not paid off" };

// The log's filters, from the address: a year (this one unless another or
// "all" is asked for) and a month in it, New or Used, a category, a
// salesman, what's still to do, and a search.
export type SaleFilters = {
  year: number | null;
  month: number | null;
  condition: UnitCondition | null;
  unitType: UnitType | null;
  category: string | null;
  salesperson: string | null;
  status: SaleStatus | null;
  query: string;
};

type Params = Record<string, string | string[] | undefined>;
const param = (params: Params, key: string) => {
  const value = params[key];
  return (typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "").replace(/\u0000/g, "").trim();
};

export function parseSaleFilters(params: Params, thisYear: number): SaleFilters {
  const yearText = param(params, "year");
  const year = yearText === "all" ? null : /^\d{4}$/.test(yearText) && Number(yearText) >= 2000 && Number(yearText) <= 2100 ? Number(yearText) : thisYear;
  const monthText = param(params, "month");
  const status = param(params, "status");
  return {
    year,
    month: year !== null && /^(?:[1-9]|1[0-2])$/.test(monthText) ? Number(monthText) : null,
    condition: parseCondition(param(params, "condition")),
    unitType: isUnitType(param(params, "type")) ? (param(params, "type") as UnitType) : null,
    category: param(params, "category").slice(0, SALE_LIMITS.category) || null,
    salesperson: param(params, "salesperson").slice(0, SALE_LIMITS.salesperson) || null,
    status: (SALE_STATUSES as readonly string[]).includes(status) ? (status as SaleStatus) : null,
    query: param(params, "q").replace(/\s+/g, " ").slice(0, 100),
  };
}

// The filters as an address's search, leaving out what's as it is by
// default (this year, everything else unset).
export function filtersSearch(filters: SaleFilters, thisYear: number, extra: Record<string, string | number | null> = {}) {
  const params = new URLSearchParams();
  if (filters.year === null) params.set("year", "all");
  else if (filters.year !== thisYear) params.set("year", String(filters.year));
  if (filters.month !== null) params.set("month", String(filters.month));
  if (filters.condition) params.set("condition", filters.condition);
  if (filters.unitType) params.set("type", filters.unitType);
  if (filters.category) params.set("category", filters.category);
  if (filters.salesperson) params.set("salesperson", filters.salesperson);
  if (filters.status) params.set("status", filters.status);
  if (filters.query) params.set("q", filters.query);
  for (const [key, value] of Object.entries(extra)) if (value !== null && value !== "") params.set(key, String(value));
  const search = params.toString();
  return search ? `?${search}` : "";
}

// "2026", "October 2026", "All years", with what else narrows it.
export function filtersTitle(filters: SaleFilters) {
  const when = filters.year === null ? "All years" : filters.month === null ? String(filters.year) : `${MONTH_NAMES[filters.month - 1]} ${filters.year}`;
  const narrowed = [
    filters.condition === "new" ? "New" : filters.condition === "used" ? "Used" : null,
    filters.unitType ? UNIT_TYPE_LABELS[filters.unitType] : null,
    filters.category,
    filters.salesperson,
    filters.status ? SALE_STATUS_LABELS[filters.status] : null,
    filters.query ? `“${filters.query}”` : null,
  ].filter(Boolean);
  return narrowed.length ? `${when} · ${narrowed.join(" · ")}` : when;
}

// --- The form ------------------------------------------------------------------

// What the form's boxes hold: everything as typed.
export type SaleValues = Record<keyof SaleFields, string>;

// A sale as the form shows it, to correct it.
export function saleValues(sale: SaleFields): SaleValues {
  const values = {} as SaleValues;
  for (const key of Object.keys(SALE_LABELS) as (keyof SaleFields)[]) {
    const value = sale[key];
    values[key] =
      (MONEY_FIELDS as readonly string[]).includes(key)
        ? moneyInput(value as Cents | null)
        : key === "holdbackRateBp" || key === "bonusRateBp"
          ? rateInput(value as number)
          : value === null || value === undefined
            ? ""
            : String(value);
  }
  return values;
}

// A new sale's boxes: the day, the rates the last sale used, a new whole
// good; everything else blank.
export function blankSaleValues(defaults: { soldOn: string; holdbackRateBp: number; bonusRateBp: number }): SaleValues {
  const values = Object.fromEntries(Object.keys(SALE_LABELS).map((key) => [key, ""])) as SaleValues;
  return {
    ...values,
    soldOn: defaults.soldOn,
    condition: "new",
    unitType: "whole_good",
    holdbackRateBp: rateInput(defaults.holdbackRateBp),
    bonusRateBp: rateInput(defaults.bonusRateBp),
  };
}

// The form's amounts and rates as far as they read, for its figures as
// they're typed, and what doesn't read, by box.
export function readSaleValues(values: SaleValues): { sale: SaleAmounts & SaleRates; problems: Partial<Record<keyof SaleFields, string>> } {
  const problems: Partial<Record<keyof SaleFields, string>> = {};
  const sale = {} as SaleAmounts & SaleRates;
  for (const field of MONEY_FIELDS) {
    const parsed = parseMoney(values[field]);
    if ("error" in parsed) problems[field] = `${SALE_LABELS[field]} ${parsed.error}.`;
    sale[field] = "error" in parsed ? null : parsed.cents;
  }
  for (const field of ["holdbackRateBp", "bonusRateBp"] as const) {
    const parsed = parseRate(values[field]);
    if ("error" in parsed) problems[field] = `${SALE_LABELS[field]} ${parsed.error}.`;
    sale[field] = "error" in parsed || parsed.bp === null ? (field === "bonusRateBp" ? DEFAULT_BONUS_RATE_BP : 0) : parsed.bp;
  }
  return { sale, problems };
}

// The shop's day ("2026-10-31"), for a new sale's date: in its own time
// zone, which for now is the Eastern one the dealership keeps.
export const SHOP_TIME_ZONE = "America/New_York";
export const shopToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
