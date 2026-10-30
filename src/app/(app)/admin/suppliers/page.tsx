import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { MAX_LIST_WORDS, cleanListQuery, listSearchIsCut, listSearchWords, parsePage } from "@/lib/diagnose-list-rules";
import { requireCapability } from "@/lib/session";
import { SUPPLIER_FIELDS, SUPPLIER_FIELD_LABELS } from "@/lib/supplier-rules";
import { listCategories, listSuppliers, type SupplierList } from "@/lib/suppliers";

import { ListSearch } from "../../diagnose/list-search";
import { Pagination } from "../../diagnose/pagination";
import { CategoryFilter } from "./forms";

export const metadata: Metadata = { title: "Supplier" };

const PATH = "/admin/suppliers";
const pathFor = (category: string | null) => (category ? `${PATH}?category=${encodeURIComponent(category)}` : PATH);
const buttonClass =
  "inline-flex h-12 items-center rounded-lg border border-glow/30 px-5 text-base font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

export default function SuppliersPage(props: PageProps<"/admin/suppliers">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Suppliers searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

async function Suppliers({ searchParams }: { searchParams: PageProps<"/admin/suppliers">["searchParams"] }) {
  const user = await requireCapability("parts.manage");
  const params = await searchParams;
  const query = cleanListQuery(typeof params.q === "string" ? params.q : "");
  const category = typeof params.category === "string" && params.category.trim() ? params.category.trim().slice(0, 40) : null;
  const [list, categories] = await Promise.all([
    listSuppliers(user.shop.id, { query, category, page: parsePage(params.page) }),
    listCategories(user.shop.id),
  ]);
  const searching = listSearchWords(query).length > 0 || category !== null;
  const exportParams = new URLSearchParams();
  if (query) exportParams.set("q", query);
  if (category) exportParams.set("category", category);
  const exportQuery = exportParams.toString();

  return (
    <div className="space-y-6">
      <PageHeading
        title="Supplier"
        description="The shop's suppliers, as your dealer or accounting system lists them."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`${PATH}/import`} className={buttonClass}>
              Import
            </Link>
            <Link href={`${PATH}/new`} className={primaryLinkClass}>
              Add supplier
            </Link>
          </div>
        }
      />

      {typeof params.added === "string" && <Notice>Added {params.added}.</Notice>}
      {typeof params.removed === "string" && <Notice>Removed {params.removed}.</Notice>}

      <Card>
        {list.total === 0 && !searching ? (
          <p className="text-sm leading-6 text-ink-muted">
            No suppliers yet. Add one, or{" "}
            <Link href={`${PATH}/import`} className="text-glow hover:underline">
              import your list
            </Link>{" "}
            from a CSV or Excel file.
          </p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              {categories.length > 0 ? <CategoryFilter categories={categories} category={category} query={query} /> : <span />}
              {list.total > 0 && (
                <a href={`${PATH}/export${exportQuery ? `?${exportQuery}` : ""}`} className={`${buttonClass} h-11 px-4 text-sm`} data-supplier-export>
                  Download CSV
                </a>
              )}
            </div>
            <ListSearch query={query} path={pathFor(category)} label="Search suppliers" placeholder="Supplier ID, code, name or category">
              <Results list={list} query={query} category={category} searching={searching} />
            </ListSearch>
          </>
        )}
      </Card>
    </div>
  );
}

const quote = (query: string) => `“${query}”${listSearchIsCut(query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : ""}`;

function Results({ list, query, category, searching }: { list: SupplierList; query: string; category: string | null; searching: boolean }) {
  const what = [query && quote(query), category && `category ${category}`].filter(Boolean).join(" in ");
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted empty:hidden">
        {searching ? (list.total === 0 ? `Nothing matched ${what}.` : `${plural(list.total, "supplier matches", "suppliers match")} ${what}.`) : ""}
      </p>
      {list.total === 0 ? (
        <p className="mt-2 text-sm leading-6 text-ink-muted">
          <Link href={PATH} className="text-glow hover:underline">
            Show every supplier
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="-mx-5 mt-4 overflow-x-auto border-y border-white/10 sm:-mx-6">
            <table className="w-full min-w-[40rem] text-sm" data-supplier-list>
              <thead>
                <tr className="border-b border-white/10 text-left text-xs text-ink-muted">
                  {SUPPLIER_FIELDS.map((field) => (
                    <th key={field} scope="col" className="px-3 py-2 font-medium first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6">
                      {SUPPLIER_FIELD_LABELS[field]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {list.items.map((supplier) => (
                  <tr key={supplier.id} data-supplier-row>
                    <th scope="row" className="py-2.5 pr-3 pl-5 text-left font-mono font-medium text-ink sm:pl-6">
                      <Link href={`${PATH}/${supplier.id}`} className="hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none">
                        {supplier.supplierId}
                      </Link>
                    </th>
                    <td className="px-3 py-2.5 font-mono text-ink">{supplier.supplierCode ?? <span className="text-ink-muted">—</span>}</td>
                    <td className="px-3 py-2.5 break-words text-ink">
                      <Link href={`${PATH}/${supplier.id}`} className="hover:text-glow hover:underline">
                        {supplier.supplierName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-ink">{supplier.categoryCode ?? <span className="text-ink-muted">—</span>}</td>
                    <td className="py-2.5 pr-5 pl-3 font-mono text-ink sm:pr-6">{supplier.categoryId ?? <span className="text-ink-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <p className="font-mono text-xs text-ink-muted" data-list-range>
              {list.from.toLocaleString("en-US")}–{list.to.toLocaleString("en-US")} of {list.total.toLocaleString("en-US")}
            </p>
            <Pagination query={query} page={list.page} pages={list.pages} label="Pages of suppliers" path={pathFor(category)} />
          </div>
        </>
      )}
    </>
  );
}
