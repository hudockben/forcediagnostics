import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { floorStatus, floorStatusText } from "@/lib/loc-rules";
import { formatDay, formatMoney, shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";
import { getStockUnit, type StockUnit } from "@/lib/unit-list";
import { daysInStock, soldOf, unitName, unitValues } from "@/lib/unit-list-rules";

import { PutOnLocForm, RemoveUnitForm, UnitForm } from "../unit-form";

export const metadata: Metadata = { title: "Unit" };

export default function UnitPage(props: PageProps<"/unit-list/[id]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Unit params={props.params} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

async function Unit({ params }: { params: PageProps<"/unit-list/[id]">["params"] }) {
  const user = await requireCapability("sales.log");
  const { id } = await params;
  // Only finds units in the user's own shop.
  const unit = await getStockUnit(user, id);
  if (!unit) notFound();
  const today = shopToday();
  const sold = soldOf(unit);
  const days = daysInStock(unit, today);
  const name = unitName(unit);

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/unit-list" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Unit List
      </Link>
      <PageHeading
        title={name}
        description={
          <>
            <span className="font-mono tracking-wide text-ink">{unit.vin}</span>
            {" · "}
            {sold ? `Sold ${formatDay(sold.on)}, ${plural(days, "day", "days")} after it was received` : `In stock ${plural(days, "day", "days")}`}
            {". "}
            Added <LocalTime value={unit.createdAt.toISOString()} year />
            {unit.createdBy ? ` by ${unit.createdBy}` : ""}
            {unit.invoiceNumber ? `, from invoice ${unit.invoiceNumber}` : ""}
            {unit.invoiceDate ? ` of ${formatDay(unit.invoiceDate)}` : ""}
            {unit.fileName ? ` (${unit.fileName})` : ""}.
          </>
        }
      />
      {unit.nusrSale && (
        <Notice>
          The NUSR has it sold on {formatDay(unit.nusrSale.soldOn)} to {unit.nusrSale.customerName}
          {unit.nusrSale.salesperson ? ` (${unit.nusrSale.salesperson})` : ""}
          {unit.soldOn ? "." : ", so it's on the list as sold."}{" "}
          <Link href={`/nusr/${unit.nusrSale.id}`} className="underline">
            Open the sale
          </Link>
        </Notice>
      )}
      <LocCard unit={unit} today={today} />
      <Card title="Correct it" description="Its model, VIN, dates and prices; mark it sold (or back in stock) with the Sold date. Every change is kept in the Activity log.">
        <UnitForm id={unit.id} values={unitValues(unit)} today={today} />
      </Card>
      <Card title="Remove" description="For a unit put on the list by mistake. A unit that's sold stays on the list, as sold: give it a Sold date instead.">
        <RemoveUnitForm unit={{ id: unit.id, name }} />
      </Card>
    </div>
  );
}

// Where the unit stands on the LOC tab: floored or the shop's own, its stock
// #, its free floor, and what the LOC has it cost; or, not on the LOC, a
// way to put it there.
function LocCard({ unit, today }: { unit: StockUnit; today: string }) {
  const loc = unit.loc;
  if (!loc) {
    return (
      <Card title="The LOC" description="It isn't on the LOC (not by its VIN, or the stock # its VIN gives). Put it on: floored, as a new unit comes in, or as the shop's own.">
        <PutOnLocForm unit={{ id: unit.id }} />
      </Card>
    );
  }
  const floor = floorStatus(loc.freeFloorEnds, today);
  const live = loc.soldOn === null || loc.onLoc;
  return (
    <Card title="The LOC">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2" data-unit-loc-card>
        <div>
          <dt className="text-xs text-ink-muted">On the LOC or ours</dt>
          <dd className="text-ink">
            {loc.onLoc ? "Floored on the LOC" : `The shop's own${loc.paidOffOn ? `, paid off ${formatDay(loc.paidOffOn)}` : ""}`}
            {loc.soldOn ? `; sold ${formatDay(loc.soldOn)}${loc.onLoc ? ", still owed" : ""}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Stock #</dt>
          <dd className="font-mono text-ink">{loc.stockNumber ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Free floor ends</dt>
          <dd className="text-ink">
            {loc.freeFloorEnds ? formatDay(loc.freeFloorEnds) : "—"}
            {loc.freeFloorEnds && live && (
              <span className={`ml-2 text-xs ${floor.state === "ended" ? "text-trail" : floor.state === "soon" ? "text-glow" : "text-ink-muted"}`}>{floorStatusText(floor)}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Cost on the LOC</dt>
          <dd className="font-mono text-ink">
            {formatMoney(loc.cost)}
            {unit.cost !== null && unit.cost !== loc.cost && <span className="ml-2 font-sans text-xs text-trail">The Unit List has {formatMoney(unit.cost)}</span>}
          </dd>
        </div>
      </dl>
      <Link href={`/loc/${loc.id}`} className="mt-4 inline-block text-sm text-glow hover:underline">
        Open it on the LOC
      </Link>
    </Card>
  );
}
