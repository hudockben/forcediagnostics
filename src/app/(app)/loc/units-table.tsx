import Link from "next/link";

import type { LocUnit } from "@/lib/loc";
import {
  LOC_ACCOUNT,
  LOC_SECTIONS,
  daysInStock,
  floorDateLooksOff,
  floorStatus,
  floorStatusText,
  locUnitLabel,
  nusrNewsText,
  sectionOf,
  type LocSection,
} from "@/lib/loc-rules";
import { formatDay, formatMoney } from "@/lib/nusr-rules";

import { QuickMark } from "./forms";

// The LOC as a table, as the sheet lists it: the units we own, then the
// ones we owe on the LOC, each by when its free floor ends, each section
// with its total under it (the LOC's is the Total on Flooring, which
// balances with the books). Sold units are listed on their own, the
// latest first.

export const MARK_FORM = "loc-mark";

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// The Unit List has it marked sold and the LOC doesn't yet (unless the
// NUSR's sale says so already): marked here with a tap, as the NUSR's are.
export const unitListSold = (unit: LocUnit) => Boolean(unit.unitList?.soldOn && !unit.soldOn && unit.nusr?.kind !== "sold" && (!unit.receivedOn || unit.unitList.soldOn >= unit.receivedOn));
const cell = "px-3 py-2.5 align-top";

function UnitRow({ unit, today, back, ticking }: { unit: LocUnit; today: string; back: string; ticking: boolean }) {
  const label = locUnitLabel(unit);
  const floor = floorStatus(unit.freeFloorEnds, today);
  const days = daysInStock(unit, today);
  // A free floor that's run out matters while the unit's still ours to
  // sell or still owed.
  const live = unit.soldOn === null || unit.onLoc;
  const href = `/loc/${unit.id}${back ? `?back=${encodeURIComponent(back)}` : ""}`;
  return (
    <tr data-loc-row={unit.stockNumber ?? unit.id} className="hover:bg-white/[0.02]">
      {ticking && (
        <td className="py-2.5 pr-1 pl-5 align-top sm:pl-6">
          <input type="checkbox" name="ids" value={unit.id} form={MARK_FORM} aria-label={`Tick ${label}`} className="mt-0.5 size-5 accent-glow" />
        </td>
      )}
      <td className={`${cell} ${ticking ? "" : "pl-5 sm:pl-6"} min-w-56`}>
        <Link href={href} className="font-medium text-ink hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none">
          {label}
        </Link>
        {unit.vin && <span className="block font-mono text-[11px] tracking-wide text-ink-muted">{unit.vin}</span>}
        {(unit.condition === "used" || unit.trade) && (
          <span className="mt-1 flex flex-wrap gap-1.5">
            {unit.condition === "used" && <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-ink-muted">Used</span>}
            {unit.trade && <span className="rounded-full bg-glow/10 px-2 py-0.5 text-[11px] text-glow">Trade-in</span>}
          </span>
        )}
      </td>
      <td className={`${cell} font-mono whitespace-nowrap text-ink`}>{unit.stockNumber ?? <span className="text-ink-muted">—</span>}</td>
      <td className={`${cell} whitespace-nowrap`}>
        {unit.freeFloorEnds ? (
          <>
            <span className="block text-ink">{formatDay(unit.freeFloorEnds)}</span>
            {live && (
              <span className={`block text-[11px] ${floor.state === "ended" ? "text-trail" : floor.state === "soon" ? "text-glow" : "text-ink-muted"}`} data-loc-floor={floor.state}>
                {floorStatusText(floor)}
              </span>
            )}
            {floorDateLooksOff(unit.unitYear, unit.freeFloorEnds) && <span className="block text-[11px] text-trail">Check the year</span>}
          </>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </td>
      <td className={`${cell} text-right font-mono whitespace-nowrap text-ink tabular-nums`}>{formatMoney(unit.cost)}</td>
      <td className={`${cell} text-right font-mono whitespace-nowrap text-ink-muted tabular-nums`}>{days === null ? "—" : days.toLocaleString("en-US")}</td>
      <td className={`${cell} min-w-48 pr-5 text-xs leading-5 sm:pr-6`}>
        {unit.soldOn && (
          <span className={`block ${unit.onLoc ? "text-trail" : "text-ink"}`}>
            Sold {formatDay(unit.soldOn)}
            {unit.onLoc ? " · still owed on the LOC" : ""}
          </span>
        )}
        {!unit.onLoc && unit.paidOffOn && <span className="block text-ink-muted">Paid off {formatDay(unit.paidOffOn)}</span>}
        {unit.trade && unit.tradeSaleId && (
          <span className="block text-ink-muted">
            Traded in by{" "}
            <Link href={`/nusr/${unit.tradeSaleId}`} className="text-glow/90 hover:text-glow hover:underline">
              {unit.trade.customerName}
            </Link>
            , {formatDay(unit.trade.soldOn)}
          </span>
        )}
        {unit.nusr && (
          <span className="block" data-loc-nusr={unit.nusr.kind}>
            <Link href={`/nusr/${unit.nusr.sale.id}`} className="text-glow hover:underline">
              NUSR: {nusrNewsText(unit.nusr)}
            </Link>{" "}
            {unit.nusr.kind === "sold" ? (
              <QuickMark id={unit.id} mark="sold" on={unit.nusr.sale.soldOn} back={back}>
                Mark sold {formatDay(unit.nusr.sale.soldOn)}
              </QuickMark>
            ) : unit.nusr.sale.paidOn ? (
              <QuickMark id={unit.id} mark="paid" on={unit.nusr.sale.paidOn} back={back}>
                Mark paid off {formatDay(unit.nusr.sale.paidOn)}
              </QuickMark>
            ) : null}
          </span>
        )}
        {unit.unitList && (
          <span className="block text-ink-muted" data-loc-unit-list>
            <Link href={`/unit-list/${unit.unitList.id}`} className="text-glow/90 hover:text-glow hover:underline">
              Unit List
            </Link>
            : {unit.unitList.listPrice === null ? "no list price yet" : `listed at ${formatMoney(unit.unitList.listPrice)}`}
            {unitListSold(unit) && (
              <>
                , sold {formatDay(unit.unitList.soldOn!)}{" "}
                <QuickMark id={unit.id} mark="sold" on={unit.unitList.soldOn!} back={back}>
                  Mark sold {formatDay(unit.unitList.soldOn!)}
                </QuickMark>
              </>
            )}
          </span>
        )}
        {unit.notes && <span className="block break-words text-ink-muted">{unit.notes.length > 120 ? `${unit.notes.slice(0, 120)}…` : unit.notes}</span>}
      </td>
    </tr>
  );
}

const SECTION_TOTAL_LABELS: Record<LocSection, string> = {
  owned: "We own",
  loc: "Total on Flooring",
};

export function LocTable({
  units,
  today,
  back,
  ticking,
  grouped,
}: {
  units: LocUnit[];
  today: string;
  // The list's search, for the way back from a unit and after marking.
  back: string;
  ticking: boolean;
  // In the sheet's sections, each with its total; or one list.
  grouped: boolean;
}) {
  const columns = ticking ? 7 : 6;
  const groups: { section: LocSection | null; units: LocUnit[] }[] = grouped
    ? LOC_SECTIONS.map((section) => ({ section, units: units.filter((unit) => sectionOf(unit) === section) })).filter((group) => group.units.length > 0)
    : [{ section: null, units }];
  return (
    <table className="w-full min-w-[56rem] text-sm" data-loc-table>
      <thead>
        <tr className="border-b border-white/10 text-left text-xs text-ink-muted">
          {ticking && (
            <th scope="col" className="w-8 py-2 pl-5 sm:pl-6">
              <span className="sr-only">Tick</span>
            </th>
          )}
          <th scope="col" className={`px-3 py-2 font-medium ${ticking ? "" : "pl-5 sm:pl-6"}`}>
            Model
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            Stock #
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            Free Floor Ends
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Cost
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Days in stock
          </th>
          <th scope="col" className="px-3 py-2 pr-5 font-medium sm:pr-6">
            Notes
          </th>
        </tr>
      </thead>
      {groups.map((group) => {
        const cost = group.units.reduce((sum, unit) => sum + unit.cost, 0);
        return (
          <tbody key={group.section ?? "all"} className="divide-y divide-white/10 border-b border-white/10" data-loc-section={group.section ?? "all"}>
            {group.section && (
              <tr className="bg-forest-950/40">
                <th scope="colgroup" colSpan={columns} className="px-5 py-2 text-left text-xs font-semibold tracking-wide text-glow uppercase sm:px-6">
                  {group.section === "loc" ? "On the LOC: we owe these" : "We own"}
                </th>
              </tr>
            )}
            {group.units.map((unit) => (
              <UnitRow key={unit.id} unit={unit} today={today} back={back} ticking={ticking} />
            ))}
            {group.section && (
              <tr className="bg-white/[0.03] font-semibold" data-loc-section-total={group.section}>
                <th scope="row" colSpan={ticking ? 4 : 3} className="px-5 py-2.5 text-left text-ink sm:px-6">
                  {SECTION_TOTAL_LABELS[group.section]}
                  <span className="ml-2 text-xs font-normal text-ink-muted">
                    {plural(group.units.length, "unit", "units")}
                    {group.section === "loc" ? ` · balances with account ${LOC_ACCOUNT}` : ""}
                  </span>
                </th>
                <td className="px-3 py-2.5 text-right font-mono text-ink tabular-nums">{formatMoney(cost)}</td>
                <td colSpan={2} />
              </tr>
            )}
          </tbody>
        );
      })}
    </table>
  );
}
