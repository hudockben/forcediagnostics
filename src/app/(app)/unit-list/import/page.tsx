import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { UnitImport } from "./unit-import";

export const metadata: Metadata = { title: "Import the Unit List" };

export default function ImportUnitsPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <ImportUnits />
    </Suspense>
  );
}

async function ImportUnits() {
  await requireCapability("sales.log");
  return (
    <div className="space-y-6">
      <Link href="/unit-list" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Unit List
      </Link>
      <PageHeading
        title="Import the Unit List"
        description="Bring in the units kept on a spreadsheet, a row a unit: Model, VIN, Received, Cost and List. Online $, Tax and Total are left out. A unit already on the list (by its VIN) is left as it is, so importing the sheet again adds nothing new."
      />
      <UnitImport today={shopToday()} />
    </div>
  );
}
