import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { isClaudeConfigured } from "@/lib/claude";
import { listConversations, monthStats, type ConversationList } from "@/lib/diagnose";
import { MAX_LIST_WORDS, cleanListQuery, listHref, listSearchIsCut, listSearchWords, parsePage } from "@/lib/diagnose-list-rules";
import { SETUP_MESSAGE } from "@/lib/diagnose-rules";
import { allows, requireCapability } from "@/lib/session";

import { ConversationRow } from "./conversation-row";
import { ListSearch } from "./list-search";
import { Pagination } from "./pagination";

export const metadata: Metadata = { title: "Diagnose" };

export default function DiagnosePage(props: PageProps<"/diagnose">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Diagnose searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

async function Diagnose({ searchParams }: { searchParams: PageProps<"/diagnose">["searchParams"] }) {
  const user = await requireCapability("diagnostics.work");
  const params = await searchParams;
  const query = cleanListQuery(typeof params.q === "string" ? params.q : "");
  const list = await listConversations(user.shop.id, { query, page: parsePage(params.page) });
  // A search with no words in it ("—") lists everything, so it says nothing.
  const searching = listSearchWords(query).length > 0;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Diagnose"
        description="Talk a repair through with Claude. It looks things up in the shop's manuals and on the web, says where each answer comes from, and suggests what to check next."
        action={
          isClaudeConfigured ? (
            <Link href="/diagnose/new" className={primaryLinkClass}>
              New diagnosis
            </Link>
          ) : undefined
        }
      />

      {!isClaudeConfigured && <Notice tone="trail">{SETUP_MESSAGE}</Notice>}

      {typeof params.deleted === "string" && (
        <Notice>
          Deleted “{params.deleted}”.{" "}
          {allows(user, "audit.read") && (
            <Link href="/admin/activity-log?area=diagnoses" className="font-medium underline">
              See it in the Activity log
            </Link>
          )}
        </Notice>
      )}

      {allows(user, "reports.kpis") && <MonthCard shopId={user.shop.id} />}

      <Card title="Recent diagnoses" description={list.total === 0 && !searching ? undefined : "The whole shop's, most recently used first."}>
        {list.total === 0 && !searching ? (
          <p className="text-sm leading-6 text-ink-muted">
            None yet. {isClaudeConfigured ? "Start one with New diagnosis." : ""}
          </p>
        ) : (
          <ListSearch query={query}>
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

function Results({ list, query, searching }: { list: ConversationList; query: string; searching: boolean }) {
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted empty:hidden">
        {searching
          ? list.total === 0
            ? `Nothing matched ${quote(query)}.`
            : `${plural(list.total, "diagnosis matches", "diagnoses match")} ${quote(query)}.`
          : ""}
      </p>
      {list.total === 0 ? (
        <p className="mt-2 text-sm leading-6 text-ink-muted" data-list-empty>
          Try fewer words or another spelling, or{" "}
          <Link href={listHref("")} className="text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none">
            clear the search
          </Link>
          .
        </p>
      ) : (
        <>
          <ul className="-mx-5 mt-4 divide-y divide-white/10 border-y border-white/10 sm:-mx-6">
            {list.items.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <p className="font-mono text-xs text-ink-muted" data-list-range>
              {list.from.toLocaleString("en-US")}–{list.to.toLocaleString("en-US")} of {list.total.toLocaleString("en-US")}
            </p>
            <Pagination query={query} page={list.page} pages={list.pages} label="Pages of diagnoses" />
          </div>
        </>
      )}
    </>
  );
}

async function MonthCard({ shopId }: { shopId: string }) {
  const stats = await monthStats(shopId);
  const items: [string, string, string?][] = [
    ["Diagnoses started", stats.conversations.toLocaleString("en-US")],
    ["Messages to Claude", stats.messages.toLocaleString("en-US")],
    ["Web searches", stats.webSearches.toLocaleString("en-US")],
    ["Solved", stats.solved.toLocaleString("en-US"), `${stats.solvedTopCause.toLocaleString("en-US")} by Claude's top cause`],
  ];
  return (
    <Card title="This month" description="Managers and admins see this.">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {items.map(([label, value, note]) => (
          <div key={label}>
            <dt className="text-xs text-ink-muted">{label}</dt>
            <dd className="mt-0.5 font-mono text-lg text-ink">{value}</dd>
            {note && <dd className="text-xs text-ink-muted">{note}</dd>}
          </div>
        ))}
      </dl>
    </Card>
  );
}
