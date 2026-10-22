import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { getReadyManual } from "@/lib/library";
import { pdfFileName } from "@/lib/manual-rules";
import { requireCapability } from "@/lib/session";
import { STORAGE_ENV_VARS, isStorageConfigured, r2Storage } from "@/lib/storage";

import { ManualViewer } from "./viewer";

export const metadata: Metadata = { title: "Manual" };

export default function ManualPage(props: PageProps<"/library/[manualId]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Manual params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Manual({
  params,
  searchParams,
}: {
  params: PageProps<"/library/[manualId]">["params"];
  searchParams: PageProps<"/library/[manualId]">["searchParams"];
}) {
  const user = await requireCapability("library.read");
  const [{ manualId }, { page }] = await Promise.all([params, searchParams]);
  // Only finds ready manuals in the user's own shop.
  const manual = await getReadyManual(user.shop.id, manualId);
  if (!manual) notFound();
  const requested = Number(typeof page === "string" ? page : 1);
  const startPage = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), manual.pageCount) : 1;

  return (
    <div className="space-y-4">
      <Link href="/library" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Library
      </Link>
      <PageHeading
        eyebrow={[manual.brand, manual.modelYears].filter(Boolean).join(" · ") || undefined}
        title={manual.title}
      />
      {isStorageConfigured ? (
        <ManualViewer
          // A link to another page of the same manual starts the viewer afresh.
          key={`${manual.id}:${startPage}`}
          manualId={manual.id}
          pageCount={manual.pageCount}
          startPage={startPage}
          initialUrl={await r2Storage.downloadUrl(manual.storageKey, pdfFileName(manual.title))}
        />
      ) : (
        <Notice tone="trail">
          File storage isn&apos;t set up, so manuals can&apos;t be shown. An admin needs to set{" "}
          {STORAGE_ENV_VARS.join(", ")} in Vercel.
        </Notice>
      )}
    </div>
  );
}
