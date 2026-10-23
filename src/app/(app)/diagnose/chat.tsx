"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Badge, Notice, PageHeading } from "@/components/app/ui";
import { inputBaseClass, labelClass, primaryLinkClass } from "@/components/hud";
import {
  DIAGNOSE_LIMITS,
  formatCents,
  normalizeFaultCodes,
  type ConversationView,
  type ProgressStep,
  type StreamEvent,
  type TurnView,
  type UnitSuggestion,
} from "@/lib/diagnose-rules";
import type { Vehicle } from "@/lib/manual-catalog-rules";

import { Chevron, vehicleOptions } from "../library/search-form";
import { loadConversationAction, stopTurnAction } from "./actions";
import { CausesPanel } from "./causes-panel";
import { PlainText } from "./plain-text";
import { UnitPicker } from "./unit-picker";

// The Diagnose conversation: the thread of the tech's messages and Claude's
// replies, the box for the next message, and the causes panel. A new
// diagnosis starts here too, from the quick form or a typed message; once
// the server has saved it, the address becomes /diagnose/<id>.
//
// Messages go to /api/diagnose/turn, which streams NDJSON events back while
// Claude works. If that stream breaks, the server carries on, and the page
// polls the turn until it's done.

type Detail = { conversation: ConversationView; turns: TurnView[] };

export type StarterOptions = {
  vehicles: { vehicle: Vehicle; manuals: number }[];
  brands: { brand: string; manuals: number }[];
  years: number[];
  // Carrying on from a full conversation.
  carry: { id: string; unit: string | null; text: string } | null;
};

const POLL_MS = 2500;

const stopButtonClass =
  "inline-flex h-12 items-center justify-center rounded-lg border border-glow/30 px-5 text-base font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

function pluralTimes(count: number, what: string) {
  return count === 1 ? `${what} once` : `${what} ${count} times`;
}

// "Searched your manuals 3 times · read 2 pages · searched the web once".
function progressSummary(progress: ProgressStep[]) {
  const count = (kind: ProgressStep["kind"]) => progress.filter((step) => step.kind === kind).length;
  const reads = count("read");
  return [
    count("search") > 0 && pluralTimes(count("search"), "Searched your manuals"),
    reads > 0 && `read ${reads} ${reads === 1 ? "page" : "pages"}`,
    count("web") > 0 && pluralTimes(count("web"), "searched the web"),
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(/^./, (c) => c.toUpperCase());
}

function ProgressList({ steps, live }: { steps: ProgressStep[]; live: boolean }) {
  const shown = live ? steps : steps.filter((step) => step.kind !== "thinking" && step.kind !== "writing");
  return (
    <ol className="space-y-1 text-sm text-ink-muted" aria-live={live ? "polite" : undefined}>
      {shown.map((step, index) => {
        const current = live && index === shown.length - 1;
        return (
          <li key={`${step.at}-${index}`} className="flex items-start gap-2">
            <span
              aria-hidden
              className={`mt-2 size-1.5 shrink-0 rounded-full ${current ? "hud-pulse bg-glow" : "bg-glow/40"}`}
            />
            <span className={`break-words ${current ? "text-ink" : ""}`}>
              {step.label}
              {current ? "…" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function TurnBlock({
  turn,
  liveText,
  canRetry,
  onRetry,
  busy,
}: {
  turn: TurnView;
  liveText: string | null;
  canRetry: boolean;
  onRetry: () => void;
  busy: boolean;
}) {
  const running = turn.status === "running";
  const summary = progressSummary(turn.progress);
  return (
    <li className="space-y-3" data-turn={turn.seq} data-status={turn.status}>
      <div className="ml-auto max-w-[90%] rounded-xl rounded-br-sm border border-glow/20 bg-glow/10 px-4 py-3 sm:max-w-[80%]">
        <p className="mb-1 text-xs text-glow/80">{turn.userName || "Tech"}</p>
        <p className="text-sm leading-6 break-words whitespace-pre-line text-ink">{turn.techText}</p>
      </div>

      <div className="max-w-full rounded-xl rounded-bl-sm border border-white/10 bg-charcoal-900/70 px-4 py-3 sm:max-w-[92%]">
        <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span className="font-medium text-ink/90">Claude</span>
          {turn.costCents !== null && turn.status !== "running" && <span>≈ {formatCents(turn.costCents)}</span>}
        </p>
        {running ? (
          <div className="space-y-3">
            <ProgressList steps={turn.progress} live />
            {liveText && <PlainText text={liveText} className="opacity-80" />}
          </div>
        ) : turn.status === "done" && turn.reply ? (
          <div className="space-y-3">
            {summary && (
              <details className="text-xs text-ink-muted">
                <summary className="cursor-pointer hover:text-ink">{summary}</summary>
                <div className="mt-2">
                  <ProgressList steps={turn.progress} live={false} />
                </div>
              </details>
            )}
            <PlainText text={turn.reply.reply} />
            {turn.reply.questions.length > 0 && (
              <div className="rounded-lg border border-glow/20 bg-glow/5 px-3 py-2">
                <p className="text-xs font-medium text-glow">Claude asks</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-ink">
                  {turn.reply.questions.map((question, index) => (
                    <li key={index}>{question}</li>
                  ))}
                </ul>
              </div>
            )}
            {turn.reply.partial && (
              <p className="text-xs text-trail">
                Claude didn&apos;t finish its full answer for this message, so the causes and checks are from its
                last complete reply.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {turn.progress.length > 0 && <ProgressList steps={turn.progress} live={false} />}
            <p role="status" className="text-sm leading-6 text-trail">
              {turn.error ?? "This message didn't go through."}
            </p>
            {canRetry ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                className="inline-flex h-11 items-center rounded-lg border border-glow/40 px-4 text-sm font-medium text-glow transition hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60"
              >
                Retry
              </button>
            ) : (
              <p className="text-xs text-ink-muted">Not part of what Claude remembers.</p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// --- Starting -------------------------------------------------------------

type StartFields = {
  modelNumber: string;
  vehicle: string;
  year: string;
  model: string;
  complaint: string;
  faultCodes: string;
  checked: string;
  message: string;
};

function Starter({
  options,
  busy,
  onStart,
}: {
  options: StarterOptions;
  busy: boolean;
  onStart: (start: Record<string, string>) => Promise<boolean>;
}) {
  const [fields, setFields] = useState<StartFields>({
    modelNumber: "",
    vehicle: "",
    year: "",
    model: "",
    complaint: "",
    faultCodes: "",
    checked: "",
    message: options.carry?.text ?? "",
  });
  const [picked, setPicked] = useState<UnitSuggestion | null>(null);
  const [byVehicle, setByVehicle] = useState(false);
  const set = (name: keyof StartFields) => (value: string) => setFields((old) => ({ ...old, [name]: value }));
  const codes = normalizeFaultCodes(fields.faultCodes);
  const vehicles = vehicleOptions(options, fields.vehicle);
  const showFilters = options.vehicles.length > 0 || options.years.length > 0;

  function unitFields(): Record<string, string> {
    if (options.carry) return { from: options.carry.id };
    if (!byVehicle) return { modelNumber: fields.modelNumber.trim() };
    const vehicleIsLine = fields.vehicle !== "" && !["UTV", "ATV", "Generator", "Other"].includes(fields.vehicle);
    return {
      ...(vehicleIsLine ? { brand: fields.vehicle } : { vehicle: fields.vehicle }),
      year: fields.year,
      model: fields.model.trim(),
    };
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onStart({
      ...unitFields(),
      complaint: fields.complaint,
      faultCodes: fields.faultCodes,
      checked: fields.checked,
    });
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onStart({ ...(options.carry ? { from: options.carry.id } : {}), message: fields.message });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form
        onSubmit={submitForm}
        aria-label="Quick start"
        className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6"
      >
        <h2 className="text-base font-semibold text-ink">Quick start</h2>
        {options.carry ? (
          <p className="text-sm leading-6 text-ink-muted">
            Unit: <span className="text-ink">{options.carry.unit ?? "as before"}</span>, with the same manuals.
          </p>
        ) : !byVehicle ? (
          <div>
            <label htmlFor="start-model-number" className={labelClass}>
              Unit model number
            </label>
            <div className="mt-1.5">
              <UnitPicker
                id="start-model-number"
                value={fields.modelNumber}
                onChange={set("modelNumber")}
                picked={picked}
                onPick={setPicked}
              />
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">
              On the frame or VIN plate.{" "}
              {showFilters && (
                <button type="button" onClick={() => setByVehicle(true)} className="text-glow/90 hover:text-glow hover:underline">
                  No model number? Pick the vehicle instead.
                </button>
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="min-w-0">
                <label htmlFor="start-vehicle" className={labelClass}>
                  Vehicle
                </label>
                <div className="relative mt-1.5">
                  <select
                    id="start-vehicle"
                    value={fields.vehicle}
                    onChange={(event) => set("vehicle")(event.target.value)}
                    className={`${inputBaseClass} appearance-none truncate pr-10`}
                  >
                    <option value="">Any vehicle</option>
                    {vehicles.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </div>
              <div className="min-w-0">
                <label htmlFor="start-year" className={labelClass}>
                  Year
                </label>
                <div className="relative mt-1.5">
                  <select
                    id="start-year"
                    value={fields.year}
                    onChange={(event) => set("year")(event.target.value)}
                    className={`${inputBaseClass} appearance-none pr-10`}
                  >
                    <option value="">Any year</option>
                    {options.years.map((year) => (
                      <option key={year} value={String(year)}>
                        {year}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </div>
              <div className="min-w-0">
                <label htmlFor="start-model" className={labelClass}>
                  Model
                </label>
                <input
                  id="start-model"
                  value={fields.model}
                  onChange={(event) => set("model")(event.target.value)}
                  placeholder="RZR XP 1000"
                  autoComplete="off"
                  maxLength={60}
                  className={`mt-1.5 ${inputBaseClass}`}
                />
              </div>
            </div>
            <button type="button" onClick={() => setByVehicle(false)} className="text-xs text-glow/90 hover:text-glow hover:underline">
              Use the model number instead
            </button>
          </div>
        )}

        <div>
          <label htmlFor="start-complaint" className={labelClass}>
            Complaint
          </label>
          <textarea
            id="start-complaint"
            value={fields.complaint}
            onChange={(event) => set("complaint")(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Misfires under load, worse when hot"
            className={`mt-1.5 ${inputBaseClass} h-auto py-3`}
          />
        </div>
        <div>
          <label htmlFor="start-codes" className={labelClass}>
            Fault codes
          </label>
          <input
            id="start-codes"
            value={fields.faultCodes}
            onChange={(event) => set("faultCodes")(event.target.value)}
            placeholder="P0300, P0301"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={400}
            aria-describedby="start-codes-seen"
            className={`mt-1.5 ${inputBaseClass}`}
          />
          <p id="start-codes-seen" className="mt-1.5 flex flex-wrap gap-1.5" aria-live="polite">
            {codes.map((code) => (
              <span key={code} className="rounded-full bg-white/5 px-2.5 py-0.5 font-mono text-xs text-ink">
                {code}
              </span>
            ))}
          </p>
        </div>
        <div>
          <label htmlFor="start-checked" className={labelClass}>
            What&apos;s been checked
          </label>
          <textarea
            id="start-checked"
            value={fields.checked}
            onChange={(event) => set("checked")(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="New plugs, battery tested good"
            className={`mt-1.5 ${inputBaseClass} h-auto py-3`}
          />
        </div>
        <button type="submit" disabled={busy || (!fields.complaint.trim() && codes.length === 0)} className={primaryLinkClass}>
          Start diagnosis
        </button>
      </form>

      <form
        onSubmit={submitMessage}
        aria-label="Just type it"
        className="flex flex-col gap-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6"
      >
        <h2 className="text-base font-semibold text-ink">Or just type it</h2>
        <label htmlFor="start-message" className="sr-only">
          Describe the unit and the problem
        </label>
        <textarea
          id="start-message"
          value={fields.message}
          onChange={(event) => set("message")(event.target.value)}
          rows={8}
          maxLength={DIAGNOSE_LIMITS.techText}
          placeholder="2019 RZR XP 1000, misfire under load, P0300. Plugs are new."
          className={`${inputBaseClass} h-auto flex-1 py-3`}
        />
        <button type="submit" disabled={busy || !fields.message.trim()} className={primaryLinkClass}>
          Send to Claude
        </button>
      </form>
    </div>
  );
}

// --- The conversation -----------------------------------------------------

export function DiagnoseChat({
  initial,
  starter,
}: {
  initial: Detail | null;
  starter: StarterOptions | null;
}) {
  const [conversation, setConversation] = useState<ConversationView | null>(initial?.conversation ?? null);
  const [turns, setTurns] = useState<TurnView[]>(initial?.turns ?? []);
  const [live, setLive] = useState<{ turnId: string; text: string } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [stopping, setStopping] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const running = turns.find((turn) => turn.status === "running") ?? null;
  const busy = streaming || running !== null;
  const replyTurn = turns.findLast((turn) => turn.status === "done" && turn.reply) ?? null;
  const lastTurn = turns.at(-1) ?? null;

  function upsertTurn(turn: TurnView) {
    setTurns((old) => (old.some((t) => t.id === turn.id) ? old.map((t) => (t.id === turn.id ? turn : t)) : [...old, turn]));
  }

  function apply(event: StreamEvent) {
    switch (event.type) {
      case "start":
        if (!conversation) window.history.replaceState(null, "", `/diagnose/${event.conversation.id}`);
        setConversation(event.conversation);
        upsertTurn(event.turn);
        setDraft("");
        setLive({ turnId: event.turn.id, text: "" });
        requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
        break;
      case "progress":
        setTurns((old) =>
          old.map((turn) => (turn.status === "running" ? { ...turn, progress: [...turn.progress, event.step] } : turn)),
        );
        break;
      case "reply":
        setLive((old) => (old ? { ...old, text: event.text } : old));
        break;
      case "scope":
        setConversation((old) => (old ? { ...old, scope: event.scope, unit: event.scope.label ?? old.unit } : old));
        break;
      case "end":
        setConversation(event.conversation);
        upsertTurn(event.turn);
        setLive(null);
        break;
    }
  }

  async function send(body: Record<string, unknown>): Promise<boolean> {
    setStreaming(true);
    setNotice(null);
    setStopping(false);
    try {
      const response = await fetch("/api/diagnose/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => null)) as { error?: string; redirectTo?: string } | null;
        if (data?.redirectTo) {
          window.location.assign(data.redirectTo);
          return false;
        }
        setNotice(data?.error ?? "That didn't go through. Check the connection and try again.");
        // A message is running here that this tab doesn't know about (sent
        // from another tab or tablet), or this view is out of date: load the
        // conversation as it is now, and the poll below follows the running
        // message. The draft stays in the box.
        if (response.status === 409 && conversation) {
          const detail = await loadConversationAction(conversation.id).catch(() => null);
          if (detail && !("error" in detail)) {
            setConversation(detail.conversation);
            setTurns(detail.turns);
          }
        }
        return false;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) apply(JSON.parse(line) as StreamEvent);
        }
      }
      return true;
    } catch {
      // The connection dropped part way. The server carries on; the poll
      // below picks the turn up.
      return true;
    } finally {
      setStreaming(false);
    }
  }

  // A turn running without this tab streaming it: ask how it's going.
  const runningId = running?.id;
  const conversationId = conversation?.id;
  useEffect(() => {
    if (!runningId || streaming || !conversationId) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/diagnose/turns/${runningId}`, { cache: "no-store" });
        const data = (await response.json()) as { turn?: TurnView };
        if (stopped || !data.turn) return;
        if (data.turn.status === "running") {
          const turn = data.turn;
          setTurns((old) => old.map((t) => (t.id === turn.id ? turn : t)));
          return;
        }
        const detail = await loadConversationAction(conversationId);
        if (stopped || "error" in detail) return;
        setConversation(detail.conversation);
        setTurns(detail.turns);
        setLive(null);
      } catch {
        // Offline for a moment; try again next time.
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runningId, streaming, conversationId]);

  async function stop() {
    if (!running) return;
    setStopping(true);
    const result = await stopTurnAction(running.id);
    if ("error" in result) {
      setNotice(result.error);
      setStopping(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversation || !draft.trim() || busy) return;
    void send({ conversationId: conversation.id, text: draft });
  }

  if (!conversation) {
    return (
      <div className="space-y-6">
        <div>
          <Link href="/diagnose" className="text-sm text-glow/90 hover:text-glow hover:underline">
            ‹ Diagnose
          </Link>
          <PageHeading
            title="New diagnosis"
            description="Give Claude the unit and what it's doing. It finds the unit's manuals, searches them and the web, and works through it with you."
          />
        </div>
        {notice && <Notice tone="trail">{notice}</Notice>}
        {starter && <Starter options={starter} busy={streaming} onStart={(start) => send({ start })} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link href="/diagnose" className="text-sm text-glow/90 hover:text-glow hover:underline">
            ‹ Diagnose
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight break-words text-ink">{conversation.title}</h1>
          {conversation.unit && <p className="text-sm text-ink-muted">{conversation.unit}</p>}
        </div>
        {conversation.outcome ? (
          <Badge tone="glow">Solved: {conversation.outcome.title}</Badge>
        ) : (
          <Badge>Open</Badge>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label="Conversation" className="min-w-0 space-y-4">
          <ol className="space-y-6">
            {turns.map((turn) => (
              <TurnBlock
                key={turn.id}
                turn={turn}
                liveText={live?.turnId === turn.id ? live.text : null}
                canRetry={turn.id === lastTurn?.id && (turn.status === "failed" || turn.status === "stopped")}
                onRetry={() => void send({ conversationId: conversation.id, retryTurnId: turn.id })}
                busy={busy}
              />
            ))}
          </ol>
          <div ref={bottom} />

          {notice && <Notice tone="trail">{notice}</Notice>}

          {conversation.full ? (
            <Notice tone="trail" live={false}>
              {conversation.full}{" "}
              <Link href={`/diagnose/new?from=${conversation.id}`} className="font-medium underline">
                Start a new diagnosis for this unit
              </Link>
            </Notice>
          ) : (
            <MessageBox
              draft={draft}
              setDraft={setDraft}
              onSubmit={submit}
              busy={busy}
              action={
                running ? (
                  <button type="button" onClick={() => void stop()} disabled={stopping} className={stopButtonClass}>
                    {stopping ? "Stopping…" : "Stop"}
                  </button>
                ) : null
              }
            />
          )}
        </section>

        <aside aria-label="Diagnosis" className="min-w-0">
          <CausesPanel
            conversation={conversation}
            reply={replyTurn?.reply ?? null}
            replyTurnId={replyTurn?.id ?? null}
            busy={busy}
            onConversation={(update) => setConversation((old) => (old ? { ...old, ...update } : old))}
          />
        </aside>
      </div>
    </div>
  );
}

function MessageBox({
  draft,
  setDraft,
  onSubmit,
  busy,
  action,
}: {
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  action: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} aria-label="Message Claude" className="space-y-2">
      <label htmlFor="diagnose-message" className="sr-only">
        Message Claude
      </label>
      <textarea
        id="diagnose-message"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter starts a new line.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        rows={3}
        maxLength={DIAGNOSE_LIMITS.techText}
        placeholder="What did you find? Ask a follow-up…"
        className={`${inputBaseClass} h-auto py-3`}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {action}
        <button type="submit" disabled={busy || !draft.trim()} className={primaryLinkClass}>
          Send
        </button>
      </div>
    </form>
  );
}
