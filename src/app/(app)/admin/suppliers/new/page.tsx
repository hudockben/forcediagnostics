import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";
import { listCategories, suggestSupplierId } from "@/lib/suppliers";

import { SupplierForm } from "../forms";

export const metadata: Metadata = { title: "Add supplier" };

export default function NewSupplierPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NewSupplier />
    </Suspense>
  );
}

async function NewSupplier() {
  const user = await requireCapability("parts.manage");
  const [suggestedId, categories] = await Promise.all([suggestSupplierId(user.shop.id), listCategories(user.shop.id)]);
  return (
    <div className="max-w-2xl space-y-6">
      <Link href="/admin/suppliers" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Supplier
      </Link>
      <PageHeading title="Add supplier" description="A Supplier ID and a Supplier Name are needed; the rest is optional." />
      <Card>
        <SupplierForm suggestedId={suggestedId} categories={categories} />
      </Card>
    </div>
  );
}
