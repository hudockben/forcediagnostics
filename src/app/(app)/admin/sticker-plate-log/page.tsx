import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ClearParams } from "@/components/app/clear-params";
import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { MAX_LIST_WORDS, cleanListQuery, listHref, listSearchIsCut, listSearchWords, parsePage } from "@/lib/diagnose-list-rules";
import { requireCapability } from "@/lib/session";
import { getCustomerChoice, listStickerLog, recentlyRemoved, type StickerLog } from "@/lib/sticker-log";
import { PLATE_CLASSES, PLATE_CLASS_LABELS, parseClassFilter, type PlateClass } from "@/lib/sticker-log-rules";

import { ListSearch } from "../../diagnose/list-search";
import { Pagination } from "../../diagnose/pagination";
import { ExportLink, StickerForm } from "./forms";

export const metadata: Metadata = { title: "Sticker & Plate log" };

const PATH = "/admin/sticker-plate-log";

export default function StickerLogPage(props: PageProps<"/admin/sticker-plate-log">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <StickerLogScreen searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// The list's own path with its class filter, which searches and pages keep.
const pathFor = (plateClass: PlateClass | null) => (plateClass ? `${PATH}?class=${plateClass}` : PATH);

async function StickerLogScreen({ searchParams }: { searchParams: PageProps<"/admin/sticker-plate-log">["searchParams"] }) {
  const user = await requireCapability("repair_orders.intake");
  const params = await searchParams;
  const query = cleanListQuery(typeof params.q === "string" ? params.q : "");
  const plateClass = parseClassFilter(params.class);
  const [log, customer, removed] = await Promise.all([
    listStickerLog(user.shop.id, { query, plateClass, page: parsePage(params.page) }),
    // "Log a sticker" from a customer's record.
    typeof params.customer === "string" ? getCustomerChoice(user.shop.id, params.customer) : Promise.resolve(null),
    // The sticker just removed: only one the audit log shows this user
    // removed, never other words a link might carry.
    typeof params.removed === "string" ? recentlyRemoved(user, params.removed) : Promise.resolve(null),
  ]);
  const searching = listSearchWords(query).length > 0 || plateClass !== null;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Sticker & Plate log"
        description="Every registration sticker the shop hands out: its number, the customer it went to, and the plate's classification."
      />

      {removed && <Notice>Sticker {removed} removed from the log.</Notice>}
      <ClearParams names={["removed"]} />

      <Card title="Log a sticker">
        <StickerForm initialCustomer={customer} />
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Plate classification" className="flex flex-wrap gap-2">
            {[null, ...PLATE_CLASSES].map((option) => (
              <Link
                key={option ?? "all"}
                href={listHref(query, 1, pathFor(option))}
                aria-current={option === plateClass ? "page" : undefined}
                className={`flex h-10 items-center rounded-full px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
                  option === plateClass ? "bg-glow/15 text-glow" : "text-ink-muted hover:bg-white/5 hover:text-ink"
                }`}
              >
                {option ? PLATE_CLASS_LABELS[option] : "All"}
              </Link>
            ))}
          </nav>
          {log.total > 0 && <ExportLink query={query} plateClass={plateClass} />}
        </div>
        <div className="mt-4">
          {log.total === 0 && !searching ? (
            <p className="text-sm leading-6 text-ink-muted">Nothing logged yet. Log the first sticker above.</p>
          ) : (
            <ListSearch query={query} path={pathFor(plateClass)} label="Search the log" placeholder="Sticker #, customer's name or phone">
              <Results log={log} query={query} plateClass={plateClass} searching={searching} />
            </ListSearch>
          )}
        </div>
      </Card>
    </div>
  );
}

const quote = (query: string) =>
  `“${query}”${listSearchIsCut(query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : ""}`;

function Results({ log, query, plateClass, searching }: { log: StickerLog; query: string; plateClass: PlateClass | null; searching: boolean }) {
  const what = [query && quote(query), plateClass && PLATE_CLASS_LABELS[plateClass]].filter(Boolean).join(" in ");
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted empty:hidden">
        {searching ? (log.total === 0 ? `Nothing matched ${what}.` : `${plural(log.total, "sticker matches", "stickers match")} ${what}.`) : ""}
      </p>
      {log.total === 0 ? (
        <p className="mt-2 text-sm leading-6 text-ink-muted" data-list-empty>
          <Link href={PATH} className="text-glow hover:underline">
            Show the whole log
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="-mx-5 mt-4 overflow-x-auto border-y border-white/10 sm:-mx-6">
            <table className="w-full min-w-[34rem] text-sm" data-sticker-log>
              <thead>
                <tr className="border-b border-white/10 text-left text-xs text-ink-muted">
                  <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                    Sticker #
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Customer Name
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Plate Classification
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                    Logged
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {log.items.map((entry) => (
                  <tr key={entry.id} data-sticker-row>
                    <th scope="row" className="px-5 py-2.5 text-left font-mono font-medium tracking-wide text-ink sm:px-6">
                      <Link href={`${PATH}/${entry.id}`} className="hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none">
                        {entry.stickerNumber}
                      </Link>
                    </th>
                    <td className="px-3 py-2.5 break-words">
                      <Link href={`/admin/customers/${entry.customerId}`} className="text-ink hover:text-glow hover:underline">
                        {entry.customerName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={entry.plateClass === 1 ? "glow" : "neutral"}>{entry.plateClass}</Badge>
                    </td>
                    <td className="px-5 py-2.5 text-xs text-ink-muted sm:px-6">
                      <LocalTime value={entry.createdAt.toISOString()} />
                      {entry.createdBy && <span className="block">{entry.createdBy}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <p className="font-mono text-xs text-ink-muted" data-list-range>
              {log.from.toLocaleString("en-US")}–{log.to.toLocaleString("en-US")} of {log.total.toLocaleString("en-US")}
            </p>
            <Pagination query={query} page={log.page} pages={log.pages} label="Pages of the log" path={pathFor(plateClass)} />
          </div>
        </>
      )}
    </>
  );
}
