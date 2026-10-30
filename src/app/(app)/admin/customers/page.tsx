import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { listCustomers, type CustomerList, type CustomerSummary } from "@/lib/customers";
import { MAX_LIST_WORDS, cleanListQuery, listHref, listSearchIsCut, listSearchWords, parsePage } from "@/lib/diagnose-list-rules";
import { requireCapability } from "@/lib/session";

import { ListSearch } from "../../diagnose/list-search";
import { Pagination } from "../../diagnose/pagination";

export const metadata: Metadata = { title: "Customers" };

const PATH = "/admin/customers";

export default function CustomersPage(props: PageProps<"/admin/customers">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Customers searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

async function Customers({ searchParams }: { searchParams: PageProps<"/admin/customers">["searchParams"] }) {
  const user = await requireCapability("repair_orders.intake");
  const params = await searchParams;
  const query = cleanListQuery(typeof params.q === "string" ? params.q : "");
  const list = await listCustomers(user.shop.id, { query, page: parsePage(params.page) });
  // A search with no words in it ("—") lists everything, so it says nothing.
  const searching = listSearchWords(query).length > 0;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Customers"
        description="Everyone the dealership sells to, buys from or services: how to reach them, the vehicles they've bought and sold, and each vehicle's diagnoses and fixes."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/customers/import"
              className="inline-flex h-12 items-center rounded-lg border border-glow/30 px-5 text-base font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Import
            </Link>
            <Link href="/admin/customers/new" className={primaryLinkClass}>
              Add customer
            </Link>
          </div>
        }
      />

      {params.removed === "1" && <Notice>Customer removed.</Notice>}

      <Card>
        {list.total === 0 && !searching ? (
          <p className="text-sm leading-6 text-ink-muted">
            No customers yet. Add the first with Add customer, or{" "}
            <Link href="/admin/customers/import" className="text-glow hover:underline">
              import a list
            </Link>{" "}
            from a CSV or Excel file.
          </p>
        ) : (
          <ListSearch query={query} path={PATH} label="Search customers" placeholder="Name, phone, email, town, model or VIN">
            <Results list={list} query={query} searching={searching} />
          </ListSearch>
        )}
      </Card>
    </div>
  );
}

// The search as typed; past MAX_LIST_WORDS words, saying the rest were
// left out.
const quote = (query: string) =>
  `“${query}”${listSearchIsCut(query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : ""}`;

function Results({ list, query, searching }: { list: CustomerList; query: string; searching: boolean }) {
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted empty:hidden">
        {searching
          ? list.total === 0
            ? `Nothing matched ${quote(query)}.`
            : `${plural(list.total, "customer matches", "customers match")} ${quote(query)}.`
          : ""}
      </p>
      {list.total === 0 ? (
        <p className="mt-2 text-sm leading-6 text-ink-muted" data-list-empty>
          Try fewer words or another spelling, or{" "}
          <Link
            href={listHref("", 1, PATH)}
            className="text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            clear the search
          </Link>
          .
        </p>
      ) : (
        <>
          <ul className="-mx-5 mt-4 divide-y divide-white/10 border-y border-white/10 sm:-mx-6">
            {list.items.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <p className="font-mono text-xs text-ink-muted" data-list-range>
              {list.from.toLocaleString("en-US")}–{list.to.toLocaleString("en-US")} of {list.total.toLocaleString("en-US")}
            </p>
            <Pagination query={query} page={list.page} pages={list.pages} label="Pages of customers" path={PATH} />
          </div>
        </>
      )}
    </>
  );
}

function CustomerRow({ customer }: { customer: CustomerSummary }) {
  const place = [customer.city, customer.state].filter(Boolean).join(", ");
  const { bought, sold, owned } = customer.vehicles;
  return (
    <li data-customer-row>
      <Link
        href={`/admin/customers/${customer.id}`}
        className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 transition hover:bg-white/[0.03] focus-visible:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-glow/60 focus-visible:outline-none focus-visible:ring-inset sm:px-6"
      >
        <span className="min-w-0">
          <span className="block font-medium break-words text-ink">{customer.name}</span>
          <span className="block text-sm break-words text-ink-muted">
            {[customer.phone, customer.email, place].filter(Boolean).join(" · ") || "No contact details yet"}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {bought > 0 && <Badge tone="glow">{bought} bought</Badge>}
          {sold > 0 && <Badge>{sold} sold to us</Badge>}
          {owned > 0 && <Badge>{owned} for service</Badge>}
          <span aria-hidden className="pl-1 text-ink-muted">
            ›
          </span>
        </span>
      </Link>
    </li>
  );
}
