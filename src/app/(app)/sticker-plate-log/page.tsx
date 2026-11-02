import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { MAX_LIST_WORDS, cleanListQuery, listHref, listSearchIsCut, listSearchWords, parsePage } from "@/lib/diagnose-list-rules";
import { requireCapability } from "@/lib/session";
import { getCustomerChoice, listStickerLog, type StickerLog } from "@/lib/sticker-log";
import { ENTRY_KINDS, ENTRY_KIND_PLURALS, entryLabel, parseKindFilter, type EntryKind } from "@/lib/sticker-log-rules";

import { ListSearch } from "../diagnose/list-search";
import { Pagination } from "../diagnose/pagination";
import { ExportLink, StickerForm } from "./forms";

export const metadata: Metadata = { title: "Sticker & Plate log" };

const PATH = "/sticker-plate-log";

const buttonClass =
  "inline-flex h-12 items-center rounded-lg border border-glow/30 px-5 text-base font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

export default function StickerLogPage(props: PageProps<"/sticker-plate-log">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <StickerLogScreen searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// The list's own path with its filter (stickers, or one class of plates),
// which searches and pages keep.
const pathFor = (kind: EntryKind | null) => (kind ? `${PATH}?type=${kind}` : PATH);

async function StickerLogScreen({ searchParams }: { searchParams: PageProps<"/sticker-plate-log">["searchParams"] }) {
  const user = await requireCapability("repair_orders.intake");
  const params = await searchParams;
  const query = cleanListQuery(typeof params.q === "string" ? params.q : "");
  const kind = parseKindFilter(params.type);
  const [log, customer] = await Promise.all([
    listStickerLog(user.shop.id, { query, kind, page: parsePage(params.page) }),
    // "Log a sticker or plate" from a customer's record.
    typeof params.customer === "string" ? getCustomerChoice(user.shop.id, params.customer) : Promise.resolve(null),
  ]);
  const searching = listSearchWords(query).length > 0 || kind !== null;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Sticker & Plate log"
        description="Every registration sticker and plate the shop hands out: its number and the customer it went to, and a plate's class."
        action={
          <Link href={`${PATH}/import`} className={buttonClass}>
            Import
          </Link>
        }
      />

      {typeof params.removed === "string" && <Notice>{params.removed} removed from the log.</Notice>}

      <Card title="Log a sticker or plate">
        <StickerForm initialCustomer={customer} />
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Stickers or plates" className="flex flex-wrap gap-2">
            {[null, ...ENTRY_KINDS].map((option) => (
              <Link
                key={option ?? "all"}
                href={listHref(query, 1, pathFor(option))}
                aria-current={option === kind ? "page" : undefined}
                className={`flex h-10 items-center rounded-full px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
                  option === kind ? "bg-glow/15 text-glow" : "text-ink-muted hover:bg-white/5 hover:text-ink"
                }`}
              >
                {option ? ENTRY_KIND_PLURALS[option] : "All"}
              </Link>
            ))}
          </nav>
          {log.total > 0 && <ExportLink query={query} kind={kind} />}
        </div>
        <div className="mt-4">
          {log.total === 0 && !searching ? (
            <p className="text-sm leading-6 text-ink-muted">
              Nothing logged yet. Log the first sticker or plate above, or{" "}
              <Link href={`${PATH}/import`} className="text-glow hover:underline">
                import your log
              </Link>{" "}
              from a CSV or Excel file.
            </p>
          ) : (
            <ListSearch query={query} path={pathFor(kind)} label="Search the log" placeholder="Sticker or plate #, customer's name or phone">
              <Results log={log} query={query} kind={kind} searching={searching} />
            </ListSearch>
          )}
        </div>
      </Card>
    </div>
  );
}

const quote = (query: string) =>
  `“${query}”${listSearchIsCut(query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : ""}`;

function Results({ log, query, kind, searching }: { log: StickerLog; query: string; kind: EntryKind | null; searching: boolean }) {
  const what = [query && quote(query), kind && ENTRY_KIND_PLURALS[kind]].filter(Boolean).join(" in ");
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted empty:hidden">
        {searching ? (log.total === 0 ? `Nothing matched ${what}.` : `${plural(log.total, "entry matches", "entries match")} ${what}.`) : ""}
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
                    Sticker / Plate #
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Customer Name
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Type
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
                      <Link href={`/customers/${entry.customerId}`} className="text-ink hover:text-glow hover:underline">
                        {entry.customerName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={entry.plateClass === null ? "neutral" : "glow"}>{entryLabel(entry.plateClass)}</Badge>
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
            <Pagination query={query} page={log.page} pages={log.pages} label="Pages of the log" path={pathFor(kind)} />
          </div>
        </>
      )}
    </>
  );
}
