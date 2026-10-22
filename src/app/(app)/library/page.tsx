import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { inputBaseClass, primaryLinkClass } from "@/components/hud";
import {
  MAX_QUERY_LENGTH,
  SEARCH_LIMIT,
  cleanSearchQuery,
  listReadyManuals,
  searchManuals,
} from "@/lib/library";
import { allows, requireCapability } from "@/lib/session";

export const metadata: Metadata = { title: "Library" };

export default function LibraryPage(props: PageProps<"/library">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Library searchParams={props.searchParams} />
    </Suspense>
  );
}

const viewerHref = (manualId: string, page: number) => `/library/${manualId}?page=${page}`;

async function Library({ searchParams }: { searchParams: PageProps<"/library">["searchParams"] }) {
  const user = await requireCapability("library.read");
  const { q } = await searchParams;
  const query = cleanSearchQuery(typeof q === "string" ? q : "");

  return (
    <div className="space-y-6">
      <PageHeading
        title="Library"
        description="Search every page of the shop's service and owner manuals: fault codes, part numbers, procedures. Put a phrase in quotes to match it exactly."
      />

      <Form action="/library" className="flex flex-col gap-3 sm:flex-row" role="search">
        <label htmlFor="library-q" className="sr-only">
          Search the manuals
        </label>
        <input
          // Next keeps this page mounted when only the query changes (the
          // Library tab, Back), so a new key makes the box show the new one.
          key={query}
          id="library-q"
          name="q"
          type="search"
          defaultValue={query}
          maxLength={MAX_QUERY_LENGTH}
          placeholder='P0300, 2205123, "fuel pump relay"'
          autoComplete="off"
          enterKeyHint="search"
          className={inputBaseClass}
        />
        <button type="submit" className={`${primaryLinkClass} shrink-0`}>
          Search
        </button>
      </Form>

      {query ? (
        <Results shopId={user.shop.id} query={query} />
      ) : (
        <AllManuals shopId={user.shop.id} canAdd={allows(user, "settings.manage")} />
      )}
    </div>
  );
}

async function Results({ shopId, query }: { shopId: string; query: string }) {
  const hits = await searchManuals(shopId, query);
  if (hits.length === 0) {
    return (
      <Card>
        <p className="text-sm leading-6 text-ink-muted">
          Nothing matched <span className="text-ink">{query}</span>. Try fewer words, another spelling, or
          the part number without dashes.
        </p>
      </Card>
    );
  }
  return (
    <section aria-label="Search results" className="space-y-3">
      <p className="text-sm text-ink-muted">
        {hits.length === SEARCH_LIMIT
          ? `Top ${SEARCH_LIMIT} pages for `
          : `${hits.length} ${hits.length === 1 ? "page matches" : "pages match"} `}
        <span className="text-ink">{query}</span>, best matches first.
      </p>
      <ol className="space-y-3">
        {hits.map((hit) => (
          <li key={`${hit.manualId}-${hit.pageNumber}`}>
            <Link
              href={viewerHref(hit.manualId, hit.pageNumber)}
              className="block rounded-xl border border-white/10 bg-charcoal-900/70 p-4 transition hover:border-glow/30 hover:bg-charcoal-800/70 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none sm:p-5"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium text-ink">{hit.title}</span>
                <span className="font-mono text-xs text-glow/80">
                  Page {hit.pageNumber} of {hit.pageCount}
                </span>
              </span>
              <span className="mt-2 block text-sm leading-6 text-ink-muted">
                {hit.snippet.map((part, index) =>
                  part.match ? (
                    <mark key={index} className="rounded-sm bg-trail/20 px-0.5 text-trail">
                      {part.text}
                    </mark>
                  ) : (
                    <span key={index}>{part.text}</span>
                  ),
                )}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

async function AllManuals({ shopId, canAdd }: { shopId: string; canAdd: boolean }) {
  const manuals = await listReadyManuals(shopId);
  if (manuals.length === 0) {
    return (
      <Card title="No manuals yet">
        <p className="text-sm leading-6 text-ink-muted">
          {canAdd ? (
            <>
              Add the shop&apos;s PDFs under{" "}
              <Link href="/admin/manuals" className="text-glow hover:underline">
                System Admin → Manuals
              </Link>
              .
            </>
          ) : (
            "An admin adds them under System Admin → Manuals."
          )}
        </p>
      </Card>
    );
  }
  return (
    <Card title={`${manuals.length.toLocaleString("en-US")} ${manuals.length === 1 ? "manual" : "manuals"}`}>
      <ul className="-mx-5 -mb-5 divide-y divide-white/10 border-t border-white/10 sm:-mx-6 sm:-mb-6">
        {manuals.map((manual) => (
          <li key={manual.id}>
            <Link
              href={viewerHref(manual.id, 1)}
              className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 transition hover:bg-white/[0.03] focus-visible:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-glow/60 focus-visible:outline-none focus-visible:ring-inset sm:px-6"
            >
              <span className="font-medium text-ink">{manual.title}</span>
              <span className="text-xs text-ink-muted">
                {manual.pageCount.toLocaleString("en-US")} {manual.pageCount === 1 ? "page" : "pages"}
                {manual.pagesWithoutText > 0 && ` · ${manual.pagesWithoutText} not searchable`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
