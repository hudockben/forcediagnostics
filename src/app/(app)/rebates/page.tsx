import type { Metadata } from "next";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";

import { WidePage } from "../nusr/forms";
import { Rebates } from "./rebates";

// The Rebates tab: drop a Polaris rebate invoice, see each unit on it found
// in the NUSR, and download the NUSR sheet with the rebates in AO
// (Holdback), AP (Retail Rwds) and AQ (Add'l Hlbk).

export const metadata: Metadata = { title: "Rebates" };

export default function RebatesPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <RebatesTab />
    </Suspense>
  );
}

async function RebatesTab() {
  await requireCapability("sales.log");
  return (
    <WidePage className="space-y-6">
      <PageHeading
        title="Rebates"
        description="Drop a Polaris rebate invoice: the PDF from the dealer portal, or a scan or photo of the printout. Each unit's VIN, customer, unit price and amount are read from it and the unit is found in the NUSR, then Download Excel gives the NUSR sheet with the rebates in AO (Holdback), AP (Retail Rwds) and AQ (Add'l Hlbk). The invoice is read in this browser; nothing is saved."
      />
      <Rebates />
    </WidePage>
  );
}
