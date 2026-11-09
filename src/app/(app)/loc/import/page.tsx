import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";

import { LocImport } from "./loc-import";

export const metadata: Metadata = { title: "Import onto the LOC" };

export default function ImportLocPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <ImportLoc />
    </Suspense>
  );
}

async function ImportLoc() {
  await requireCapability("sales.log");
  return (
    <div className="space-y-6">
      <Link href="/loc" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ LOC
      </Link>
      <PageHeading
        title="Import onto the LOC"
        description="Bring in the LOC sheet as you keep it: the units under WE OWN come in as ours, and from “here down we owe on LOC” as on the LOC. The lender's list of what's on the line comes in the same way. A unit whose stock # is on the LOC already is left as it is, so the next list adds only the units that are new."
      />
      <LocImport />
    </div>
  );
}
