import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { isClaudeConfigured } from "@/lib/claude";
import { listConversations, monthStats, type ConversationSummary } from "@/lib/diagnose";
import { SETUP_MESSAGE, formatCents } from "@/lib/diagnose-rules";
import { allows, requireCapability } from "@/lib/session";

export const metadata: Metadata = { title: "Diagnose" };

export default function DiagnosePage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Diagnose />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

async function Diagnose() {
  const user = await requireCapability("diagnostics.work");
  const conversations = await listConversations(user.shop.id);

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

      {allows(user, "reports.kpis") && <MonthCard shopId={user.shop.id} />}

      <Card title="Recent diagnoses" description={conversations.length === 0 ? undefined : "The whole shop's, newest first."}>
        {conversations.length === 0 ? (
          <p className="text-sm leading-6 text-ink-muted">
            None yet. {isClaudeConfigured ? "Start one with New diagnosis." : ""}
          </p>
        ) : (
          <ul className="-mx-5 -mb-5 divide-y divide-white/10 border-t border-white/10 sm:-mx-6 sm:-mb-6">
            {conversations.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ConversationRow({ conversation }: { conversation: ConversationSummary }) {
  return (
    <li>
      <Link
        href={`/diagnose/${conversation.id}`}
        className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 transition hover:bg-white/[0.03] focus-visible:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-glow/60 focus-visible:outline-none focus-visible:ring-inset sm:px-6"
      >
        <span className="min-w-0">
          <span className="block font-medium break-words text-ink">{conversation.title}</span>
          <span className="block text-xs text-ink-muted">
            {[conversation.unit, `${conversation.startedBy}`, plural(conversation.techMessages, "message", "messages")]
              .filter(Boolean)
              .join(" · ")}{" "}
            · <LocalTime value={conversation.updatedAt} />
          </span>
        </span>
        <span className="flex gap-2">
          {conversation.lastTurn === "running" && <Badge tone="glow">Working</Badge>}
          {conversation.lastTurn === "failed" && <Badge tone="trail">Last message failed</Badge>}
          {conversation.status === "solved" ? <Badge tone="glow">Solved</Badge> : <Badge>Open</Badge>}
        </span>
      </Link>
    </li>
  );
}

async function MonthCard({ shopId }: { shopId: string }) {
  const stats = await monthStats(shopId);
  const items: [string, string, string?][] = [
    ["Diagnoses started", stats.conversations.toLocaleString("en-US")],
    ["Messages to Claude", stats.messages.toLocaleString("en-US")],
    ["Web searches", stats.webSearches.toLocaleString("en-US")],
    ["Estimated cost", formatCents(stats.costCents)],
    ["Solved", stats.solved.toLocaleString("en-US"), `${stats.solvedTopCause.toLocaleString("en-US")} by Claude's top cause`],
  ];
  return (
    <Card
      title="This month"
      description="Managers and admins see this. The cost is an estimate from token counts at Claude Opus 5.5's list prices."
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
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
