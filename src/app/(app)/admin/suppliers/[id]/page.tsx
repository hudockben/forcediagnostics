import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";
import { getSupplier, listCategories } from "@/lib/suppliers";

import { RemoveSupplierForm, SupplierForm } from "../forms";

export const metadata: Metadata = { title: "Supplier" };

export default function SupplierPage(props: PageProps<"/admin/suppliers/[id]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <SupplierDetail params={props.params} />
    </Suspense>
  );
}

async function SupplierDetail({ params }: { params: PageProps<"/admin/suppliers/[id]">["params"] }) {
  const user = await requireCapability("parts.manage");
  const { id } = await params;
  // Only finds suppliers in the user's own shop.
  const [supplier, categories] = await Promise.all([getSupplier(user.shop.id, id), listCategories(user.shop.id)]);
  if (!supplier) notFound();
  return (
    <div className="max-w-2xl space-y-6">
      <Link href="/admin/suppliers" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Supplier
      </Link>
      <PageHeading title={<span className="break-words">{supplier.supplierName}</span>} description={<span className="font-mono">Supplier ID {supplier.supplierId}</span>} />
      <Card title="Details">
        <SupplierForm supplier={supplier} categories={categories} />
      </Card>
      <Card title="Remove supplier" description="For a supplier added by mistake, or one the shop no longer uses.">
        <RemoveSupplierForm supplier={supplier} />
      </Card>
    </div>
  );
}
