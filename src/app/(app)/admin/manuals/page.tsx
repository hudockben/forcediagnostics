import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { catalogSummary, type CatalogSummary } from "@/lib/manual-catalog";
import { brandLabel, compareBrands } from "@/lib/manual-catalog-rules";
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

// Brands, model years and models from the model list, under any of the
// manual's names ("Ranger · 2019-2022 · 17 models"), or that it isn't in it.
function ModelListLine({ manual }: { manual: ManualSummary }) {
  if (!manual.inList) return <p className="text-xs text-trail">Not in the model list</p>;
  const brands = [...manual.brands]
    .sort(compareBrands)
    .map((code) =>
      manual.inferredBrands.includes(code) ? `${brandLabel(code)} (filled in from its models)` : brandLabel(code),
    )
    .join(", ");
  const parts = [brands, manual.modelYears, plural(manual.models, "model", "models")].filter(Boolean);
  return <p className="text-xs text-ink">{parts.join(" · ")}</p>;
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
      <ModelListLine manual={manual} />
      <p className="text-xs text-ink-muted">
        {manual.fileName} · {manual.pageCount !== null && `${plural(manual.pageCount, "page", "pages")} · `}
        {formatBytes(manual.sizeBytes)} · added <LocalTime value={manual.createdAt.toISOString()} />
        {manual.uploadedByName && ` by ${manual.uploadedByName}`}
      </p>
      {manual.otherNames.length > 0 && (
        <p className="text-xs break-words text-ink-muted">Also named {manual.otherNames.join(", ")}</p>
      )}
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-ink">{value.toLocaleString("en-US")}</dd>
    </div>
  );
}

// A count with its list folded away underneath.
function Mismatches({ summary, items }: { summary: string; items: { key: string; label: string; detail?: string | null }[] }) {
  if (items.length === 0) return null;
  return (
    <details className="group rounded-lg border border-white/10">
      <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm text-trail focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none">
        {summary}
        <span className="text-xs text-ink-muted group-open:hidden">Show</span>
        <span className="hidden text-xs text-ink-muted group-open:inline">Hide</span>
      </summary>
      <ul className="max-h-72 divide-y divide-white/10 overflow-y-auto border-t border-white/10">
        {items.map((item) => (
          <li key={item.key} className="px-4 py-2 text-sm">
            <p className="break-words text-ink">{item.label}</p>
            {item.detail && <p className="text-xs break-words text-ink-muted">{item.detail}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ModelListCard({ summary }: { summary: CatalogSummary }) {
  const notListed = summary.notListed.length;
  const missing = summary.missingPdfs.length;
  return (
    <Card
      title="Model list"
      description="Polaris's spreadsheet of which models each manual covers (the .csv saved with the downloads). Add it above, in the folder or on its own: it tags each manual with its brand, model years and model numbers, matched by file name, so the Library can filter by them. A PDF it lists under several names is matched under each name it was added as. Adding it again replaces what it says about the same files."
    >
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Manuals added" value={summary.manuals} />
        <Stat label="In the model list" value={summary.entries} />
        <Stat label="Models listed" value={summary.models} />
        <div>
          <dt className="text-xs text-ink-muted">Last imported</dt>
          <dd className="mt-1 text-sm text-ink">
            {summary.lastImportedAt ? <LocalTime value={summary.lastImportedAt.toISOString()} /> : "Never"}
          </dd>
        </div>
      </dl>
      {summary.entries === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">No model list yet, so the Library can&apos;t filter manuals.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {notListed === 0 && missing === 0 && (
            <p className="text-sm text-glow">Every manual is in the model list, and every entry has its PDF.</p>
          )}
          <Mismatches
            summary={`${plural(notListed, "manual isn't", "manuals aren't")} in the model list`}
            items={summary.notListed.map((manual) => ({ key: manual.id, label: manual.fileName, detail: manual.title }))}
          />
          <Mismatches
            summary={`${plural(missing, "model-list entry has", "model-list entries have")} no PDF added yet`}
            items={summary.missingPdfs.map((entry) => ({
              key: entry.fileName,
              label: entry.fileName,
              detail: entry.title,
            }))}
          />
        </div>
      )}
    </Card>
  );
}

async function Manuals() {
  const admin = await requireCapability("settings.manage");
  const [manuals, summary] = await Promise.all([listManuals(admin.shop.id), catalogSummary(admin.shop.id)]);
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
          description="Pick PDFs or a whole folder. Each file is uploaded to the shop's storage and its text is read in this browser, two files at a time. Files already in the library are skipped, so adding the same folder again picks up where it left off, and a copy of one under another name is linked to it instead of stored twice. A model list (.csv) among them is imported first."
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

      <ModelListCard summary={summary} />

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
