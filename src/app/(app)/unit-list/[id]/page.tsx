import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { formatDay, shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";
import { getStockUnit } from "@/lib/unit-list";
import { daysInStock, soldOf, unitName, unitValues } from "@/lib/unit-list-rules";

import { RemoveUnitForm, UnitForm } from "../unit-form";

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
      <Card title="Correct it" description="Its model, VIN, dates and prices; mark it sold (or back in stock) with the Sold date. Every change is kept in the Activity log.">
        <UnitForm id={unit.id} values={unitValues(unit)} today={today} />
      </Card>
      <Card title="Remove" description="For a unit put on the list by mistake. A unit that's sold stays on the list, as sold: give it a Sold date instead.">
        <RemoveUnitForm unit={{ id: unit.id, name }} />
      </Card>
    </div>
  );
}
