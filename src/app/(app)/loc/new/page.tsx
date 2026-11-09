import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { locSuggestions } from "@/lib/loc";
import { locBack } from "@/lib/loc-rules";
import { shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { LocUnitForm } from "../forms";

export const metadata: Metadata = { title: "Add a unit to the LOC" };

export default function NewLocUnitPage(props: PageProps<"/loc/new">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NewLocUnit searchParams={props.searchParams} />
    </Suspense>
  );
}

// A unit that's come in: today, new, on the LOC.
async function NewLocUnit({ searchParams }: { searchParams: PageProps<"/loc/new">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const back = locBack((await searchParams).back);
  const suggestions = await locSuggestions(user.shop.id);
  return (
    <div className="space-y-6">
      <div>
        <Link href={`/loc${back}`} className="text-sm text-glow/90 hover:text-glow hover:underline">
          ‹ LOC
        </Link>
        <PageHeading
          title="Add a unit"
          description="A unit that's come in goes on the LOC as it's floored. Type its VIN and the rest of what the app knows fills itself in; Add and start another keeps the day it came in and its free floor for the rest of the delivery."
        />
      </div>
      <LocUnitForm unit={null} today={shopToday()} models={suggestions.models} categories={suggestions.categories} back={back} />
    </div>
  );
}
