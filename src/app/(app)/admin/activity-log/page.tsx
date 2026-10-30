import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { listAuditLog, verifyAuditLog, type AuditLogPage } from "@/lib/audit-log";
import {
  AUDIT_AREAS,
  AUDIT_AREA_KEYS,
  authorOf,
  checkInWords,
  describeAuditEntry,
  parseAreaFilter,
  type AuditArea,
  type AuditLogEntry,
} from "@/lib/audit-log-rules";
import { MAX_LIST_WORDS, cleanListQuery, listHref, listSearchIsCut, listSearchWords, parsePage } from "@/lib/diagnose-list-rules";
import { requireCapability } from "@/lib/session";

import { ListSearch } from "../../diagnose/list-search";
import { Pagination } from "../../diagnose/pagination";
import { ExportLink } from "./export-link";

export const metadata: Metadata = { title: "Activity log" };

const PATH = "/admin/activity-log";

export default function ActivityLogPage(props: PageProps<"/admin/activity-log">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <ActivityLog searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// The log's own path with its area, which searches and pages keep.
const pathFor = (area: AuditArea | null) => (area ? `${PATH}?area=${area}` : PATH);

// Read only: there's nothing here, or anywhere, to change or delete an
// entry with.
async function ActivityLog({ searchParams }: { searchParams: PageProps<"/admin/activity-log">["searchParams"] }) {
  const user = await requireCapability("audit.read");
  const params = await searchParams;
  const query = cleanListQuery(typeof params.q === "string" ? params.q : "");
  const area = parseAreaFilter(params.area);
  const log = await listAuditLog(user.shop.id, { query, area, page: parsePage(params.page) });
  const searching = listSearchWords(query).length > 0 || area !== null;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Activity log"
        description={`Everything changed at ${user.shop.name}, the newest first: who did it, what, and when. Nobody can edit or delete an entry, admins included, and each is sealed to the one before it, so one changed or taken out behind the app's back shows up here.`}
      />

      {/* The check reads every entry: the list doesn't wait for it. */}
      <Suspense
        fallback={
          <p className="rounded-xl border border-white/10 px-5 py-4 text-sm text-ink-muted sm:px-6" data-log-check="checking">
            Checking the log&apos;s seals…
          </p>
        }
      >
        <LogCheck shopId={user.shop.id} />
      </Suspense>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Area" className="flex flex-wrap gap-2">
            {[null, ...AUDIT_AREA_KEYS].map((option) => (
              <Link
                key={option ?? "all"}
                href={listHref(query, 1, pathFor(option))}
                aria-current={option === area ? "page" : undefined}
                className={`flex h-10 items-center rounded-full px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
                  option === area ? "bg-glow/15 text-glow" : "text-ink-muted hover:bg-white/5 hover:text-ink"
                }`}
              >
                {option ? AUDIT_AREAS[option].label : "All"}
              </Link>
            ))}
          </nav>
          {log.total > 0 && <ExportLink query={query} area={area} />}
        </div>
        <div className="mt-4">
          {log.total === 0 && !searching ? (
            <p className="text-sm leading-6 text-ink-muted">
              Nothing in the log yet. Changes made under System Admin, and diagnoses deleted, show up here.
            </p>
          ) : (
            <ListSearch query={query} path={pathFor(area)} label="Search the log" placeholder="Name, sticker #, file, title…">
              <Results log={log} query={query} area={area} searching={searching} />
            </ListSearch>
          )}
        </div>
      </Card>
    </div>
  );
}

// Whether every entry still matches its seal, and the latest entry's hash,
// which stands for the whole log up to it.
async function LogCheck({ shopId }: { shopId: string }) {
  const check = await verifyAuditLog(shopId);
  const { ok, text } = checkInWords(check);
  return (
    <section
      aria-label="The log's seals"
      data-log-check={ok ? "ok" : "broken"}
      className={`rounded-xl border px-5 py-4 sm:px-6 ${ok ? "border-glow/30 bg-glow/5" : "border-trail/40 bg-trail/10"}`}
    >
      <p className={`text-sm font-medium ${ok ? "text-glow" : "text-trail"}`}>{text}</p>
      {check.last && (
        <p className="mt-2 text-xs leading-5 text-ink-muted">
          Latest entry #{check.last.seq.toLocaleString("en-US")}, <LocalTime value={check.last.createdAt.toISOString()} year />. Its
          fingerprint is <code className="font-mono break-all text-ink select-all">{check.last.hash}</code>. Keep a note of it, or the
          CSV, which has every entry&apos;s: if an entry up to this one is ever changed or taken out, it won&apos;t match.
        </p>
      )}
    </section>
  );
}

const quote = (query: string) =>
  `“${query}”${listSearchIsCut(query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : ""}`;

function Results({ log, query, area, searching }: { log: AuditLogPage; query: string; area: AuditArea | null; searching: boolean }) {
  const what = [query && quote(query), area && AUDIT_AREAS[area].label].filter(Boolean).join(" in ");
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
          <ol className="-mx-5 mt-4 divide-y divide-white/10 border-y border-white/10 sm:-mx-6" data-activity-log>
            {log.items.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <p className="font-mono text-xs text-ink-muted" data-list-range>
              {log.from.toLocaleString("en-US")}–{log.to.toLocaleString("en-US")} of {log.total.toLocaleString("en-US")}
            </p>
            <Pagination query={query} page={log.page} pages={log.pages} label="Pages of the log" path={pathFor(area)} />
          </div>
        </>
      )}
    </>
  );
}

function Entry({ entry }: { entry: AuditLogEntry }) {
  const { summary, facts } = describeAuditEntry(entry);
  return (
    <li className="flex gap-3 px-5 py-3 sm:px-6" data-log-entry={entry.seq ?? ""}>
      <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-xs text-ink-muted sm:w-14">
        {entry.seq === null ? "—" : `#${entry.seq.toLocaleString("en-US")}`}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words text-ink">{summary}</p>
        {facts.length > 0 && (
          <dl className="mt-1 space-y-0.5 text-xs">
            {facts.map((fact) => (
              <div key={fact.label} className="flex gap-1.5">
                <dt className="shrink-0 text-ink-muted">{fact.label}:</dt>
                <dd className="min-w-0 break-words text-ink/90">{fact.time ? <LocalTime value={fact.value} year /> : fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-1 text-xs text-ink-muted">
          {authorOf(entry)} · <LocalTime value={entry.createdAt.toISOString()} year />
        </p>
      </div>
    </li>
  );
}
