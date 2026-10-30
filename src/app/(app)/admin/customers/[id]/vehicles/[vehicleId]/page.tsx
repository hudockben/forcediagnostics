import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { RELATION_LABELS, formatDay } from "@/lib/customer-rules";
import { getVehicle } from "@/lib/customers";
import { allows, requireCapability } from "@/lib/session";
import { VIN_CHECK_DIGIT_WARNING, checkVin } from "@/lib/vin";

import { RemoveVehicleForm, VehicleForm } from "../../../forms";
import { DiagnosisHistory, RelationBadge } from "../../../history";

export const metadata: Metadata = { title: "Vehicle" };

type Props = PageProps<"/admin/customers/[id]/vehicles/[vehicleId]">;

export default function VehiclePage(props: Props) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Vehicle params={props.params} />
    </Suspense>
  );
}

async function Vehicle({ params }: { params: Props["params"] }) {
  const user = await requireCapability("repair_orders.intake");
  const { id, vehicleId } = await params;
  // Only finds a vehicle of this customer, in the user's own shop.
  const detail = await getVehicle(user.shop.id, id, vehicleId);
  if (!detail) notFound();
  const { customer, vehicle, sameVin } = detail;
  const canDiagnose = allows(user, "diagnostics.work");
  const vinCheck = vehicle.vin ? checkVin(vehicle.vin) : null;

  return (
    <div className="max-w-3xl space-y-6">
      <Link href={`/admin/customers/${customer.id}`} className="text-sm break-words text-glow/90 hover:text-glow hover:underline">
        ‹ {customer.name}
      </Link>
      <PageHeading
        title={<span className="break-words">{vehicle.label}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <RelationBadge relation={vehicle.relation} date={vehicle.relationDate} />
            {vehicle.vin && <span className="font-mono tracking-wide break-all text-ink">{vehicle.vin}</span>}
          </span>
        }
        action={
          canDiagnose ? (
            <Link href={`/diagnose/new?vehicle=${vehicle.id}`} className={primaryLinkClass}>
              Start a diagnosis
            </Link>
          ) : undefined
        }
      />

      {vinCheck?.status === "ok" && !vinCheck.checkDigitOk && (
        <p className="rounded-lg border border-trail/30 bg-trail/10 px-4 py-3 text-sm text-trail">{VIN_CHECK_DIGIT_WARNING}</p>
      )}

      <Card
        title="Diagnoses"
        description={
          vehicle.diagnoses.length > 0
            ? `Every diagnosis of this ${vehicle.label}, newest first, with the fix once the tech confirmed it.`
            : undefined
        }
      >
        <DiagnosisHistory diagnoses={vehicle.diagnoses} canOpen={canDiagnose} />
      </Card>

      {sameVin.length > 0 && (
        <Card title="Same VIN on other records" description="The same vehicle on another customer's record: traded in by one, bought by the next.">
          <ul className="space-y-1 text-sm">
            {sameVin.map((other) => (
              <li key={other.vehicleId}>
                <Link
                  href={`/admin/customers/${other.customerId}/vehicles/${other.vehicleId}`}
                  className="text-glow/90 hover:text-glow hover:underline"
                >
                  {other.customerName}
                </Link>
                <span className="text-ink-muted">
                  {" "}
                  · {RELATION_LABELS[other.relation]}
                  {other.relationDate && other.relation !== "owned" ? ` ${formatDay(other.relationDate)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Details">
        <VehicleForm customerId={customer.id} vehicle={vehicle} />
      </Card>

      <Card
        title="Remove vehicle"
        description="For a vehicle added by mistake. One with diagnoses stays on the record; if they've sold it to you, change it to Sold to us instead."
      >
        <RemoveVehicleForm customerId={customer.id} vehicle={vehicle} />
      </Card>
    </div>
  );
}
