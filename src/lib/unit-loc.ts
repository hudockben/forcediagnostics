import "server-only";

import { inArray, or, sql, type SQL } from "drizzle-orm";

import type { ShopTransaction } from "@/db";
import { locUnits, stockUnits } from "@/db/schema";
import type { Cents } from "@/lib/nusr-rules";
import { MIN_VIN_TAIL, isLocUnitOf, isPartialVin, locUnitOf, stockOfVin, unitName, vinTails, type LocLink } from "@/lib/unit-list-rules";

// The Unit List and the LOC tab, connected: the same unit on both, by its
// VIN or the stock # its VIN gives (isLocUnitOf in unit-list-rules.ts).
// The Unit List shows where each unit stands on the LOC; the LOC shows each
// unit's list price, and a sale the Unit List marked. Each runs inside the
// caller's withShop, so only the shop's own units are found.

const unique = <T>(values: readonly T[]) => [...new Set(values)];

// "array['a', 'b']::text[]", for matching ends against a list.
const textArray = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

const locColumns = {
  id: locUnits.id,
  stockNumber: locUnits.stockNumber,
  vin: locUnits.vin,
  unitYear: locUnits.unitYear,
  model: locUnits.model,
  cost: locUnits.costCents,
  freeFloorEnds: locUnits.freeFloorEnds,
  receivedOn: locUnits.receivedOn,
  onLoc: locUnits.onLoc,
  paidOffOn: locUnits.paidOffOn,
  soldOn: locUnits.soldOn,
};

// How many units go in one look, so the lists of VINs stay well inside
// what Postgres takes.
const CHUNK = 400;

// The LOC's unit each of these units on the Unit List is (locUnitOf), by
// the unit's VIN: a LOC unit with its VIN (or the end of it), one with a
// whole VIN ending with a VIN's end from the shop's sheet, or one without a
// VIN whose stock # the VIN gives.
export async function locLinksFor(tx: ShopTransaction, units: readonly { vin: string; unitYear: number | null }[]): Promise<Map<string, LocLink>> {
  const links = new Map<string, LocLink>();
  const all = unique(units.map((unit) => unit.vin));
  for (let at = 0; at < all.length; at += CHUNK) {
    const vins = all.slice(at, at + CHUNK);
    const exact = unique([...vins, ...vins.flatMap(vinTails)]);
    const ends = unique(vins.filter((vin) => isPartialVin(vin) && vin.length >= MIN_VIN_TAIL).map((vin) => vin.slice(-MIN_VIN_TAIL)));
    const stocks = unique(vins.flatMap((vin) => stockOfVin(vin) ?? []).map((stock) => stock.toLowerCase()));
    const where: SQL[] = [inArray(locUnits.vin, exact)];
    if (ends.length) where.push(sql`(length(${locUnits.vin}) = 17 and right(${locUnits.vin}, ${MIN_VIN_TAIL}) = any(${textArray(ends)}))`);
    if (stocks.length) where.push(sql`lower(${locUnits.stockNumber}) = any(${textArray(stocks)})`);
    const rows = await tx.select(locColumns).from(locUnits).where(or(...where));
    for (const unit of units) {
      if (!vins.includes(unit.vin) || links.has(unit.vin)) continue;
      const found = locUnitOf(unit, rows);
      if (found) links.set(unit.vin, found);
    }
  }
  return links;
}

// A unit on the Unit List, as the LOC shows it beside its own: its name, its
// list price, and the day it's marked sold there.
export type UnitListLink = { id: string; name: string; listPrice: Cents | null; soldOn: string | null };

// The unit on the Unit List each of these LOC units is (by the LOC unit's
// id): one with its VIN or the end of it, or whose VIN ends with its stock #
// (for a LOC unit without a VIN) or with its VIN's end.
export async function unitListLinksFor(tx: ShopTransaction, loc: readonly Pick<LocLink, "id" | "vin" | "stockNumber" | "unitYear">[]): Promise<Map<string, UnitListLink>> {
  const links = new Map<string, UnitListLink>();
  for (let at = 0; at < loc.length; at += CHUNK) {
    const part = loc.slice(at, at + CHUNK);
    const vins = unique(part.flatMap((unit) => (unit.vin ? [unit.vin] : [])));
    const exact = unique([...vins, ...vins.flatMap(vinTails)]);
    // What a whole VIN on the Unit List ends with: a stock # (for a unit
    // without a VIN) or a VIN's end.
    const ends = unique(
      part.flatMap((unit) => (unit.vin ? (isPartialVin(unit.vin) && unit.vin.length >= MIN_VIN_TAIL ? [unit.vin] : []) : unit.stockNumber && unit.stockNumber.length >= 4 ? [unit.stockNumber.toUpperCase()] : [])),
    );
    const where: SQL[] = [];
    if (exact.length) where.push(inArray(stockUnits.vin, exact));
    if (ends.length) where.push(sql`exists (select 1 from unnest(${textArray(ends)}) as e(tail) where right(${stockUnits.vin}, length(e.tail)) = e.tail)`);
    if (where.length === 0) continue;
    const rows = await tx
      .select({ id: stockUnits.id, vin: stockUnits.vin, unitYear: stockUnits.unitYear, model: stockUnits.model, listPrice: stockUnits.listPriceCents, soldOn: stockUnits.soldOn })
      .from(stockUnits)
      .where(or(...where));
    for (const unit of part) {
      const found = rows.find((row) => isLocUnitOf(row, unit));
      if (found) links.set(unit.id, { id: found.id, name: unitName(found), listPrice: found.listPrice, soldOn: found.soldOn });
    }
  }
  return links;
}
