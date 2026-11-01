import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";

import { NusrImport } from "./nusr-import";

// NUSR > Import: bringing the shop's NUSR workbook in, so the years of
// sales kept in Excel are in the NUSR tab with the ones logged since.

export const metadata: Metadata = { title: "Import the NUSR workbook" };

export default function ImportNusrPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <ImportNusr />
    </Suspense>
  );
}

async function ImportNusr() {
  await requireCapability("sales.log");
  return (
    <div className="space-y-6">
      <Link href="/nusr" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ NUSR
      </Link>
      <PageHeading
        title="Import the NUSR workbook"
        description="Bring in the sales from the NUSR spreadsheet: a sheet a year, and Trailers. You'll see what each sheet adds, and every cell that was read another way, before anything is saved. The TOTAL rows and comparison tables are left out (the NUSR tab works them out), and a sale already in the NUSR isn't added twice, so importing the workbook again only adds what's new."
      />
      <NusrImport />
    </div>
  );
}
