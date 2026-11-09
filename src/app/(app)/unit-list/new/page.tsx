import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { UnitForm } from "../unit-form";

export const metadata: Metadata = { title: "Add a unit" };

// A unit typed in by hand: one that came without a Polaris invoice to drop
// (a trailer, another make), or was in stock before the list.
export default function NewUnitPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NewUnit />
    </Suspense>
  );
}

async function NewUnit() {
  await requireCapability("sales.log");
  const today = shopToday();
  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/unit-list" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Unit List
      </Link>
      <PageHeading
        title="Add a unit"
        description={
          <>
            For a unit with no Polaris invoice to drop, or one in stock before the list. A whole goods invoice fills this in itself: drop it on the{" "}
            <Link href="/unit-list" className="text-glow hover:underline">
              Unit List
            </Link>
            .
          </>
        }
      />
      <Card>
        <UnitForm
          today={today}
          values={{ vin: "", unitYear: "", model: "", modelNumber: "", description: "", engineNumber: "", receivedOn: today, cost: "", listPrice: "", soldOn: "", notes: "" }}
        />
      </Card>
    </div>
  );
}
