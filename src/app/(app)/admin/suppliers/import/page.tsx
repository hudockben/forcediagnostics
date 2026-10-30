import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";

import { SupplierImport } from "./supplier-import";

export const metadata: Metadata = { title: "Import suppliers" };

export default function ImportSuppliersPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <ImportSuppliers />
    </Suspense>
  );
}

async function ImportSuppliers() {
  await requireCapability("parts.manage");
  return (
    <div className="space-y-6">
      <Link href="/admin/suppliers" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Supplier
      </Link>
      <PageHeading
        title="Import suppliers"
        description="Bring in the supplier list from your dealer or accounting system: a CSV or Excel file, or the rows pasted from a spreadsheet. Suppliers already on file are matched by Supplier ID and updated, so importing the list again only brings in what changed."
      />
      <SupplierImport />
    </div>
  );
}
