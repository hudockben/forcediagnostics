import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { getCustomer } from "@/lib/customers";
import { requireCapability } from "@/lib/session";

import { VehicleForm } from "../../../forms";

export const metadata: Metadata = { title: "Add vehicle" };

export default function NewVehiclePage(props: PageProps<"/admin/customers/[id]/vehicles/new">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NewVehicle params={props.params} />
    </Suspense>
  );
}

async function NewVehicle({ params }: { params: PageProps<"/admin/customers/[id]/vehicles/new">["params"] }) {
  const user = await requireCapability("repair_orders.intake");
  const { id } = await params;
  const detail = await getCustomer(user.shop.id, id);
  if (!detail) notFound();
  return (
    <div className="max-w-2xl space-y-6">
      <Link href={`/admin/customers/${id}`} className="text-sm break-words text-glow/90 hover:text-glow hover:underline">
        ‹ {detail.customer.name}
      </Link>
      <PageHeading
        title="Add vehicle"
        description={`A vehicle ${detail.customer.name} bought from you, sold or traded in to you, or brings in for service. The model, the model number or the VIN is enough to start.`}
      />
      <Card>
        <VehicleForm customerId={id} />
      </Card>
    </div>
  );
}
