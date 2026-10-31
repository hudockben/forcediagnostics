import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine } from "@/components/app/ui";
import { findSales, unitsByMonth } from "@/lib/nusr";
import { filtersSearch, filtersTitle, parseSaleFilters, saleTotals, shopToday, formatDay } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { PrintButton, WidePage } from "../forms";
import { SalesTable } from "../sales-table";
import { SummaryTables } from "../summary-tables";

export const metadata: Metadata = { title: "NUSR printout" };

export default function PrintPage(props: PageProps<"/nusr/print">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Printout searchParams={props.searchParams} />
    </Suspense>
  );
}

// The NUSR on paper, or as a PDF from the print dialog: what the log's
// filters find, oldest first as the spreadsheet read, landscape, black on
// white, with the totals and the summary after it. On screen it shows as
// the page will print.
async function Printout({ searchParams }: { searchParams: PageProps<"/nusr/print">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const params = await searchParams;
  const thisYear = new Date().getUTCFullYear();
  const filters = parseSaleFilters(params, thisYear);
  const summaryOnly = params.summary === "only";
  const [sales, comparison] = await Promise.all([findSales(user.shop.id, filters, "oldest"), unitsByMonth(user.shop.id)]);
  const title = filtersTitle(filters);
  return (
    <WidePage className="space-y-4">
      {/* The page's size and margins, for this printout only. */}
      <style>{"@page { size: letter landscape; margin: 0.35in; }"}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/nusr${filtersSearch(filters, thisYear)}`} className="text-sm text-glow/90 hover:text-glow hover:underline">
          ‹ NUSR
        </Link>
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted">
          <span>Pick “Save as PDF” as the printer for a PDF.</span>
          <PrintButton />
        </div>
      </div>
      <article className="rounded-lg bg-white p-6 text-black shadow-xl print:rounded-none print:p-0 print:shadow-none" data-nusr-printout>
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 border-b border-neutral-400 pb-2">
          <h1 className="text-[14pt] font-bold">
            NUSR · {title}
          </h1>
          <p className="text-[9pt] text-neutral-700">
            {user.shop.name} · {sales.length.toLocaleString("en-US")} {sales.length === 1 ? "sale" : "sales"} · printed {formatDay(shopToday())}
          </p>
        </header>
        {sales.length === 0 ? (
          <p className="text-[10pt]">No sales in {title}.</p>
        ) : (
          <>
            {!summaryOnly && <SalesTable sales={sales} totals={saleTotals(sales)} columns={params.columns === "all" ? "all" : "key"} variant="print" />}
            <div className={summaryOnly ? "" : "mt-6 break-before-page"}>
              <SummaryTables sales={sales} comparison={comparison} variant="print" />
            </div>
          </>
        )}
      </article>
    </WidePage>
  );
}
