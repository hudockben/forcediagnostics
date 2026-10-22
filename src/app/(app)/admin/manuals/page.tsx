import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { formatBytes } from "@/lib/manual-rules";
import { listManuals, type ManualSummary } from "@/lib/manuals";
import { requireCapability } from "@/lib/session";
import { STORAGE_ENV_VARS, isStorageConfigured } from "@/lib/storage";

import { ManualUploader } from "./uploader";

export const metadata: Metadata = { title: "Manuals" };

export default function ManualsPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Manuals />
    </Suspense>
  );
}

function plural(count: number, one: string, many: string) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function ManualRow({ manual }: { manual: ManualSummary }) {
  const ready = manual.status === "ready";
  return (
    <li className="space-y-1 px-5 py-3 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {ready ? (
          <Link
            href={`/library/${manual.id}`}
            className="min-w-0 font-medium text-ink hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            {manual.title}
          </Link>
        ) : (
          <p className="min-w-0 font-medium text-ink">{manual.title}</p>
        )}
        {ready ? <Badge tone="glow">Ready</Badge> : <Badge tone="trail">Not finished</Badge>}
      </div>
      <p className="text-xs text-ink-muted">
        {manual.pageCount !== null && `${plural(manual.pageCount, "page", "pages")} · `}
        {formatBytes(manual.sizeBytes)} · added <LocalTime value={manual.createdAt.toISOString()} />
        {manual.uploadedByName && ` by ${manual.uploadedByName}`}
      </p>
      {ready && (manual.pagesWithoutText ?? 0) > 0 && (
        <p className="text-xs text-trail">
          {plural(manual.pagesWithoutText ?? 0, "page", "pages")} not searchable — scanned pages with no text.
          They still show in the viewer.
        </p>
      )}
      {!ready && (
        <p className="text-xs text-trail">
          Not finished yet. If it isn&apos;t being added above, add {manual.fileName} again to finish it.
        </p>
      )}
    </li>
  );
}

async function Manuals() {
  const admin = await requireCapability("settings.manage");
  const manuals = await listManuals(admin.shop.id);
  const ready = manuals.filter((manual) => manual.status === "ready");
  const pages = ready.reduce((total, manual) => total + (manual.pageCount ?? 0), 0);
  const bytes = ready.reduce((total, manual) => total + manual.sizeBytes, 0);

  return (
    <div className="space-y-6">
      <PageHeading
        title="Manuals"
        description={
          <>
            Service and owner manuals for the Library tab, where everyone at {admin.shop.name} can search
            and read them. They&apos;re stored privately for this shop only.
          </>
        }
      />

      {isStorageConfigured ? (
        <Card
          title="Add manuals"
          description="Pick PDFs or a whole folder. Each file is uploaded to the shop's storage and its text is read in this browser, two files at a time. Files already in the library are skipped, so adding the same folder again picks up where it left off."
        >
          <ManualUploader />
        </Card>
      ) : (
        <Notice tone="trail">
          File storage isn&apos;t set up yet, so manuals can&apos;t be added. Set{" "}
          {STORAGE_ENV_VARS.map((name, index) => (
            <span key={name}>
              {index > 0 && (index === STORAGE_ENV_VARS.length - 1 ? " and " : ", ")}
              <span className="font-mono">{name}</span>
            </span>
          ))}{" "}
          in Vercel (see the README), then redeploy.
        </Notice>
      )}

      <Card title="In the library">
        <dl className="grid grid-cols-3 gap-4">
          <div>
            <dt className="text-xs text-ink-muted">Manuals</dt>
            <dd className="mt-1 text-lg font-semibold text-ink">{ready.length.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Pages</dt>
            <dd className="mt-1 text-lg font-semibold text-ink">{pages.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Total size</dt>
            <dd className="mt-1 text-lg font-semibold text-ink">{formatBytes(bytes)}</dd>
          </div>
        </dl>
        {manuals.length === 0 ? (
          <p className="mt-4 text-sm text-ink-muted">No manuals yet.</p>
        ) : (
          <ul className="-mx-5 mt-4 -mb-5 divide-y divide-white/10 border-t border-white/10 sm:-mx-6 sm:-mb-6">
            {manuals.map((manual) => (
              <ManualRow key={manual.id} manual={manual} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
