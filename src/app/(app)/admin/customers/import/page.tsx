import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";

import { CustomerImport } from "./customer-import";

export const metadata: Metadata = { title: "Import customers" };

export default function ImportCustomersPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <ImportCustomers />
    </Suspense>
  );
}

async function ImportCustomers() {
  await requireCapability("repair_orders.intake");
  return (
    <div className="space-y-6">
      <Link href="/admin/customers" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Customers
      </Link>
      <PageHeading
        title="Import customers"
        description="Add customers and their vehicles from a CSV or Excel file: an export from your dealer system or a list kept by hand. You'll see what each column is read as, and what will be added, before anything is saved. Customers already on file aren't added twice."
      />
      <CustomerImport />
    </div>
  );
}
