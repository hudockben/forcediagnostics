import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { Greeting } from "@/components/app/greeting";
import { LocalTime } from "@/components/app/local-time";
import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { inputBaseClass, primaryLinkClass } from "@/components/hud";
import { isClaudeConfigured } from "@/lib/claude";
import { listOwnOpenConversations, shopGlance, type ConversationSummary } from "@/lib/diagnose";
import { firstName } from "@/lib/greeting";
import { MAX_QUERY_LENGTH } from "@/lib/library";
import { ADMIN_SECTIONS } from "@/lib/permissions";
import { allows, getCurrentUser } from "@/lib/session";

import { ConversationRow } from "../diagnose/conversation-row";
import { BookIcon, ChatIcon, ReplyIcon } from "../diagnose/icons";

export const metadata: Metadata = { title: "Home" };

// Where everyone lands after signing in: the things they do most, one tap
// away on a bay tablet, and their own open diagnoses. Account settings are
// on their own page (/account).
export default function HomePage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const user = await getCurrentUser();
  const canDiagnose = allows(user, "diagnostics.work");
  // System Admin opens where the header's tab does.
  const adminSection = ADMIN_SECTIONS.find((section) => allows(user, section.capability));
  const [open, glance] = await Promise.all([
    canDiagnose ? listOwnOpenConversations(user) : [],
    allows(user, "reports.kpis") ? shopGlance(user.shop.id) : null,
  ]);
  const latest = open[0];
  const canStart = canDiagnose && isClaudeConfigured;

  return (
    <div className="space-y-6">
      <PageHeading eyebrow={user.shop.name} title={<Greeting name={firstName(user.name)} />} />

      {(canStart || latest) && (
        // A tile on its own takes the whole row.
        <section aria-label="Quick actions" className={`grid gap-4 ${canStart && latest ? "sm:grid-cols-2" : ""}`}>
          {canStart && (
            <ActionTile
              href="/diagnose/new"
              data="new"
              primary
              icon={<ChatIcon className="size-6" />}
              title="New diagnosis"
              detail="Talk a repair through with Claude."
            />
          )}
          {latest && (
            <ActionTile
              href={`/diagnose/${latest.id}`}
              data="continue"
              icon={<ReplyIcon className="size-6" />}
              title="Continue"
              detail={<ContinueDetail conversation={latest} />}
            />
          )}
        </section>
      )}

      {allows(user, "library.read") && <ManualSearch />}

      {glance && (
        <Link
          href="/diagnose"
          data-glance
          className="block rounded-xl border border-white/10 bg-charcoal-900/70 px-5 py-4 transition hover:border-glow/30 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none sm:px-6"
        >
          <span className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
            <span className="grid grid-cols-3 gap-x-6 gap-y-1 sm:gap-x-10">
              <Stat label="Open, used this week" value={glance.openThisWeek} />
              <Stat label="Started this month" value={glance.startedThisMonth} />
              <Stat label="Solved this month" value={glance.solvedThisMonth} />
            </span>
            <span className="text-sm font-medium text-glow">Diagnose ›</span>
          </span>
        </Link>
      )}

      {canDiagnose && (
        <Card title="Your open diagnoses" description={open.length > 0 ? "The ones you've worked on, most recent first." : undefined}>
          {open.length === 0 ? (
            <p className="text-sm leading-6 text-ink-muted">
              Nothing open.{canStart ? " Start one with New diagnosis." : ""}
            </p>
          ) : (
            <ul className="-mx-5 divide-y divide-white/10 border-y border-white/10 sm:-mx-6" data-own-open>
              {open.map((conversation) => (
                <ConversationRow key={conversation.id} conversation={conversation} startedBy={false} openBadge={false} />
              ))}
            </ul>
          )}
          <p className="mt-4">
            <Link
              href="/diagnose"
              data-all-diagnoses
              className="inline-flex h-11 items-center text-sm font-medium text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              All diagnoses ›
            </Link>
          </p>
        </Card>
      )}

      {/* Settings stay out of the way: one quiet line at the foot. */}
      <p className="flex flex-wrap gap-x-6">
        <Link href="/account" data-home-account className={footLink}>
          {user.bay ? "Your account" : "Your account: password and bay tablet PIN"} ›
        </Link>
        {adminSection && (
          <Link href={adminSection.href} data-home-admin className={footLink}>
            System Admin ›
          </Link>
        )}
      </p>
    </div>
  );
}

const footLink =
  "inline-flex h-11 items-center text-sm text-ink-muted transition hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

// A quick action sized for a finger on a bay tablet.
function ActionTile({
  href,
  data,
  primary = false,
  icon,
  title,
  detail,
}: {
  href: string;
  data: string;
  primary?: boolean;
  icon: ReactNode;
  title: string;
  detail: ReactNode;
}) {
  return (
    <Link
      href={href}
      data-home-action={data}
      className={`flex min-h-24 items-center gap-4 rounded-xl border px-5 py-4 transition focus-visible:ring-2 focus-visible:outline-none sm:px-6 ${
        primary
          ? "border-trail/40 bg-trail/10 hover:border-trail/70 hover:bg-trail/15 focus-visible:ring-trail/60"
          : "border-white/10 bg-charcoal-900/70 hover:border-glow/30 hover:bg-charcoal-800/70 focus-visible:ring-glow/40"
      }`}
    >
      <span
        className={`flex size-12 shrink-0 items-center justify-center rounded-full ${primary ? "bg-trail text-charcoal-900" : "bg-glow/15 text-glow"}`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block text-sm leading-5 break-words text-ink-muted">{detail}</span>
      </span>
    </Link>
  );
}

function ContinueDetail({ conversation }: { conversation: ConversationSummary }) {
  return (
    <>
      <span className="block text-ink">{conversation.title}</span>
      <span className="block text-xs">
        {conversation.lastTurn === "running" ? "Claude is working on it · " : conversation.lastTurn === "failed" ? "Last message failed · " : ""}
        <LocalTime value={conversation.updatedAt} />
      </span>
    </>
  );
}

// Searches the Library the way its own box does (/library?q=…). A plain GET
// form, so it works before the page's JavaScript has loaded; like the
// Library's box, an empty search lists every manual.
function ManualSearch() {
  return (
    <section aria-labelledby="home-manuals" className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
      <h2 id="home-manuals" className="flex items-center gap-2 text-base font-semibold text-ink">
        <BookIcon className="size-4 text-glow" />
        Search the manuals
      </h2>
      <Form action="/library" role="search" className="mt-4 flex flex-col gap-3 sm:flex-row" data-home-manual-search>
        <label htmlFor="home-manual-q" className="sr-only">
          Search the manuals
        </label>
        <input
          id="home-manual-q"
          name="q"
          type="search"
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
      <p className="mt-2">
        <Link
          href="/library"
          data-home-browse
          className="inline-flex h-11 items-center text-sm font-medium text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          Browse all manuals ›
        </Link>
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="block" data-stat={label}>
      <span className="block text-xs text-ink-muted">{label}</span>
      <span className="mt-0.5 block font-mono text-lg text-ink">{value.toLocaleString("en-US")}</span>
    </span>
  );
}
