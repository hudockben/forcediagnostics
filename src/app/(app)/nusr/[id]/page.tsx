import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { LocalTime } from "@/components/app/local-time";
import { tradeInsForSale } from "@/lib/loc";
import { locUnitLabel } from "@/lib/loc-rules";
import { getSale, saleSuggestions } from "@/lib/nusr";
import { DEFAULT_BONUS_RATE_BP, DEFAULT_HOLDBACK_RATE_BP, formatDay, logSearch, saleValues, shopToday, shopYear, unitLabel } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";
import { getCustomerChoice } from "@/lib/sticker-log";

import { RemoveSaleForm, SaleForm, SavedNotice, WidePage } from "../forms";

export const metadata: Metadata = { title: "Sale" };

export default function SalePage(props: PageProps<"/nusr/[id]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <SaleScreen params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

// One sale, to correct or remove; back is the log it was opened from.
async function SaleScreen({ params, searchParams }: { params: PageProps<"/nusr/[id]">["params"]; searchParams: PageProps<"/nusr/[id]">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const { id } = await params;
  const query = await searchParams;
  const back = logSearch(query.back, shopYear());
  const sale = await getSale(user.shop.id, id);
  if (!sale) notFound();
  const [suggestions, customer, tradeIns] = await Promise.all([
    saleSuggestions(user.shop.id),
    sale.customerId ? getCustomerChoice(user.shop.id, sale.customerId) : Promise.resolve(null),
    tradeInsForSale(user.shop.id, sale.id),
  ]);
  const label = `${unitLabel(sale)} to ${sale.customerName}`;
  return (
    <WidePage className="space-y-6">
      <div>
        <Link href={`/nusr${back}`} className="text-sm text-glow/90 hover:text-glow hover:underline">
          ‹ NUSR
        </Link>
        <PageHeading
          title={label}
          description={
            <>
              Sold {formatDay(sale.soldOn)}
              {sale.salesperson ? ` by ${sale.salesperson}` : ""}. Logged
              {sale.createdBy ? ` by ${sale.createdBy}` : ""} <LocalTime value={sale.createdAt.toISOString()} year />
              {sale.customerId && (
                <>
                  {" · "}
                  <Link href={`/customers/${sale.customerId}`} className="text-glow/90 hover:text-glow hover:underline">
                    Their customer record
                  </Link>
                </>
              )}
            </>
          }
        />
      </div>
      {/* A new one for each save, so a save after a problem says so again. */}
      {query.saved === "1" && <SavedNotice key={`saved-${sale.updatedAt.toISOString()}`} />}
      <SaleForm
        // Next keeps a visited page alive: a sale saved since is shown fresh.
        key={sale.updatedAt.toISOString()}
        sale={{ id: sale.id, values: saleValues(sale), customer }}
        back={back}
        tradeIns={tradeIns.map((unit) => ({ id: unit.id, label: locUnitLabel(unit), stockNumber: unit.stockNumber, cost: unit.cost }))}
        defaults={{ soldOn: shopToday(), holdbackRateBp: DEFAULT_HOLDBACK_RATE_BP, bonusRateBp: DEFAULT_BONUS_RATE_BP }}
        suggestions={{
          salespeople: suggestions.salespeople,
          financeCompanies: suggestions.financeCompanies,
          categories: suggestions.categories,
          models: suggestions.models,
          comsNumbers: suggestions.comsNumbers,
        }}
      />
      <div className="max-w-md">
        <Card title="Remove">
          <RemoveSaleForm sale={{ id: sale.id, label }} back={back} />
        </Card>
      </div>
    </WidePage>
  );
}
