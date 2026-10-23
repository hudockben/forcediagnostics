import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { LoadingLine, Notice } from "@/components/app/ui";
import { isClaudeConfigured } from "@/lib/claude";
import { getConversation } from "@/lib/diagnose";
import { SETUP_MESSAGE } from "@/lib/diagnose-rules";
import { requireCapability } from "@/lib/session";

import { DiagnoseChat } from "../chat";

export const metadata: Metadata = { title: "Diagnosis" };

export default function DiagnosisPage(props: PageProps<"/diagnose/[id]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Diagnosis params={props.params} />
    </Suspense>
  );
}

async function Diagnosis({ params }: { params: PageProps<"/diagnose/[id]">["params"] }) {
  const user = await requireCapability("diagnostics.work");
  const { id } = await params;
  // Only finds the shop's own; a message whose server died is marked failed
  // on the way, so it shows Retry instead of a spinner.
  const detail = await getConversation(user, id);
  if (!detail) notFound();
  return (
    <div className="space-y-4">
      {!isClaudeConfigured && <Notice tone="trail">{SETUP_MESSAGE}</Notice>}
      <DiagnoseChat key={detail.conversation.id} initial={detail} starter={null} />
    </div>
  );
}
