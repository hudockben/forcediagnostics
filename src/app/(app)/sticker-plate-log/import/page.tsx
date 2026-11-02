import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";

import { StickerImport } from "./sticker-import";

export const metadata: Metadata = { title: "Import stickers" };

export default function ImportStickersPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <ImportStickers />
    </Suspense>
  );
}

async function ImportStickers() {
  await requireCapability("repair_orders.intake");
  return (
    <div className="space-y-6">
      <Link href="/sticker-plate-log" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Sticker &amp; Plate log
      </Link>
      <PageHeading
        title="Import stickers"
        description="Bring in a sticker log kept in a spreadsheet: a CSV or Excel file, or the rows pasted from one. Stickers already in the log are left as they are, so importing the same file again adds nothing new."
      />
      <StickerImport />
    </div>
  );
}
