import type { Metadata } from "next";
import { Suspense } from "react";

import { LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { parsePage } from "@/lib/diagnose-list-rules";
import { saleSuggestions } from "@/lib/nusr";
import { shopYear } from "@/lib/nusr-rules";
import { parseRebateFilters } from "@/lib/rebate-rules";
import { listSavedInvoices, listSavedRebates, openSavedInvoice, savedInvoiceYears } from "@/lib/rebates";
import { requireCapability } from "@/lib/session";

import { WidePage } from "../nusr/forms";
import { ChooseInvoicesButton, Rebates } from "./rebates";
import { SavedRebatesSection } from "./saved";

// The Rebates tab: New invoices at the top: drop Polaris rebate invoices
// (anywhere on the page), see each unit on each found in the NUSR, save
// them, and download the NUSR sheet with the rebates in AO (Holdback), AP
// (Retail Rwds) and AQ (Add'l Hlbk). Under it, Saved rebates, by the
// filters in the address; ?open= puts a saved invoice up top to change.

export const metadata: Metadata = { title: "Rebates" };

export default function RebatesPage(props: PageProps<"/rebates">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <RebatesTab searchParams={props.searchParams} />
    </Suspense>
  );
}

async function RebatesTab({ searchParams }: { searchParams: PageProps<"/rebates">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const params = await searchParams;
  const thisYear = shopYear();
  const filters = parseRebateFilters(params, thisYear);
  const [opened, invoices, saved, years, suggestions] = await Promise.all([
    typeof params.open === "string" ? openSavedInvoice(user, params.open) : Promise.resolve(null),
    listSavedInvoices(user, filters),
    listSavedRebates(user, filters, { page: parsePage(params.page) }),
    savedInvoiceYears(user),
    saleSuggestions(user.shop.id),
  ]);
  // Only a manager or admin gets this far, so neither list says no.
  if ("error" in invoices || "error" in saved) throw new Error("Saved rebates said no to a user allowed to see them");
  return (
    <WidePage className="space-y-6">
      <PageHeading
        title="Rebates"
        description="Polaris's rebate invoices, matched to the NUSR. Drop one anywhere on this page to read and check it."
        action={<ChooseInvoicesButton />}
      />
      {opened && "error" in opened && <Notice tone="trail">{opened.error} It may have been removed.</Notice>}
      <Rebates opened={opened && !("error" in opened) ? opened : null} />
      <SavedRebatesSection
        filters={filters}
        thisYear={thisYear}
        years={years}
        salespeople={suggestions.salespeople}
        categories={suggestions.categories}
        invoices={invoices}
        saved={saved}
        removed={typeof params.removed === "string" ? params.removed.slice(0, 220) : null}
      />
    </WidePage>
  );
}
