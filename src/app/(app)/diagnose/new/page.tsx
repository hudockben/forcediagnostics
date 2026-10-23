import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { isClaudeConfigured } from "@/lib/claude";
import { carryOver } from "@/lib/diagnose";
import { SETUP_MESSAGE } from "@/lib/diagnose-rules";
import { libraryFilterOptions } from "@/lib/library";
import { requireCapability } from "@/lib/session";

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
  const { from } = await searchParams;
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
  const [options, carry] = await Promise.all([
    libraryFilterOptions(user.shop.id),
    typeof from === "string" ? carryOver(user, from) : Promise.resolve(null),
  ]);

  // The heading is the chat's own: once the first message is sent, the same
  // page becomes the conversation.
  return <NewDiagnosisChat starter={{ vehicles: options.vehicles, brands: options.brands, years: options.years, carry }} />;
}
