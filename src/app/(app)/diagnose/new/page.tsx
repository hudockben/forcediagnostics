import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { isClaudeConfigured } from "@/lib/claude";
import { carryOver } from "@/lib/diagnose";
import { SETUP_MESSAGE } from "@/lib/diagnose-rules";
import { libraryFilterOptions } from "@/lib/library";
import { getVehicleChoice } from "@/lib/customers";
import { allows, requireCapability } from "@/lib/session";

import { NewDiagnosisChat } from "../chat";

export const metadata: Metadata = { title: "New diagnosis" };

export default function NewDiagnosisPage(props: PageProps<"/diagnose/new">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NewDiagnosis searchParams={props.searchParams} />
    </Suspense>
  );
}

async function NewDiagnosis({ searchParams }: { searchParams: PageProps<"/diagnose/new">["searchParams"] }) {
  const user = await requireCapability("diagnostics.work");
  // ?from= carries on from a full diagnosis; ?vehicle= starts one on a
  // customer's vehicle (Start a diagnosis on its record).
  const { from, vehicle } = await searchParams;
  if (!isClaudeConfigured) {
    return (
      <div className="space-y-6">
        <PageHeading title="New diagnosis" />
        <Notice tone="trail">{SETUP_MESSAGE}</Notice>
        <Link href="/diagnose" className="text-sm text-glow hover:underline">
          ‹ Diagnose
        </Link>
      </div>
    );
  }
  const [options, carry, customer] = await Promise.all([
    libraryFilterOptions(user.shop.id),
    typeof from === "string" ? carryOver(user, from) : Promise.resolve(null),
    typeof vehicle === "string" ? getVehicleChoice(user.shop.id, vehicle) : Promise.resolve(null),
  ]);

  // The heading is the chat's own: once the first message is sent, the same
  // page becomes the conversation.
  return (
    <NewDiagnosisChat
      starter={{ vehicles: options.vehicles, brands: options.brands, years: options.years, carry, customer }}
      customerLinks={allows(user, "repair_orders.intake")}
      canDelete={allows(user, "diagnostics.delete")}
    />
  );
}
