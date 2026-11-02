import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";
import { getCustomerChoice, getStickerEntry } from "@/lib/sticker-log";
import { entryLabel } from "@/lib/sticker-log-rules";

import { RemoveStickerForm, StickerForm } from "../forms";

export const metadata: Metadata = { title: "Sticker or plate" };

export default function StickerPage(props: PageProps<"/sticker-plate-log/[id]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Sticker params={props.params} />
    </Suspense>
  );
}

async function Sticker({ params }: { params: PageProps<"/sticker-plate-log/[id]">["params"] }) {
  const user = await requireCapability("repair_orders.intake");
  const { id } = await params;
  // Only finds entries in the user's own shop.
  const entry = await getStickerEntry(user.shop.id, id);
  if (!entry) notFound();
  const customer = (await getCustomerChoice(user.shop.id, entry.customerId)) ?? { id: entry.customerId, name: entry.customerName, detail: null };

  return (
    <div className="max-w-2xl space-y-6">
      <Link href="/sticker-plate-log" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Sticker &amp; Plate log
      </Link>
      <PageHeading
        title={
          <>
            {entryLabel(entry.plateClass)} <span className="font-mono tracking-wide">{entry.stickerNumber}</span>
          </>
        }
        description={
          <>
            Logged <LocalTime value={entry.createdAt.toISOString()} />
            {entry.createdBy ? ` by ${entry.createdBy}` : ""}, for{" "}
            <Link href={`/customers/${entry.customerId}`} className="text-glow/90 hover:text-glow hover:underline">
              {entry.customerName}
            </Link>
            .
          </>
        }
      />
      <Card title="Correct it" description="A wrong number, type or customer. Every change is kept in the audit log.">
        <StickerForm entry={{ id: entry.id, stickerNumber: entry.stickerNumber, plateClass: entry.plateClass, customer }} />
      </Card>
      <Card title="Remove" description="For one logged by mistake.">
        <RemoveStickerForm entry={entry} />
      </Card>
    </div>
  );
}
