import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { addressLines } from "@/lib/customer-rules";
import { getCustomer, type VehicleRecord } from "@/lib/customers";
import { allows, requireCapability } from "@/lib/session";

import { CustomerForm, RemoveCustomerForm } from "../forms";
import { DiagnosisHistory, RelationBadge } from "../history";

export const metadata: Metadata = { title: "Customer" };

export default function CustomerPage(props: PageProps<"/admin/customers/[id]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Customer params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

const linkClass = "text-glow/90 hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";
const smallLinkClass =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-3 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

const NOTICES: Record<string, string> = {
  customer: "Customer added. Add the vehicles they've bought, sold or brought in below.",
  vehicle: "Vehicle added.",
};

async function Customer({
  params,
  searchParams,
}: {
  params: PageProps<"/admin/customers/[id]">["params"];
  searchParams: PageProps<"/admin/customers/[id]">["searchParams"];
}) {
  const user = await requireCapability("repair_orders.intake");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  // Only finds customers in the user's own shop.
  const detail = await getCustomer(user.shop.id, id);
  if (!detail) notFound();
  const { customer, vehicles } = detail;
  const canDiagnose = allows(user, "diagnostics.work");
  const address = addressLines(customer);
  const added = typeof query.added === "string" ? NOTICES[query.added] : undefined;

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/admin/customers" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Customers
      </Link>
      <PageHeading
        title={<span className="break-words">{customer.name}</span>}
        description={
          <span className="block space-y-0.5" data-contact>
            {(customer.phone || customer.email) && (
              <span className="flex flex-wrap gap-x-4 gap-y-0.5">
                {customer.phone && (
                  <a href={`tel:${customer.phone.replace(/[^\d+x]/g, "").replace("x", ",")}`} className={linkClass}>
                    {customer.phone}
                  </a>
                )}
                {customer.email && (
                  <a href={`mailto:${customer.email}`} className={`${linkClass} break-all`}>
                    {customer.email}
                  </a>
                )}
              </span>
            )}
            {address.map((addressLine) => (
              <span key={addressLine} className="block">
                {addressLine}
              </span>
            ))}
            {!customer.phone && !customer.email && address.length === 0 && <span>No contact details yet.</span>}
          </span>
        }
      />

      {added && <Notice>{added}</Notice>}
      {query.removed === "vehicle" && <Notice>Vehicle removed.</Notice>}

      <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" aria-labelledby="vehicles-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="vehicles-heading" className="text-base font-semibold text-ink">
            Vehicles{vehicles.length > 0 && <span className="ml-2 font-mono text-sm font-normal text-ink-muted">{vehicles.length}</span>}
          </h2>
          <Link href={`/admin/customers/${customer.id}/vehicles/new`} className={smallLinkClass}>
            Add vehicle
          </Link>
        </div>
        {vehicles.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-ink-muted">
            None yet. Add the ones they&apos;ve bought from you, sold or traded in to you, or bring in for service.
          </p>
        ) : (
          <ul className="mt-4 space-y-6">
            {vehicles.map((vehicle) => (
              <VehicleBlock key={vehicle.id} customerId={customer.id} vehicle={vehicle} canDiagnose={canDiagnose} />
            ))}
          </ul>
        )}
      </section>

      <Card title="Details">
        <CustomerForm customer={customer} />
      </Card>

      <Card
        title="Remove customer"
        description="For a record added by mistake. A customer whose vehicles have diagnoses stays: those are the shop's records."
      >
        <RemoveCustomerForm customer={customer} />
      </Card>
    </div>
  );
}

function VehicleBlock({ customerId, vehicle, canDiagnose }: { customerId: string; vehicle: VehicleRecord; canDiagnose: boolean }) {
  const href = `/admin/customers/${customerId}/vehicles/${vehicle.id}`;
  const facts = [
    vehicle.modelNumber && { label: "Model number", value: vehicle.modelNumber, mono: true },
    vehicle.vin && { label: "VIN", value: vehicle.vin, mono: true },
    vehicle.color && { label: "Color", value: vehicle.color, mono: false },
  ].filter((fact): fact is { label: string; value: string; mono: boolean } => Boolean(fact));
  return (
    <li className="space-y-3 border-t border-white/10 pt-5 first:border-t-0 first:pt-0" data-vehicle={vehicle.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <Link href={href} className="font-medium break-words text-ink hover:text-glow hover:underline">
              {vehicle.label}
            </Link>
            <RelationBadge relation={vehicle.relation} date={vehicle.relationDate} />
          </p>
          {facts.length > 0 && (
            <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
              {facts.map((fact) => (
                <div key={fact.label} className="flex items-baseline gap-1.5">
                  <dt className="text-xs text-ink-muted">{fact.label}</dt>
                  <dd className={`break-all text-ink ${fact.mono ? "font-mono tracking-wide" : ""}`}>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canDiagnose && (
            <Link href={`/diagnose/new?vehicle=${vehicle.id}`} className={smallLinkClass}>
              Start a diagnosis
            </Link>
          )}
          <Link
            href={href}
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-ink-muted transition hover:bg-white/5 hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            Edit
          </Link>
        </div>
      </div>
      <DiagnosisHistory diagnoses={vehicle.diagnoses} canOpen={canDiagnose} />
    </li>
  );
}
