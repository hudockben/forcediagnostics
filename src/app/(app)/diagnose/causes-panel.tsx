"use client";

import Link from "next/link";
import { useState } from "react";

import type {
  Cause,
  CauseVerdict,
  Check,
  ConversationView,
  DiagnosisReply,
  FeedbackEntry,
  ScopeView,
  SourceView,
  UnitSuggestion,
} from "@/lib/diagnose-rules";

import { changeUnitAction, markCauseAction } from "./actions";
import { UnitPicker } from "./unit-picker";

// Beside the chat (below it on a tablet): the unit and the manuals Claude is
// using, the likely causes as of Claude's last reply with the tech's
// "Ruled out" / "This was it" buttons, and the checks to do next.

const chipClass = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium";

const LIKELIHOOD: Record<Cause["likelihood"], { label: string; className: string }> = {
  // The suspect colour is kept for the top tier of suspects.
  high: { label: "High", className: "bg-suspect/15 text-suspect" },
  medium: { label: "Medium", className: "bg-trail/15 text-trail" },
  low: { label: "Low", className: "bg-white/5 text-ink-muted" },
};

const STATUS: Record<Cause["status"], { label: string; className: string }> = {
  open: { label: "Open", className: "bg-white/5 text-ink-muted" },
  ruled_out: { label: "Ruled out", className: "bg-white/5 text-ink-muted line-through" },
  confirmed: { label: "Confirmed", className: "bg-glow/15 text-glow" },
};

const sourceLinkClass =
  "inline-flex min-h-8 items-center rounded-full border px-2.5 text-xs font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function SourceBadges({ sources }: { sources: SourceView[] }) {
  if (sources.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Sources">
      {sources.map((source) => (
        <li key={source.type === "manual" ? `${source.manualId}:${source.page}` : source.type === "web" ? source.url : "general"}>
          {source.type === "manual" ? (
            <Link
              href={`/library/${source.manualId}?page=${source.page}`}
              title={source.title}
              aria-label={`Manual page ${source.page}: ${source.title}`}
              className={`${sourceLinkClass} border-glow/30 text-glow hover:bg-glow/10`}
            >
              Manual p.{source.page}
            </Link>
          ) : source.type === "web" ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={source.title}
              aria-label={`Web: ${source.title} (${hostOf(source.url)})`}
              className={`${sourceLinkClass} border-white/15 text-ink hover:border-white/30`}
            >
              Web · {hostOf(source.url)}
            </a>
          ) : (
            <span className={`${sourceLinkClass} border-white/10 text-ink-muted`}>General knowledge</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// The tech's latest press on a cause (matched by title, which carries over
// between Claude's replies), if any.
function verdictFor(feedback: FeedbackEntry[], title: string): CauseVerdict | null {
  const entry = feedback.findLast((item) => item.title.toLowerCase() === title.toLowerCase());
  return entry && entry.verdict !== "open" ? entry.verdict : null;
}

const toggleClass =
  "inline-flex h-10 items-center rounded-lg border px-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

function CauseItem({
  cause,
  rank,
  verdict,
  pending,
  onMark,
}: {
  cause: Cause;
  rank: number;
  verdict: CauseVerdict | null;
  pending: boolean;
  onMark: (verdict: CauseVerdict) => void;
}) {
  return (
    <li className="space-y-2 rounded-lg border border-white/10 bg-forest-950/40 p-3">
      <div className="flex items-start gap-2">
        <span className="font-mono text-sm text-ink-muted">{rank}.</span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className={`font-medium break-words ${cause.status === "ruled_out" ? "text-ink-muted line-through" : "text-ink"}`}>
            {cause.title}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className={`${chipClass} ${LIKELIHOOD[cause.likelihood].className}`}>
              {LIKELIHOOD[cause.likelihood].label}
            </span>
            <span className={`${chipClass} ${STATUS[cause.status].className}`}>{STATUS[cause.status].label}</span>
          </div>
        </div>
      </div>
      {cause.why && <p className="text-sm leading-6 break-words text-ink-muted">{cause.why}</p>}
      <SourceBadges sources={cause.sources} />
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          aria-pressed={verdict === "ruled_out"}
          disabled={pending}
          onClick={() => onMark(verdict === "ruled_out" ? "open" : "ruled_out")}
          className={`${toggleClass} ${verdict === "ruled_out" ? "border-ink-muted bg-white/10 text-ink" : "border-white/15 text-ink-muted hover:text-ink"}`}
        >
          Ruled out
        </button>
        <button
          type="button"
          aria-pressed={verdict === "confirmed"}
          disabled={pending}
          onClick={() => onMark(verdict === "confirmed" ? "open" : "confirmed")}
          className={`${toggleClass} ${verdict === "confirmed" ? "border-glow/60 bg-glow/15 text-glow" : "border-glow/30 text-glow hover:bg-glow/10"}`}
        >
          This was it
        </button>
      </div>
    </li>
  );
}

function CheckItem({ check }: { check: Check }) {
  return (
    <li className="space-y-1.5">
      <p className="text-sm leading-6 break-words text-ink">{check.action}</p>
      {check.expected && (
        <p className="text-sm leading-6 break-words">
          <span className="text-ink-muted">Expect: </span>
          <span className="font-mono text-ink">{check.expected}</span>
          {check.unverifiedSpec && (
            <span className="ml-2 inline-flex rounded-full bg-trail/15 px-2 py-0.5 text-xs font-medium text-trail">
              Not from your manuals — verify
            </span>
          )}
        </p>
      )}
      <SourceBadges sources={check.sources} />
    </li>
  );
}

function UnitCard({
  conversation,
  onScope,
  disabled,
}: {
  conversation: ConversationView;
  onScope: (scope: ScopeView, unit: string | null) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState<UnitSuggestion | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { scope } = conversation;
  const count = scope.manuals.length;

  async function change(input: { modelNumber?: string; wholeLibrary?: boolean }) {
    setPending(true);
    setMessage(null);
    const result = await changeUnitAction({ conversationId: conversation.id, ...input });
    setPending(false);
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    onScope(result.scope, result.unit);
    setEditing(false);
    setValue("");
    setPicked(null);
  }

  return (
    <section aria-label="Unit and manuals" className="rounded-xl border border-white/10 bg-charcoal-900/70 p-4">
      <p className="text-sm text-ink" data-testid="scope-line">
        {scope.label === null
          ? "Searching the shop's whole library"
          : `Using ${count} ${count === 1 ? "manual" : "manuals"} for ${scope.label}`}
      </p>
      {count > 0 && (
        <details className="mt-2 text-xs text-ink-muted">
          <summary className="cursor-pointer text-glow/90 hover:text-glow">Which manuals</summary>
          <ul className="mt-2 space-y-1">
            {scope.manuals.map((manual) => (
              <li key={manual.id}>
                <Link href={`/library/${manual.id}`} className="hover:text-glow hover:underline">
                  {manual.title}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
      {editing ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) void change({ modelNumber: value.trim() });
          }}
        >
          <label htmlFor="change-unit" className="text-sm font-medium text-ink/90">
            Model number
          </label>
          <UnitPicker id="change-unit" value={value} onChange={setValue} picked={picked} onPick={setPicked} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending || !value.trim()} className={`${toggleClass} border-glow/40 text-glow hover:bg-glow/10`}>
              Use this unit
            </button>
            <button type="button" disabled={pending} onClick={() => void change({ wholeLibrary: true })} className={`${toggleClass} border-white/15 text-ink-muted hover:text-ink`}>
              Whole library
            </button>
            <button type="button" onClick={() => setEditing(false)} className={`${toggleClass} border-transparent text-ink-muted hover:text-ink`}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setEditing(true)}
          className="mt-2 text-sm text-glow/90 hover:text-glow hover:underline disabled:opacity-60"
        >
          Change unit
        </button>
      )}
      {message && (
        <p role="status" className="mt-2 text-sm text-trail">
          {message}
        </p>
      )}
    </section>
  );
}

export function CausesPanel({
  conversation,
  reply,
  replyTurnId,
  busy,
  onConversation,
}: {
  conversation: ConversationView;
  reply: DiagnosisReply | null;
  replyTurnId: string | null;
  busy: boolean;
  onConversation: (update: Partial<ConversationView>) => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function mark(index: number, verdict: CauseVerdict) {
    if (!replyTurnId) return;
    setPending(index);
    setMessage(null);
    const result = await markCauseAction({ conversationId: conversation.id, turnId: replyTurnId, index, verdict });
    setPending(null);
    if ("error" in result) setMessage(result.error);
    else onConversation(result);
  }

  const unsent = conversation.feedback.filter((entry) => entry.sentInSeq === null).length;

  return (
    <div className="space-y-4">
      <UnitCard
        conversation={conversation}
        disabled={busy}
        onScope={(scope, unit) => onConversation({ scope, unit })}
      />

      <section aria-label="Likely causes" className="rounded-xl border border-white/10 bg-charcoal-900/70 p-4">
        <h2 className="text-base font-semibold text-ink">Likely causes</h2>
        {!reply || reply.likelyCauses.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            {reply ? "None yet. Tell Claude more about what the unit is doing." : "Claude's list shows here after its first reply."}
          </p>
        ) : (
          <ol className="mt-3 space-y-3">
            {reply.likelyCauses.map((cause, index) => (
              <CauseItem
                key={`${cause.title}-${index}`}
                cause={cause}
                rank={index + 1}
                verdict={verdictFor(conversation.feedback, cause.title)}
                pending={pending === index}
                onMark={(verdict) => void mark(index, verdict)}
              />
            ))}
          </ol>
        )}
        {unsent > 0 && (
          <p className="mt-3 text-xs text-ink-muted">Claude hears about your marks with your next message.</p>
        )}
        {message && (
          <p role="status" className="mt-2 text-sm text-trail">
            {message}
          </p>
        )}
      </section>

      {reply && reply.nextChecks.length > 0 && (
        <section aria-label="Next checks" className="rounded-xl border border-white/10 bg-charcoal-900/70 p-4">
          <h2 className="text-base font-semibold text-ink">Next checks</h2>
          <ol className="mt-3 list-decimal space-y-3 pl-5 marker:text-ink-muted">
            {reply.nextChecks.map((check, index) => (
              <CheckItem key={index} check={check} />
            ))}
          </ol>
        </section>
      )}

      {reply && reply.safetyNotes.length > 0 && (
        <section aria-label="Safety" className="rounded-xl border border-trail/30 bg-trail/10 p-4">
          <h2 className="text-base font-semibold text-trail">Safety</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-trail">
            {reply.safetyNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
