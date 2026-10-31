import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { findSales, unitsByMonth } from "@/lib/nusr";
import { filtersSearch, filtersTitle, parseSaleFilters } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { WidePage } from "../forms";
import { SummaryTables } from "../summary-tables";

export const metadata: Metadata = { title: "NUSR summary" };

export default function SummaryPage(props: PageProps<"/nusr/summary">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Summary searchParams={props.searchParams} />
    </Suspense>
  );
}

const linkButton =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

// The totals of what the log's filters find, every way the spreadsheet
// added them up, and the units of every year month by month.
async function Summary({ searchParams }: { searchParams: PageProps<"/nusr/summary">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const thisYear = new Date().getUTCFullYear();
  const filters = parseSaleFilters(await searchParams, thisYear);
  const [sales, comparison] = await Promise.all([findSales(user.shop.id, filters, "oldest"), unitsByMonth(user.shop.id)]);
  const search = filtersSearch(filters, thisYear);
  return (
    <WidePage className="space-y-6">
      <div>
        <Link href={`/nusr${search}`} className="text-sm text-glow/90 hover:text-glow hover:underline">
          ‹ NUSR
        </Link>
        <PageHeading
          title={`Summary: ${filtersTitle(filters)}`}
          description="The totals and averages the spreadsheet's summary rows had, worked out from every sale, so they're never stale."
          action={
            <div className="flex flex-wrap gap-3">
              <a href={`/nusr/export${search}`} className={linkButton}>
                Download Excel
              </a>
              <Link href={`/nusr/print${search}${search ? "&" : "?"}summary=only`} className={linkButton}>
                Print or PDF
              </Link>
            </div>
          }
        />
      </div>
      <Card>
        {sales.length === 0 ? (
          <p className="text-sm text-ink-muted">No sales in {filtersTitle(filters)}.</p>
        ) : (
          <SummaryTables sales={sales} comparison={comparison} variant="screen" />
        )}
      </Card>
    </WidePage>
  );
}
