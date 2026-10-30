import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";

import { CustomerForm } from "../forms";

export const metadata: Metadata = { title: "Add customer" };

export default function NewCustomerPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NewCustomer />
    </Suspense>
  );
}

async function NewCustomer() {
  await requireCapability("repair_orders.intake");
  return (
    <div className="max-w-2xl space-y-6">
      <Link href="/admin/customers" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Customers
      </Link>
      <PageHeading
        title="Add customer"
        description="Only the name is needed now; fill in the rest when you have it. Add their vehicles on the next page."
      />
      <Card>
        <CustomerForm />
      </Card>
    </div>
  );
}
