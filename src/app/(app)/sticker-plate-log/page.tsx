import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { MAX_LIST_WORDS, cleanListQuery, listHref, listSearchIsCut, listSearchWords, parsePage } from "@/lib/diagnose-list-rules";
import { requireCapability } from "@/lib/session";
import { getCustomerChoice, getStickerStock, listStickerLog, type StickerLog } from "@/lib/sticker-log";
import {
  ENTRY_KINDS,
  ENTRY_KIND_PLURALS,
  LOW_STOCK_BELOW,
  entryLabel,
  isLowStock,
  lowStockMessage,
  parseKindFilter,
  parseOnHandFilter,
  type EntryKind,
  type StockLevel,
} from "@/lib/sticker-log-rules";

import { ListSearch } from "../diagnose/list-search";
import { Pagination } from "../diagnose/pagination";
import { AddStockForm, ExportLink, StickerForm } from "./forms";

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

// The list's own path with its filters (stickers, or one class of plates;
// the ones on hand), which searches and pages keep.
function pathFor(kind: EntryKind | null, onHand: boolean) {
  const params = new URLSearchParams();
  if (onHand) params.set("status", "on-hand");
  if (kind) params.set("type", kind);
  const search = params.toString();
  return search ? `${PATH}?${search}` : PATH;
}

const pillClass = (current: boolean) =>
  `flex h-10 items-center rounded-full px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
    current ? "bg-glow/15 text-glow" : "text-ink-muted hover:bg-white/5 hover:text-ink"
  }`;

async function StickerLogScreen({ searchParams }: { searchParams: PageProps<"/sticker-plate-log">["searchParams"] }) {
  const user = await requireCapability("repair_orders.intake");
  const params = await searchParams;
  const query = cleanListQuery(typeof params.q === "string" ? params.q : "");
  const kind = parseKindFilter(params.type);
  const onHand = parseOnHandFilter(params.status);
  const [log, customer, stock] = await Promise.all([
    listStickerLog(user.shop.id, { query, kind, onHand, page: parsePage(params.page) }),
    // "Log a sticker or plate" from a customer's record.
    typeof params.customer === "string" ? getCustomerChoice(user.shop.id, params.customer) : Promise.resolve(null),
    getStickerStock(user.shop.id),
  ]);
  const searching = listSearchWords(query).length > 0 || kind !== null;
  const low = lowStockMessage(stock);
  const onHandCount = stock.reduce((sum, level) => sum + level.onHand, 0);

  return (
    <div className="space-y-6">
      <PageHeading
        title="Sticker & Plate log"
        description="Every registration sticker and plate the shop hands out, and the ones it has on hand: each number, the customer it went to, and a plate's class."
        action={
          <Link href={`${PATH}/import`} className={buttonClass}>
            Import
          </Link>
        }
      />

      {low && (
        <div data-low-stock>
          <Notice tone="trail">
            {low} Order more, then{" "}
            <a href="#stock" className="font-medium underline underline-offset-2">
              add them to stock
            </a>
            .
          </Notice>
        </div>
      )}

      {typeof params.removed === "string" && <Notice>{params.removed} removed from the log.</Notice>}

      <Card title="Log a sticker or plate">
        <StickerForm initialCustomer={customer} nextOnHand={Object.fromEntries(stock.flatMap((level) => (level.next ? [[level.kind, level.next]] : [])))} />
      </Card>

      <div id="stock" className="scroll-mt-6">
        <Card
          title="On hand"
          description={`The numbers the shop has and hasn't handed out: one on your sheet with no customer beside it, or one added here. Logging it for a customer hands it out. Under ${LOW_STOCK_BELOW} of a kind on hand, the tab says it's getting low.`}
        >
          <StockLevels stock={stock} />
          <div className="mt-6 border-t border-white/10 pt-5">
            <h3 className="text-sm font-semibold text-ink">Add to stock</h3>
            <p className="mt-1 text-sm leading-6 text-ink-muted">A delivery: one number, or the first and last of a run of them.</p>
            <div className="mt-4">
              <AddStockForm />
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Handed out or on hand" className="flex flex-wrap gap-2">
            {[false, true].map((option) => (
              <Link
                key={String(option)}
                href={listHref(query, 1, pathFor(kind, option))}
                aria-current={option === onHand ? "page" : undefined}
                className={pillClass(option === onHand)}
                data-status-filter={option ? "on-hand" : "handed-out"}
              >
                {option ? `On hand (${onHandCount.toLocaleString("en-US")})` : "Handed out"}
              </Link>
            ))}
          </nav>
          {log.total > 0 && <ExportLink query={query} kind={kind} onHand={onHand} />}
        </div>
        <nav aria-label="Stickers or plates" className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
          {[null, ...ENTRY_KINDS].map((option) => (
            <Link key={option ?? "all"} href={listHref(query, 1, pathFor(option, onHand))} aria-current={option === kind ? "page" : undefined} className={pillClass(option === kind)}>
              {option ? ENTRY_KIND_PLURALS[option] : "All"}
            </Link>
          ))}
        </nav>
        <div className="mt-4">
          {log.total === 0 && !searching ? (
            onHand ? (
              <p className="text-sm leading-6 text-ink-muted" data-list-empty>
                Nothing on hand. Add a delivery to stock above, or{" "}
                <Link href={`${PATH}/import`} className="text-glow hover:underline">
                  import your sheet
                </Link>
                : a number with no customer beside it comes in on hand.
              </p>
            ) : (
              <p className="text-sm leading-6 text-ink-muted">
                Nothing logged yet. Log the first sticker or plate above, or{" "}
                <Link href={`${PATH}/import`} className="text-glow hover:underline">
                  import your log
                </Link>{" "}
                from a CSV or Excel file.
              </p>
            )
          ) : (
            <ListSearch query={query} path={pathFor(kind, onHand)} label="Search the log" placeholder={onHand ? "Sticker or plate #" : "Sticker or plate #, customer's name or phone"}>
              <Results log={log} query={query} kind={kind} onHand={onHand} searching={searching} />
            </ListSearch>
          )}
        </div>
      </Card>
    </div>
  );
}

// Each kind's stock: how many are on hand, a badge when it's getting low
// or out, and the next to hand out; a kind the shop has never had on hand
// says so.
function StockLevels({ stock }: { stock: StockLevel[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-3" data-stock-levels>
      {ENTRY_KINDS.map((kind) => {
        const level = stock.find((each) => each.kind === kind);
        return (
          <li key={kind} className="rounded-lg border border-white/10 px-4 py-3" data-stock-kind={kind} data-stock-low={level && isLowStock(level) ? "" : undefined}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-ink-muted">{ENTRY_KIND_PLURALS[kind]}</h3>
              {level && isLowStock(level) && <Badge tone={level.onHand === 0 ? "suspect" : "trail"}>{level.onHand === 0 ? "Out" : "Getting low"}</Badge>}
            </div>
            {level ? (
              <>
                <p className="mt-1 text-ink">
                  <span className="font-mono text-3xl font-semibold" data-stock-on-hand>
                    {level.onHand.toLocaleString("en-US")}
                  </span>{" "}
                  <span className="text-sm text-ink-muted">on hand</span>
                </p>
                {level.next && (
                  <p className="mt-1 text-xs leading-5 text-ink-muted">
                    Next:{" "}
                    <Link href={pathFor(kind, true)} className="font-mono text-ink hover:text-glow hover:underline">
                      {level.next}
                    </Link>
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm leading-6 text-ink-muted">None in stock yet.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const quote = (query: string) =>
  `“${query}”${listSearchIsCut(query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : ""}`;

function Results({ log, query, kind, onHand, searching }: { log: StickerLog; query: string; kind: EntryKind | null; onHand: boolean; searching: boolean }) {
  const what = [query && quote(query), kind && ENTRY_KIND_PLURALS[kind], onHand && "on hand"].filter(Boolean).join(" in ");
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted empty:hidden">
        {searching ? (log.total === 0 ? `Nothing matched ${what}.` : `${plural(log.total, "entry matches", "entries match")} ${what}.`) : ""}
      </p>
      {log.total === 0 ? (
        <p className="mt-2 text-sm leading-6 text-ink-muted" data-list-empty>
          <Link href={pathFor(null, onHand)} className="text-glow hover:underline">
            {onHand ? "Show everything on hand" : "Show the whole log"}
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
                    {onHand ? "Added" : "Logged"}
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
                      {entry.customerId === null ? (
                        <span className="text-ink-muted">On hand</span>
                      ) : (
                        <Link href={`/customers/${entry.customerId}`} className="text-ink hover:text-glow hover:underline">
                          {entry.customerName}
                        </Link>
                      )}
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
            <Pagination query={query} page={log.page} pages={log.pages} label="Pages of the log" path={pathFor(kind, onHand)} />
          </div>
        </>
      )}
    </>
  );
}
