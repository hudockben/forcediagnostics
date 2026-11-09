// The LOC tab: the shop's units on its line of credit (the floor plan) and
// the ones it owns outright, as its LOC spreadsheet kept them. Each unit's
// model, stock #, when its free floor ends and what it cost; the units we
// own listed above the ones we owe on the LOC ("here down we owe on LOC");
// and the totals, the LOC's own to balance with the books. What a unit
// holds and how what's typed is read, where its free floor stands, the
// list's filters and totals, what the NUSR says about a unit, and a
// trade-in logged with a NUSR sale. No server imports, so the forms check
// what's typed the way the server does.

import { cutText } from "@/lib/manual-rules";
import {
  CATEGORIES,
  cleanVin,
  formatDay,
  guessCategory,
  line,
  parseCondition,
  parseIsoDate,
  parseMoney,
  type Cents,
  type UnitCondition,
} from "@/lib/nusr-rules";

// The account the LOC's total has to balance with in the shop's books, as
// its sheet says ("this amt MUST always balance with >>> Total on
// Flooring", "L/S account # 32400"). For now the one dealership's.
export const LOC_ACCOUNT = "32400";

// Where a unit is: owed on the line of credit, or the shop's own (paid off
// the line, or a trade-in, which never goes on it). The sheet lists the
// units we own first, then the ones we owe on the LOC.
export const LOC_SECTIONS = ["owned", "loc"] as const;
export type LocSection = (typeof LOC_SECTIONS)[number];
export const LOC_SECTION_LABELS: Record<LocSection, string> = { owned: "We own", loc: "On the LOC" };
export const sectionOf = (unit: { onLoc: boolean }): LocSection => (unit.onLoc ? "loc" : "owned");
export const isLocSection = (value: unknown): value is LocSection => value === "loc" || value === "owned";

// What a unit on the LOC holds. Cost is whole cents. A unit is on the list
// while it's in stock (soldOn null) and, sold, until it's paid off the LOC:
// what's owed on the line stays in its total until the payoff.
export type LocUnitFields = {
  // As the shop writes it, kept as text: a leading zero stays ("099837"),
  // and it's six digits on most units, seven on some models ("8071708").
  stockNumber: string | null;
  // Upper-cased; a whole VIN, or a trailer's or an old unit's serial.
  vin: string | null;
  unitYear: number | null;
  // As the sheet writes it, colour and all: "RZR 900 50" - Zenith Blue".
  model: string;
  category: string | null;
  condition: UnitCondition;
  cost: Cents;
  // Its last day of free flooring; interest runs from the day after.
  freeFloorEnds: string | null;
  // When it came in (its time in stock counts from here).
  receivedOn: string | null;
  onLoc: boolean;
  // When it was paid off the LOC, when it was.
  paidOffOn: string | null;
  soldOn: string | null;
  notes: string | null;
};

// What the forms' boxes are called, as the sheet heads its columns.
export const LOC_LABELS = {
  stockNumber: "Stock #",
  vin: "VIN",
  unitYear: "Year",
  model: "Model",
  category: "Category",
  condition: "New/Used",
  cost: "Cost",
  freeFloorEnds: "Free Floor Ends",
  receivedOn: "Date in",
  section: "On the LOC or ours",
  paidOffOn: "Paid off",
  soldOn: "Sold",
  notes: "Notes",
} as const;
export type LocValueKey = keyof typeof LOC_LABELS;
export const LOC_VALUE_KEYS = Object.keys(LOC_LABELS) as LocValueKey[];

// What a unit's boxes hold, as typed.
export type LocValues = Record<LocValueKey, string>;

export const LOC_LIMITS = { stockNumber: 20, vin: 30, model: 120, category: 30, notes: 2000 } as const;

export const MIN_LOC_YEAR = 1950;
export const MAX_LOC_YEAR = 2100;

// --- Reading what's typed --------------------------------------------------------

const orNull = (value: string) => (value === "" ? null : value);

// A stock # as typed: kept as text, so "099837" keeps its zero, whatever its
// length. Upper-cased with its spaces tidied; a "#" or a "Stock #" label in
// front is dropped.
export function cleanStockNumber(value: unknown): { stockNumber: string | null } | { error: string } {
  const typed = line(value)
    .toUpperCase()
    .replace(/^(?:STOCK|STK)\s*(?:#|NO\.)?\s*:?\s*/, "")
    .replace(/^#\s*/, "");
  if (!typed) return { stockNumber: null };
  if (!/^[A-Z0-9](?:[A-Z0-9 ./-]*[A-Z0-9])?$/.test(typed)) return { error: "A stock # is letters and digits (a dash, dot or slash between them is fine)." };
  if (typed.length > LOC_LIMITS.stockNumber) return { error: "That stock # is too long." };
  return { stockNumber: typed };
}

// Two stock #s are one when they match without case ("t1234" is T1234).
export const stockKey = (stockNumber: string) => stockNumber.toLowerCase();

// The stock # a whole VIN gives a unit, the way the shop numbers them: the
// digits at the end of its last seven characters (the plant's code, then
// the serial). Most Polaris VINs have a letter for the plant, so that's the
// last six ("…TM204033" is 204033); on some models the plant is a digit, so
// it's seven ("…T8071708" is 8071708).
export function stockFromVin(vin: string | null | undefined): string | null {
  if (!vin || vin.length !== 17) return null;
  const digits = /\d+$/.exec(vin.slice(10))?.[0] ?? "";
  return digits.length >= 4 ? digits : null;
}

// "2026 RZR 900 50" - Zenith Blue" -> 2026 and the rest: the sheet writes
// each unit's model year in front of its model.
export function splitModelYear(text: string): { unitYear: number | null; model: string } {
  const typed = line(text);
  const match = /^(19[5-9]\d|20\d\d|2100)\s+(\S.*)$/.exec(typed);
  return match ? { unitYear: Number(match[1]), model: match[2] } : { unitYear: null, model: typed };
}

// "2026 RZR 900 50" - Zenith Blue", as the sheet's Model column has it.
export const locUnitLabel = (unit: { unitYear: number | null; model: string }) => [unit.unitYear, unit.model].filter(Boolean).join(" ");

// The days from one day to another ("2026-10-01" to "2026-10-31" is 30).
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round(dayNumber(to) - dayNumber(from));

// A free floor that ends before its model year could have come in (a 2027
// ending in 2024): a slip in the year, most likely ("1/20/2024" for 2027).
export const floorDateLooksOff = (unitYear: number | null, freeFloorEnds: string | null) =>
  unitYear !== null && freeFloorEnds !== null && Number(freeFloorEnds.slice(0, 4)) < unitYear - 1;

// What's wrong with a unit as sent, and the box it's about.
export type LocProblem = { error: string; field?: LocValueKey };

// What the form (or a row of an import) sends, checked. A model and a cost
// are needed; the rest is optional. Amounts may be typed as the sheet's
// cells had them ("31,861", "1250+89.99"). A unit we own can carry the day
// it was paid off the LOC; one on the LOC can't.
export function checkLocUnit(input: Partial<Record<LocValueKey, unknown>>): { unit: LocUnitFields } | LocProblem {
  const model = line(input.model);
  if (!model) return { error: "Enter the model.", field: "model" };
  if (model.length > LOC_LIMITS.model) return { error: "The model is too long.", field: "model" };
  const stock = cleanStockNumber(input.stockNumber);
  if ("error" in stock) return { error: stock.error, field: "stockNumber" };
  const vin = cleanVin(input.vin);
  if ("error" in vin) return { error: vin.error, field: "vin" };
  const yearText = line(input.unitYear);
  const unitYear = yearText === "" ? null : Number(yearText);
  if (unitYear !== null && (!/^\d{4}$/.test(yearText) || unitYear < MIN_LOC_YEAR || unitYear > MAX_LOC_YEAR)) {
    return { error: `The year is a model year, ${MIN_LOC_YEAR} to ${MAX_LOC_YEAR}.`, field: "unitYear" };
  }
  const category = line(input.category);
  if (category.length > LOC_LIMITS.category) return { error: "The category is too long.", field: "category" };
  const condition = line(input.condition) === "" ? "new" : parseCondition(input.condition);
  if (!condition) return { error: "Pick New or Used.", field: "condition" };
  const cost = parseMoney(input.cost);
  if ("error" in cost) return { error: `The cost ${cost.error}.`, field: "cost" };
  if (cost.cents === null) return { error: "Enter what it cost.", field: "cost" };
  if (cost.cents < 0) return { error: "A cost can't be below nothing.", field: "cost" };
  const dates = { freeFloorEnds: null, receivedOn: null, paidOffOn: null, soldOn: null } as Record<"freeFloorEnds" | "receivedOn" | "paidOffOn" | "soldOn", string | null>;
  for (const field of ["freeFloorEnds", "receivedOn", "paidOffOn", "soldOn"] as const) {
    if (line(input[field]) === "") continue;
    const date = parseIsoDate(input[field]);
    if (!date) return { error: `${LOC_LABELS[field]} isn't a date.`, field };
    dates[field] = date;
  }
  const section = line(input.section) || "loc";
  if (!isLocSection(section)) return { error: "Say whether it's on the LOC or ours.", field: "section" };
  const onLoc = section === "loc";
  if (dates.receivedOn && dates.soldOn && dates.soldOn < dates.receivedOn) return { error: "It can't have been sold before it came in.", field: "soldOn" };
  const notes = (typeof input.notes === "string" ? input.notes : "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (notes.length > LOC_LIMITS.notes) return { error: "The notes are too long.", field: "notes" };
  return {
    unit: {
      stockNumber: stock.stockNumber,
      vin: vin.vin,
      unitYear,
      model,
      category: orNull(category),
      condition,
      cost: cost.cents,
      freeFloorEnds: dates.freeFloorEnds,
      receivedOn: dates.receivedOn,
      onLoc,
      // On the LOC, it isn't paid off.
      paidOffOn: onLoc ? null : dates.paidOffOn,
      soldOn: dates.soldOn,
      notes: orNull(notes),
    },
  };
}

// --- The form ----------------------------------------------------------------------

const moneyBox = (cents: Cents) => (cents / 100).toFixed(2);

// A unit as its form shows it, to correct it.
export function locValues(unit: LocUnitFields): LocValues {
  return {
    stockNumber: unit.stockNumber ?? "",
    vin: unit.vin ?? "",
    unitYear: unit.unitYear === null ? "" : String(unit.unitYear),
    model: unit.model,
    category: unit.category ?? "",
    condition: unit.condition,
    cost: moneyBox(unit.cost),
    freeFloorEnds: unit.freeFloorEnds ?? "",
    receivedOn: unit.receivedOn ?? "",
    section: sectionOf(unit),
    paidOffOn: unit.paidOffOn ?? "",
    soldOn: unit.soldOn ?? "",
    notes: unit.notes ?? "",
  };
}

// A new unit's boxes: in today, new, and on the LOC, as a new unit comes in.
export function blankLocValues(receivedOn: string): LocValues {
  const values = Object.fromEntries(LOC_VALUE_KEYS.map((key) => [key, ""])) as LocValues;
  return { ...values, receivedOn, condition: "new", section: "loc" };
}

// --- Free floor ----------------------------------------------------------------------

// How close an end counts as soon.
export const SOON_DAYS = 30;

export const FLOOR_STATES = ["ended", "soon", "free", "none"] as const;
export type FloorState = (typeof FLOOR_STATES)[number];
export const FLOOR_STATE_LABELS: Record<FloorState, string> = {
  ended: "Free floor ended",
  soon: `Ends within ${SOON_DAYS} days`,
  free: `More than ${SOON_DAYS} days left`,
  none: "No free floor date",
};

// Where a unit's free floor stands on a day (the shop's today): ended from
// the day after its last free day, ending soon within 30 days (0 left on
// its last day), or with longer to go; and the days since it ended, or the
// days left.
export function floorStatus(freeFloorEnds: string | null, today: string): { state: FloorState; days: number | null } {
  if (!freeFloorEnds) return { state: "none", days: null };
  const left = daysBetween(today, freeFloorEnds);
  if (left < 0) return { state: "ended", days: -left };
  return { state: left <= SOON_DAYS ? "soon" : "free", days: left };
}

const daysText = (days: number) => `${days.toLocaleString("en-US")} ${days === 1 ? "day" : "days"}`;

// "Ended 28 days ago", "Ends today", "12 days left".
export function floorStatusText(status: { state: FloorState; days: number | null }): string {
  if (status.days === null) return "";
  if (status.state === "ended") return `Ended ${daysText(status.days)} ago`;
  return status.days === 0 ? "Ends today" : `${daysText(status.days)} left`;
}

// Its days in stock: from the day it came in to the day it sold, or to
// today; null when the day it came in isn't known.
export const daysInStock = (unit: Pick<LocUnitFields, "receivedOn" | "soldOn">, today: string) =>
  unit.receivedOn ? Math.max(0, daysBetween(unit.receivedOn, unit.soldOn ?? today)) : null;

// --- What the NUSR says --------------------------------------------------------------

// A NUSR sale that may be a unit on the LOC, as the server reads it.
export type NusrSaleSeen = {
  id: string;
  vin: string | null;
  soldOn: string;
  customerName: string;
  condition: UnitCondition;
  unitYear: number | null;
  paidOn: string | null;
  comsNumber: string | null;
};

type Matchable = Pick<LocUnitFields, "stockNumber" | "vin" | "unitYear" | "condition" | "receivedOn"> & { tradeSaleId: string | null };

// Whether a unit's stock # is the end of a sale's VIN: a stock # of five
// digits or more (a lost leading zero leaves five), the same model year
// when both say.
function stockMatches(unit: Matchable, sale: NusrSaleSeen) {
  return (
    unit.stockNumber !== null &&
    /^\d{5,}$/.test(unit.stockNumber) &&
    sale.vin !== null &&
    sale.vin.length === 17 &&
    sale.vin.endsWith(unit.stockNumber) &&
    (unit.unitYear === null || sale.unitYear === null || unit.unitYear === sale.unitYear)
  );
}

// The NUSR's sale of a unit on the LOC, if it has one: the same VIN, or a
// unit without one whose stock # ends a sale's VIN, sold new or used as the
// unit is, on or after the day it came in (so a trade-in doesn't find its
// own sale new years ago), and not the sale it was traded in on. The first
// after it came in, or the latest when that day isn't known.
export function nusrSaleFor(unit: Matchable, sales: readonly NusrSaleSeen[]): NusrSaleSeen | null {
  const found = sales
    .filter(
      (sale) =>
        sale.id !== unit.tradeSaleId &&
        sale.condition === unit.condition &&
        (!unit.receivedOn || sale.soldOn >= unit.receivedOn) &&
        (unit.vin && unit.vin.length === 17 ? sale.vin === unit.vin : stockMatches(unit, sale)),
    )
    .sort((a, b) => (a.soldOn < b.soldOn ? -1 : a.soldOn > b.soldOn ? 1 : 0));
  return (unit.receivedOn ? found[0] : found.at(-1)) ?? null;
}

// What the NUSR knows that the LOC doesn't yet: the unit's been sold, or
// (sold and still on the LOC) its payoff's been made.
export type NusrNews = { kind: "sold" | "paid"; sale: NusrSaleSeen };
export function nusrNews(unit: Pick<LocUnitFields, "soldOn" | "onLoc">, sale: NusrSaleSeen | null): NusrNews | null {
  if (!sale) return null;
  if (unit.soldOn === null) return { kind: "sold", sale };
  if (unit.onLoc && sale.paidOn) return { kind: "paid", sale };
  return null;
}

// "Sold 11/9/2026 to Dana Whitfield", "Paid off 11/12/2026 (COMS 4410)".
export function nusrNewsText(news: NusrNews) {
  if (news.kind === "sold") return `Sold ${formatDay(news.sale.soldOn)} to ${news.sale.customerName}`;
  return `Paid off ${formatDay(news.sale.paidOn)}${news.sale.comsNumber ? ` (COMS # ${news.sale.comsNumber})` : ""}`;
}

// --- Finding units ---------------------------------------------------------------------

// What the list shows: what's on it (in stock, and sold units still owed on
// the LOC), the LOC's or ours alone, what the NUSR has sold that the LOC
// doesn't know of yet, or what's been sold.
export const LOC_SHOWS = ["loc", "owned", "nusr", "sold"] as const;
export type LocShow = (typeof LOC_SHOWS)[number];
export const LOC_SHOW_LABELS: Record<LocShow, string> = {
  loc: "On the LOC",
  owned: "We own",
  nusr: "Sold in the NUSR",
  sold: "Sold",
};
export const ON_THE_LIST = "On the list";

export type LocFilters = {
  show: LocShow | null;
  floor: FloorState | null;
  condition: UnitCondition | null;
  category: string | null;
  year: number | null;
  query: string;
};

type Params = Record<string, string | string[] | undefined>;
const param = (params: Params, key: string) => {
  const value = params[key];
  return (typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "").replace(/\u0000/g, "").trim();
};

// The list's filters, from its address.
export function parseLocFilters(params: Params): LocFilters {
  const show = param(params, "show");
  const floor = param(params, "floor");
  const year = param(params, "year");
  return {
    show: (LOC_SHOWS as readonly string[]).includes(show) ? (show as LocShow) : null,
    floor: (FLOOR_STATES as readonly string[]).includes(floor) ? (floor as FloorState) : null,
    condition: parseCondition(param(params, "condition")),
    category: cutText(param(params, "category"), LOC_LIMITS.category) || null,
    year: /^\d{4}$/.test(year) && Number(year) >= MIN_LOC_YEAR && Number(year) <= MAX_LOC_YEAR ? Number(year) : null,
    query: cutText(param(params, "q").replace(/\s+/g, " "), 100),
  };
}

// The filters as an address's search ("?show=loc&floor=ended"), leaving
// out what's as it is to start with.
export function locFiltersSearch(filters: LocFilters, extra: Record<string, string | number | null> = {}) {
  const params = new URLSearchParams();
  if (filters.show) params.set("show", filters.show);
  if (filters.floor) params.set("floor", filters.floor);
  if (filters.condition) params.set("condition", filters.condition);
  if (filters.category) params.set("category", filters.category);
  if (filters.year !== null) params.set("year", String(filters.year));
  if (filters.query) params.set("q", filters.query);
  for (const [key, value] of Object.entries(extra)) if (value !== null && value !== "") params.set(key, String(value));
  const search = params.toString();
  return search ? `?${search}` : "";
}

// The list's own search as it was ("?show=loc&floor=ended"), from a
// link's ?back=, rebuilt from what the list's address can hold so nothing
// else gets through; "" for the list as it opens.
export function locBack(text: unknown): string {
  const params = new URLSearchParams(typeof text === "string" ? text.slice(0, 2000) : "");
  return locFiltersSearch(parseLocFilters(Object.fromEntries(params)));
}

// Whether anything narrows the list from what it shows to start with:
// its totals are then the narrowed list's, not the LOC's.
export const locNarrowed = (filters: LocFilters) =>
  filters.show !== null || filters.floor !== null || filters.condition !== null || filters.category !== null || filters.year !== null || filters.query !== "";

// What narrows the list apart from what it shows ("Free floor ended ·
// Used"), or "" when nothing does.
export function locFiltersNarrowing(filters: LocFilters) {
  return [
    filters.floor ? FLOOR_STATE_LABELS[filters.floor] : null,
    filters.condition === "new" ? "New" : filters.condition === "used" ? "Used" : null,
    filters.category,
    filters.year !== null ? `${filters.year} models` : null,
    filters.query ? `“${filters.query}”` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// "On the list", "On the LOC · Free floor ended".
export function locFiltersTitle(filters: LocFilters) {
  const shown = filters.show ? LOC_SHOW_LABELS[filters.show] : ON_THE_LIST;
  const narrowed = locFiltersNarrowing(filters);
  return narrowed ? `${shown} · ${narrowed}` : shown;
}

// The categories to pick from: the sheet's four, then any others in use.
export const locCategories = (inUse: readonly string[]) => {
  const seen = new Set(CATEGORIES.map((category) => category.toLowerCase()));
  return [...CATEGORIES, ...inUse.filter((category) => !seen.has(category.toLowerCase()))];
};

// --- Totals --------------------------------------------------------------------------

export type Tally = { units: number; cost: Cents };

// The list's totals, as the sheet's: what we own, what's on the LOC (the
// Total on Flooring, to balance with the books), and both (the Grand
// Total); and what the sheet left to the eye: units past their free floor
// and ending within 30 days (of those still to sell or pay off), sold
// units still owed on the LOC, and units the NUSR has sold that the LOC
// doesn't know of yet.
export type LocTotals = {
  all: Tally;
  loc: Tally;
  owned: Tally;
  ended: Tally & { loc: number; owned: number };
  soon: Tally;
  soldOnLoc: Tally;
  nusr: number;
};

const tally = (): Tally => ({ units: 0, cost: 0 });
const add = (into: Tally, cost: Cents) => {
  into.units++;
  into.cost += cost;
};

export function locTotals(
  units: readonly (Pick<LocUnitFields, "cost" | "onLoc" | "soldOn" | "freeFloorEnds"> & { nusr?: NusrNews | null })[],
  today: string,
): LocTotals {
  const totals: LocTotals = { all: tally(), loc: tally(), owned: tally(), ended: { ...tally(), loc: 0, owned: 0 }, soon: tally(), soldOnLoc: tally(), nusr: 0 };
  for (const unit of units) {
    add(totals.all, unit.cost);
    add(unit.onLoc ? totals.loc : totals.owned, unit.cost);
    if (unit.soldOn !== null && unit.onLoc) add(totals.soldOnLoc, unit.cost);
    if (unit.nusr) totals.nusr++;
    // A sold unit we own is off our hands: its free floor is nothing to us.
    if (unit.soldOn !== null && !unit.onLoc) continue;
    const { state } = floorStatus(unit.freeFloorEnds, today);
    if (state === "ended") {
      add(totals.ended, unit.cost);
      totals.ended[unit.onLoc ? "loc" : "owned"]++;
    } else if (state === "soon") add(totals.soon, unit.cost);
  }
  return totals;
}

// --- A trade-in on a NUSR sale ------------------------------------------------------------

// The boxes a sale's form has for a unit the customer trades in. They go
// on the LOC as a unit we own, at the trade-in's value: none of it is the
// sale's, so its profit and the salesman's bonuses never change for it.
export const TRADE_IN_LABELS = {
  tradeVin: "VIN",
  tradeYear: "Year",
  tradeModel: "Model",
  tradeStockNumber: "Stock #",
  tradeValue: "Trade-in value",
} as const;
export type TradeInKey = keyof typeof TRADE_IN_LABELS;
export const TRADE_IN_KEYS = Object.keys(TRADE_IN_LABELS) as TradeInKey[];

export type TradeIn = { vin: string | null; unitYear: number | null; model: string; stockNumber: string | null; cost: Cents };

// The trade-in's boxes, checked: all blank is no trade-in. One needs a
// model and the value it goes on the LOC at; its stock # comes from its
// VIN when none is typed.
export function checkTradeIn(input: Partial<Record<TradeInKey, unknown>> | null | undefined): { tradeIn: TradeIn | null } | { error: string; field: TradeInKey } {
  const typed = input ?? {};
  if (TRADE_IN_KEYS.every((key) => line(typed[key]) === "")) return { tradeIn: null };
  const vin = cleanVin(typed.tradeVin);
  if ("error" in vin) return { error: `Trade-in: ${vin.error}`, field: "tradeVin" };
  const checked = checkLocUnit({
    model: typed.tradeModel,
    unitYear: typed.tradeYear,
    stockNumber: typed.tradeStockNumber,
    cost: typed.tradeValue,
    condition: "used",
    section: "owned",
  });
  if ("error" in checked) {
    const field: Partial<Record<LocValueKey, TradeInKey>> = { model: "tradeModel", unitYear: "tradeYear", stockNumber: "tradeStockNumber", cost: "tradeValue" };
    const message =
      checked.field === "model"
        ? "Enter the trade-in's model."
        : checked.field === "cost" && line(typed.tradeValue) === ""
          ? "Enter the trade-in's value: what it goes on the LOC at."
          : `Trade-in: ${checked.error}`;
    return { error: message, field: field[checked.field ?? "model"] ?? "tradeModel" };
  }
  const unit = checked.unit;
  return { tradeIn: { vin: vin.vin, unitYear: unit.unitYear, model: unit.model, stockNumber: unit.stockNumber ?? stockFromVin(vin.vin), cost: unit.cost } };
}

// The trade-in as a unit on the LOC: used, ours (a trade-in isn't floored),
// in on the day of the sale, with no free floor.
export function tradeInUnit(tradeIn: TradeIn, soldOn: string): LocUnitFields {
  return {
    stockNumber: tradeIn.stockNumber,
    vin: tradeIn.vin,
    unitYear: tradeIn.unitYear,
    model: tradeIn.model,
    category: guessCategory(tradeIn.model),
    condition: "used",
    cost: tradeIn.cost,
    freeFloorEnds: null,
    receivedOn: soldOn,
    onLoc: false,
    paidOffOn: null,
    soldOn: null,
    notes: null,
  };
}

// --- Marking several at once ---------------------------------------------------------

// Ticked on the list: paid off the LOC together (one payoff often covers
// several), or sold.
export const LOC_MARKS = ["paid", "sold"] as const;
export type LocMark = (typeof LOC_MARKS)[number];
export const MAX_LOC_MARKED = 500;
