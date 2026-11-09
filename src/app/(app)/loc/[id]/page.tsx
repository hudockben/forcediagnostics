import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { getLocUnit, locSuggestions } from "@/lib/loc";
import { LOC_SECTION_LABELS, daysInStock, locBack, locUnitLabel, locValues, nusrNewsText, sectionOf } from "@/lib/loc-rules";
import { formatDay, formatMoney, shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { LocUnitForm, QuickMark, RemoveLocUnitForm } from "../forms";
import { unitListSold } from "../units-table";

export const metadata: Metadata = { title: "LOC unit" };

export default function LocUnitPage(props: PageProps<"/loc/[id]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <LocUnitScreen params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

// One unit, to correct, mark or remove; back is the list it was opened from.
async function LocUnitScreen({ params, searchParams }: { params: PageProps<"/loc/[id]">["params"]; searchParams: PageProps<"/loc/[id]">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const { id } = await params;
  const query = await searchParams;
  const back = locBack(query.back);
  const [unit, suggestions] = await Promise.all([getLocUnit(user.shop.id, id), locSuggestions(user.shop.id)]);
  if (!unit) notFound();
  const today = shopToday();
  const label = locUnitLabel(unit);
  const days = daysInStock(unit, today);
  return (
    <div className="space-y-6">
      <div>
        <Link href={`/loc${back}`} className="text-sm text-glow/90 hover:text-glow hover:underline">
          ‹ LOC
        </Link>
        <PageHeading
          title={<span className="break-words">{label}</span>}
          description={
            <>
              {unit.stockNumber ? `Stock # ${unit.stockNumber} · ` : ""}
              {unit.soldOn ? `Sold ${formatDay(unit.soldOn)}${unit.onLoc ? ", still owed on the LOC" : ""}` : LOC_SECTION_LABELS[sectionOf(unit)]} · {formatMoney(unit.cost)}
              {days !== null ? ` · ${days.toLocaleString("en-US")} ${days === 1 ? "day" : "days"} in stock` : ""}. Added
              {unit.createdBy ? ` by ${unit.createdBy}` : ""} <LocalTime value={unit.createdAt.toISOString()} year />
            </>
          }
        />
      </div>
      {query.saved === "1" && <Notice key={`saved-${unit.updatedAt.toISOString()}`}>Saved.</Notice>}
      {unit.trade && unit.tradeSaleId && (
        <Notice>
          Traded in by {unit.trade.customerName} on the sale of {unit.trade.unit}, {formatDay(unit.trade.soldOn)}.{" "}
          <Link href={`/nusr/${unit.tradeSaleId}`} className="font-medium underline">
            Open the sale
          </Link>
        </Notice>
      )}
      {unit.nusrSale && (
        <div className="rounded-lg border border-glow/30 bg-glow/5 px-4 py-3 text-sm text-ink" data-loc-unit-nusr>
          The NUSR has it sold {formatDay(unit.nusrSale.soldOn)} to {unit.nusrSale.customerName}
          {unit.nusrSale.paidOn ? `, paid off ${formatDay(unit.nusrSale.paidOn)}${unit.nusrSale.comsNumber ? ` (COMS # ${unit.nusrSale.comsNumber})` : ""}` : ""}.{" "}
          <Link href={`/nusr/${unit.nusrSale.id}`} className="font-medium text-glow hover:underline">
            Open the sale
          </Link>
          {unit.nusr && (
            <>
              {" · "}
              {unit.nusr.kind === "sold" ? (
                <QuickMark id={unit.id} mark="sold" on={unit.nusr.sale.soldOn} back={back}>
                  Mark it sold {formatDay(unit.nusr.sale.soldOn)}
                </QuickMark>
              ) : unit.nusr.sale.paidOn ? (
                <QuickMark id={unit.id} mark="paid" on={unit.nusr.sale.paidOn} back={back}>
                  Mark it paid off {formatDay(unit.nusr.sale.paidOn)}
                </QuickMark>
              ) : null}
              <span className="sr-only"> ({nusrNewsText(unit.nusr)})</span>
            </>
          )}
        </div>
      )}
      {unit.unitList && (
        <div className="rounded-lg border border-white/10 px-4 py-3 text-sm text-ink" data-loc-unit-unit-list>
          On the Unit List as {unit.unitList.name}, {unit.unitList.listPrice === null ? "with no list price yet" : `listed at ${formatMoney(unit.unitList.listPrice)}`}
          {unit.unitList.soldOn ? `, marked sold ${formatDay(unit.unitList.soldOn)}` : ""}.{" "}
          <Link href={`/unit-list/${unit.unitList.id}`} className="font-medium text-glow hover:underline">
            Open it there
          </Link>
          {unitListSold(unit) && (
            <>
              {" · "}
              <QuickMark id={unit.id} mark="sold" on={unit.unitList.soldOn!} back={back}>
                Mark it sold {formatDay(unit.unitList.soldOn!)}
              </QuickMark>
            </>
          )}
        </div>
      )}
      <LocUnitForm
        // Next keeps a visited page alive: a unit saved since is shown fresh.
        key={unit.updatedAt.toISOString()}
        unit={{ id: unit.id, values: locValues(unit) }}
        today={today}
        models={suggestions.models}
        categories={suggestions.categories}
        back={back}
      />
      <div className="max-w-md">
        <Card title="Remove" description="For a unit added by mistake. One that sold is marked sold instead, so the LOC keeps it until it's paid off.">
          <RemoveLocUnitForm unit={{ id: unit.id, label: [label, unit.stockNumber && `stock # ${unit.stockNumber}`].filter(Boolean).join(", ") }} back={back} />
        </Card>
      </div>
    </div>
  );
}
