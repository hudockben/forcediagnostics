"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";

import { Badge, Notice, PageHeading } from "@/components/app/ui";
import { inputBaseClass, labelClass, primaryLinkClass } from "@/components/hud";
import {
  conversationCustomer,
  diagnoseStartFields,
  type ConversationCustomer,
  type CustomerVehicleChoice,
} from "@/lib/customer-rules";
import { addAsk } from "@/lib/diagnose-cause-steps";
import {
  DIAGNOSE_LIMITS,
  activityCounts,
  addQuote,
  chatNews as chatNewsFor,
  normalizeFaultCodes,
  openingRows,
  type ConversationView,
  type ProgressStep,
  type StreamEvent,
  type TurnView,
  type UnitSuggestion,
  type VinPreview,
} from "@/lib/diagnose-rules";
import { claudeSummary, openTurnIds, techSummary } from "@/lib/diagnose-thread";
import type { Vehicle } from "@/lib/manual-catalog-rules";
import { VIN_LENGTH, checkVin, vinDisagreement } from "@/lib/vin";

import { Chevron, vehicleOptions } from "../library/search-form";
import { loadConversationAction, previewVinAction, stopTurnAction } from "./actions";
import { CausesPanel } from "./causes-panel";
import { CustomerLine, CustomerName, CustomerVehiclePicker } from "./customer-picker";
import {
  CausesIcon,
  ChatIcon,
  CheckIcon,
  ChevronIcon,
  GlobeIcon,
  InfoIcon,
  PageIcon,
  PersonIcon,
  ReplyIcon,
  SearchIcon,
  WarningIcon,
  WorkingIcon,
} from "./icons";
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
  carry: { id: string; unit: string | null; customer: ConversationCustomer | null; text: string } | null;
  // A customer's vehicle to start with (Start a diagnosis on its record).
  customer: CustomerVehicleChoice | null;
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
              className={`mt-2 size-1.5 shrink-0 rounded-full ${current ? "bg-glow" : "bg-glow/40"}`}
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

// What Claude looked at, as small chips; tap them for the steps.
function ActivityChips({ progress }: { progress: ProgressStep[] }) {
  const summary = progressSummary(progress);
  if (!summary) return null;
  const counts = activityCounts(progress);
  const chips = [
    { kind: "search", count: counts.searches, icon: <SearchIcon className="size-3.5" />, title: "Manual searches" },
    { kind: "read", count: counts.pages, icon: <PageIcon className="size-3.5" />, title: "Manual pages read" },
    { kind: "web", count: counts.web, icon: <GlobeIcon className="size-3.5" />, title: "Web searches" },
  ].filter((chip) => chip.count > 0);
  return (
    <details className="group text-xs text-ink-muted">
      <summary
        aria-label={`${summary}. Show the steps.`}
        className="-my-1.5 inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-full hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none [&::-webkit-details-marker]:hidden"
      >
        {chips.map((chip) => (
          <span
            key={chip.kind}
            data-activity={chip.kind}
            title={chip.title}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2 font-mono text-[11px] tabular-nums"
          >
            {chip.icon}
            {chip.count}
          </span>
        ))}
        <ChevronIcon className="size-3.5 transition group-open:rotate-180" />
      </summary>
      <div className="mt-2">
        <ProgressList steps={progress} live={false} />
      </div>
    </details>
  );
}

const OPENING_SHORT: Record<string, string> = {
  Unit: "Unit",
  VIN: "VIN",
  "Partial VIN": "VIN",
  Complaint: "Complaint",
  "Fault codes": "Codes",
  "Already checked": "Checked",
};

// The tech's text: the quick form's opening as labelled rows, and quoted
// lines ("> …", from tapping one of Claude's questions) set apart.
function TechText({ turn }: { turn: TurnView }) {
  const opening = turn.seq === 1 ? openingRows(turn.techText) : null;
  if (opening) {
    return (
      <div className="space-y-2">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm leading-5">
          {opening.rows.map((row) => (
            <Fragment key={row.label}>
              <dt className="pt-[1px] text-xs font-medium text-ink-muted">{OPENING_SHORT[row.label]}</dt>
              <dd className="min-w-0 break-words text-ink" data-opening={row.label}>
                {row.label === "VIN" ? (
                  <span className="font-mono tracking-wide break-all">{row.value}</span>
                ) : row.label === "Partial VIN" ? (
                  <PartialVin value={row.value} />
                ) : row.label === "Fault codes" ? (
                  <span className="flex flex-wrap gap-1">
                    {row.value.split(/,\s*/).map((code) => (
                      <span key={code} className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-ink">
                        {code}
                      </span>
                    ))}
                  </span>
                ) : (
                  row.value
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
        {opening.more && <QuotedText text={opening.more} />}
      </div>
    );
  }
  return <QuotedText text={turn.techText} />;
}

// "MA765432 (8 of 17 characters)": part of a VIN, as the tech typed it.
function PartialVin({ value }: { value: string }) {
  const match = /^(\S+)\s*\((\d+) of 17 characters\)$/.exec(value);
  return (
    <span>
      <span className="font-mono tracking-wide break-all">{match ? match[1] : value}</span>
      {match && <span className="text-ink-muted"> · part of a VIN, {match[2]} of 17 characters</span>}
    </span>
  );
}

function QuotedText({ text }: { text: string }) {
  const blocks: { quote: boolean; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const quote = line.startsWith("> ");
    const last = blocks.at(-1);
    if (last && last.quote === quote) last.lines.push(quote ? line.slice(2) : line);
    else blocks.push({ quote, lines: [quote ? line.slice(2) : line] });
  }
  return (
    <div className="space-y-1.5 text-sm leading-6 break-words text-ink">
      {blocks.map((block, index) =>
        !block.quote && !block.lines.join("").trim() ? null : block.quote ? (
          <blockquote key={index} className="border-l-2 border-glow/40 pl-2.5 whitespace-pre-line text-ink-muted">
            {block.lines.join("\n")}
          </blockquote>
        ) : (
          <p key={index} className="whitespace-pre-line">
            {block.lines.join("\n").trim()}
          </p>
        ),
      )}
    </div>
  );
}

// The thread's cards (the tech's message, Claude's reply) and the folded
// exchanges: the column's full width, one padding, one corner.
const threadCardClass = "w-full rounded-xl border px-4 py-3";

// An earlier exchange in one line: the tech's first line and Claude's
// count of causes and the likeliest, opened with a tap.
function FoldedTurn({ turn, onOpen }: { turn: TurnView; onOpen: () => void }) {
  return (
    <li data-turn={turn.seq} data-status={turn.status} data-folded>
      <button
        type="button"
        aria-expanded={false}
        onClick={onOpen}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-white/10 bg-charcoal-900/50 px-4 py-1.5 text-left text-sm transition hover:border-glow/30 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        <ChevronIcon className="size-4 shrink-0 -rotate-90 text-ink-muted" />
        <span className="min-w-0 flex-1 leading-5">
          <span className="block truncate">
            <span className="font-medium text-ink/80">{turn.userName || "Tech"}:</span> <span className="text-ink">{techSummary(turn)}</span>
          </span>
          <span className="block truncate text-ink-muted">
            <span className="font-medium text-ink/80">Claude:</span> {claudeSummary(turn)}
          </span>
        </span>
      </button>
    </li>
  );
}

function TurnBlock({
  turn,
  liveText,
  canRetry,
  onRetry,
  busy,
  onQuote,
  onShowDiagnosis,
  onFold,
}: {
  turn: TurnView;
  liveText: string | null;
  canRetry: boolean;
  onRetry: () => void;
  busy: boolean;
  onQuote: ((question: string) => void) | null;
  onShowDiagnosis: (() => void) | null;
  // Opened from its one line: folds back.
  onFold: (() => void) | null;
}) {
  const running = turn.status === "running";
  return (
    <li className="space-y-3" data-turn={turn.seq} data-status={turn.status}>
      {onFold && (
        <button
          type="button"
          aria-expanded
          onClick={onFold}
          className="-mb-1 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          <ChevronIcon className="size-3.5" />
          Fold
        </button>
      )}
      {/* The tech's card and Claude's share the column's edges and padding;
          the tech's is told apart by a bar down its left side (drawn inside
          the card, so the edges stay put), the person mark by their name and
          a lighter fill, not by an offset like a chat bubble's. */}
      <div
        data-card="tech"
        className={`${threadCardClass} border-white/[0.14] bg-white/[0.07] shadow-[inset_3px_0_0_var(--color-ink-muted)]`}
      >
        <div className="mb-1.5 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
          <span data-person className="flex items-center gap-1.5 text-sm font-semibold text-ink/85">
            <PersonIcon className="size-3.5 text-ink-muted" />
            {turn.userName || "Tech"}
          </span>
        </div>
        <TechText turn={turn} />
      </div>

      <div data-card="claude" className={`${threadCardClass} border-white/10 bg-charcoal-900/70`}>
        <div className="mb-1.5 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-ink">Claude</span>
          {turn.status === "done" && turn.reply && <ActivityChips progress={turn.progress} />}
        </div>
        {running ? (
          <div className="space-y-3">
            <ProgressList steps={turn.progress} live />
            {liveText && <PlainText text={liveText} className="opacity-80" />}
          </div>
        ) : turn.status === "done" && turn.reply ? (
          <div className="space-y-3">
            <PlainText text={turn.reply.reply} />
            {turn.reply.questions.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-glow">Claude asks</p>
                <ul className="flex flex-col gap-1.5">
                  {turn.reply.questions.map((question, index) => (
                    <li key={index}>
                      {onQuote ? (
                        <button
                          type="button"
                          data-question={index}
                          onClick={() => onQuote(question)}
                          title="Answer this"
                          className="flex min-h-11 w-full items-start gap-2 rounded-lg border border-glow/25 bg-glow/5 px-3 py-2 text-left text-sm leading-6 text-ink transition hover:border-glow/45 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
                        >
                          <ReplyIcon className="mt-1 size-4 text-glow" />
                          <span className="min-w-0 break-words">{question}</span>
                        </button>
                      ) : (
                        <p className="rounded-lg border border-glow/20 bg-glow/5 px-3 py-2 text-sm leading-6 text-ink">{question}</p>
                      )}
                    </li>
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
            {onShowDiagnosis && (
              <button
                type="button"
                onClick={onShowDiagnosis}
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-glow/40 bg-glow/10 px-3 text-sm font-medium text-glow transition hover:bg-glow/15 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none lg:hidden"
              >
                <CausesIcon />
                See the diagnosis
              </button>
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
  vin: string;
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
  // A customer's vehicle from its record fills in its model number and
  // VIN, or with no model number its year and model as the Model.
  const startFields = options.customer ? diagnoseStartFields(options.customer) : null;
  const [fields, setFields] = useState<StartFields>({
    modelNumber: startFields?.modelNumber ?? "",
    vin: startFields?.vin ?? "",
    vehicle: "",
    year: "",
    model: startFields?.model ?? "",
    complaint: "",
    faultCodes: "",
    checked: "",
    message: options.carry?.text ?? "",
  });
  const [picked, setPicked] = useState<UnitSuggestion | null>(null);
  const [byVehicle, setByVehicle] = useState(Boolean(startFields && !startFields.modelNumber && startFields.model));
  // The customer's vehicle it's for, if any; a carried-on diagnosis keeps
  // the earlier one's unless it's changed here.
  const [customer, setCustomer] = useState<ConversationCustomer | null>(
    options.customer ? conversationCustomer(options.customer) : (options.carry?.customer ?? null),
  );
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const set = (name: keyof StartFields) => (value: string) => setFields((old) => ({ ...old, [name]: value }));
  const codes = normalizeFaultCodes(fields.faultCodes);
  const vin = checkVin(fields.vin);
  // Only what can't be a VIN (I, O or Q, too long) holds the start up; part
  // of one (the last digits) goes with the diagnosis as a note, and a wrong
  // check digit is only a warning.
  const vinBlocks = vin.status === "invalid" && !options.carry;
  // While it's being typed, a short VIN only counts its characters.
  const [vinFocused, setVinFocused] = useState(false);
  // A VIN typed or pasted in the model number box goes to the VIN box.
  const [movedVin, setMovedVin] = useState(false);
  // What the VIN finds in the shop's model list, looked up as it's typed.
  const [preview, setPreview] = useState<{ vin: string; found: VinPreview | null } | null>(null);
  const vehicles = vehicleOptions(options, fields.vehicle);
  const showFilters = options.vehicles.length > 0 || options.years.length > 0;
  const okVin = vin.status === "ok" ? vin.vin : null;
  const typedNumber = !byVehicle ? (picked?.modelNumber ?? fields.modelNumber.trim()) : "";
  const disagreement = okVin && typedNumber ? vinDisagreement(okVin, typedNumber) : null;
  const vehiclePicked = byVehicle && Boolean(fields.vehicle || fields.year || fields.model.trim());

  useEffect(() => {
    if (!okVin || options.carry) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await previewVinAction(okVin);
      if (!cancelled) setPreview({ vin: okVin, found });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [okVin, options.carry]);

  function setModelNumber(value: string) {
    const asVin = checkVin(value);
    // Into an empty VIN box, or over the same VIN or its last digits.
    const fits = vin.status === "empty" || ((vin.status === "ok" || vin.status === "partial") && asVin.status === "ok" && asVin.vin.endsWith(vin.vin));
    if (asVin.status === "ok" && fits) {
      setFields((old) => ({ ...old, modelNumber: "", vin: asVin.vin }));
      setMovedVin(true);
      return;
    }
    setMovedVin(false);
    set("modelNumber")(value);
  }

  function pickCustomer(choice: CustomerVehicleChoice) {
    setCustomer(conversationCustomer(choice));
    setPickingCustomer(false);
    // A carried-on diagnosis keeps its unit and manuals.
    if (options.carry) return;
    const start = diagnoseStartFields(choice);
    setMovedVin(false);
    if (start.modelNumber) {
      setByVehicle(false);
      setPicked(null);
      setFields((old) => ({ ...old, modelNumber: start.modelNumber, vin: start.vin || old.vin }));
    } else if (start.model) {
      setByVehicle(true);
      setFields((old) => ({ ...old, vehicle: "", year: "", model: start.model, vin: start.vin || old.vin }));
    } else if (start.vin) {
      setFields((old) => ({ ...old, vin: start.vin }));
    }
  }

  // Sent with either form: "" for none.
  const customerField = { customerVehicle: customer?.vehicleId ?? "" };

  function unitFields(): Record<string, string> {
    if (options.carry) return { from: options.carry.id };
    const vinField: Record<string, string> = vin.status === "ok" || vin.status === "partial" ? { vin: vin.vin } : {};
    if (!byVehicle) return { modelNumber: fields.modelNumber.trim(), ...vinField };
    const vehicleIsLine = fields.vehicle !== "" && !["UTV", "ATV", "Generator", "Other"].includes(fields.vehicle);
    return {
      ...(vehicleIsLine ? { brand: fields.vehicle } : { vehicle: fields.vehicle }),
      year: fields.year,
      model: fields.model.trim(),
      ...vinField,
    };
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (vinBlocks) return;
    void onStart({
      ...unitFields(),
      ...customerField,
      complaint: fields.complaint,
      faultCodes: fields.faultCodes,
      checked: fields.checked,
    });
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onStart({ ...(options.carry ? { from: options.carry.id } : {}), ...customerField, message: fields.message });
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="start-customer-label"
        data-start-customer
        className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="start-customer-label" className="text-base font-semibold text-ink">
            Customer&apos;s vehicle <span className="text-sm font-normal text-ink-muted">(optional)</span>
          </h2>
          {customer && !pickingCustomer && (
            <span className="flex gap-1">
              <button type="button" onClick={() => setPickingCustomer(true)} className="min-h-11 rounded-lg px-2 text-sm font-medium text-glow/90 hover:text-glow hover:underline">
                Change
              </button>
              <button type="button" onClick={() => setCustomer(null)} className="min-h-11 rounded-lg px-2 text-sm text-ink-muted hover:text-ink">
                Remove
              </button>
            </span>
          )}
        </div>
        {customer && !pickingCustomer ? (
          <p className="mt-1 text-sm leading-6 break-words" data-start-customer-picked>
            <CustomerName customer={customer} canOpen={false} />
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            <label htmlFor="start-customer" className="sr-only">
              Find the customer&apos;s vehicle
            </label>
            <CustomerVehiclePicker id="start-customer" autoFocus={pickingCustomer} onPick={pickCustomer} />
            <p className="text-xs leading-5 text-ink-muted">
              Ties this diagnosis and its fix to the customer&apos;s record.{" "}
              {options.carry ? "" : "Picking one fills in its model number and VIN."}
              {customer && (
                <>
                  {" "}
                  <button type="button" onClick={() => setPickingCustomer(false)} className="text-glow/90 hover:text-glow hover:underline">
                    Keep {customer.customerName}
                  </button>
                </>
              )}
            </p>
          </div>
        )}
      </section>
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
                  onChange={setModelNumber}
                  picked={picked}
                  onPick={setPicked}
                />
              </div>
              {movedVin && (
                <p role="status" data-vin-moved className="mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-glow">
                  <CheckIcon className="mt-0.5 size-3.5" />
                  That&apos;s the VIN: it&apos;s in the VIN box below now.
                </p>
              )}
              <p className="mt-1.5 text-xs text-ink-muted">
                On the frame or VIN plate (Z19VDE99AM, not the 17-character VIN).{" "}
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

          {!options.carry && (
            <div>
              <label htmlFor="start-vin" className={labelClass}>
                VIN <span className="font-normal text-ink-muted">(optional)</span>
              </label>
              <input
                id="start-vin"
                value={fields.vin}
                onChange={(event) => {
                  setMovedVin(false);
                  set("vin")(event.target.value);
                }}
                onFocus={() => setVinFocused(true)}
                onBlur={() => setVinFocused(false)}
                placeholder="17 characters, from the frame"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                maxLength={40}
                aria-invalid={vinBlocks}
                aria-describedby={vinBlocks ? "start-vin-note start-blocked" : "start-vin-note"}
                // Something that isn't a VIN gets an amber edge: it's the one
                // thing here that holds the start up.
                className={`mt-1.5 ${
                  vinBlocks
                    ? inputBaseClass.replace("border-white/10", "border-trail/80").replace("focus:border-glow/60", "focus:border-trail").replace("focus:ring-glow/25", "focus:ring-trail/30")
                    : inputBaseClass
                } font-mono tracking-wide uppercase placeholder:font-sans placeholder:tracking-normal placeholder:normal-case`}
              />
              <VinNote
                check={vin}
                typing={vinFocused}
                preview={okVin && preview?.vin === okVin ? preview.found : undefined}
                disagreement={disagreement}
                vehiclePicked={vehiclePicked}
              />
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="submit"
              disabled={busy || (!fields.complaint.trim() && codes.length === 0) || vinBlocks}
              aria-describedby={vinBlocks ? "start-blocked" : undefined}
              className={primaryLinkClass}
            >
              Start diagnosis
            </button>
            {vinBlocks && (
              <p id="start-blocked" role="status" className="flex items-center gap-1.5 text-sm font-medium text-trail">
                <WarningIcon className="size-4" />
                Fix or clear the VIN to start.
              </p>
            )}
          </div>
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
    </div>
  );
}

// Under the VIN box: what to type, how far along it is, that it's a VIN
// and what it finds in the shop's model list, or what's wrong. Three looks
// for three outcomes: part of a VIN (the last digits) is only information
// and goes with the diagnosis as a note; a wrong check digit, or a model
// number for another model, is an amber warning that doesn't stop the
// start; only something that can't be a VIN (I, O or Q, too long) holds it
// up, with an amber edge on the box and the reason beside Start.
function VinNote({
  check,
  typing,
  preview,
  disagreement,
  vehiclePicked,
}: {
  check: ReturnType<typeof checkVin>;
  typing: boolean;
  // What the VIN finds: undefined while it's being looked up.
  preview?: VinPreview | null;
  disagreement: string | null;
  vehiclePicked: boolean;
}) {
  const base = "mt-1.5 flex items-start gap-1.5 text-xs leading-5";
  let note: ReactNode;
  if (check.status === "empty") {
    note = <span className="text-ink-muted">On the frame or VIN plate. It finds the model (not the paint) when the shop&apos;s model list has it.</span>;
  } else if (check.status === "partial" && typing) {
    note = (
      <span className="text-ink-muted tabular-nums">
        {check.vin.length} of {VIN_LENGTH} characters
      </span>
    );
  } else if (check.status === "partial") {
    note = (
      <>
        <InfoIcon className="mt-0.5 size-3.5 text-ink-muted" />
        <span className="text-ink-muted">
          {check.message} It goes with the diagnosis as a note, but won&apos;t find the unit.
        </span>
      </>
    );
  } else if (check.status === "invalid") {
    note = (
      <>
        <WarningIcon className="mt-0.5 size-3.5 text-trail" />
        <span className="font-medium text-trail">Not a VIN: {check.message}</span>
      </>
    );
  } else if (check.status === "ok" && check.warning) {
    note = (
      <>
        <WarningIcon className="mt-0.5 size-3.5 text-trail" />
        <span className="text-trail">{check.warning} You can still start.</span>
      </>
    );
  } else if (check.status === "ok") {
    note = (
      <>
        <CheckIcon className="mt-0.5 size-3.5 text-glow" />
        <span className="text-ink-muted">
          <span className="font-mono tracking-wide text-ink">{check.vin}</span> · check digit matches
        </span>
      </>
    );
  }
  const status = check.status === "ok" ? (check.checkDigitOk ? "ok" : "warning") : check.status;
  return (
    <div aria-live="polite">
      <p id="start-vin-note" data-vin-status={status} className={base}>
        {note}
      </p>
      {check.status === "ok" && <VinMatch preview={preview} vehiclePicked={vehiclePicked} />}
      {disagreement && (
        <p data-vin-disagree className={`${base} text-trail`}>
          <WarningIcon className="mt-0.5 size-3.5" />
          <span>{disagreement}</span>
        </p>
      )}
    </div>
  );
}

// What a whole VIN finds in the shop's model list, before the start.
function VinMatch({ preview, vehiclePicked }: { preview: VinPreview | null | undefined; vehiclePicked: boolean }) {
  const base = "mt-1 flex items-start gap-1.5 text-xs leading-5";
  if (preview === undefined) return <p data-vin-match="looking" className={`${base} text-ink-muted`}>Looking in the model list…</p>;
  if (preview === null) return null;
  const instead = vehiclePicked ? " The VIN decides the unit, not the vehicle picked above." : "";
  if (preview.status === "found") {
    const manuals = `${preview.manuals} ${preview.manuals === 1 ? "manual" : "manuals"}`;
    return (
      <p data-vin-match="found" className={`${base} text-glow`}>
        <span>
          {preview.models > 1 ? `Matches ${preview.models} variants of ${preview.label}` : `Matches ${preview.label}`} · {manuals}
          {instead}
        </span>
      </p>
    );
  }
  if (preview.status === "listed") {
    return (
      <p data-vin-match="listed" className={`${base} text-ink-muted`}>
        <span>
          Matches {preview.label} in the model list, but the shop has no manual for it: Claude will search the whole library.{instead}
        </span>
      </p>
    );
  }
  if (preview.status === "many") {
    return (
      <p data-vin-match="many" className={`${base} text-ink-muted`}>
        <span>
          Matches {preview.models} models with {preview.manuals} manuals, too many to narrow the search to.
        </span>
      </p>
    );
  }
  return (
    <p data-vin-match="none" className={`${base} text-ink-muted`}>
      <span>No model in the shop&apos;s list has this VIN&apos;s model code: it goes with the diagnosis as information.</span>
    </p>
  );
}

// --- The conversation -----------------------------------------------------

// New diagnosis. Next keeps the page in <Activity> when someone moves on and
// shows the same instance again when they come back; once a diagnosis has
// started here, that instance is the conversation (under its own address).
// bfcacheId changes when they follow a link to New diagnosis, so the next
// unit gets the quick form rather than joining the last unit's conversation;
// it stays the same for Back and Forward, which find that conversation as it
// was. "Start a new diagnosis for this unit" from a conversation started here
// only changes ?from=, which keeps bfcacheId, so the carried one is in the key.
// Start a diagnosis on a customer's vehicle only changes ?vehicle=, so the
// vehicle is in the key too.
export function NewDiagnosisChat({ starter, customerLinks }: { starter: StarterOptions; customerLinks: boolean }) {
  const { bfcacheId } = useRouter();
  return (
    <DiagnoseChat
      key={`${bfcacheId}:${starter.carry?.id ?? ""}:${starter.customer?.vehicleId ?? ""}`}
      initial={null}
      starter={starter}
      customerLinks={customerLinks}
    />
  );
}

export function DiagnoseChat({
  initial,
  starter,
  customerLinks,
}: {
  initial: Detail | null;
  starter: StarterOptions | null;
  // Whether the viewer can open customers' records (System Admin >
  // Customers), so the customer's name links to theirs.
  customerLinks: boolean;
}) {
  const [conversation, setConversation] = useState<ConversationView | null>(initial?.conversation ?? null);
  const [turns, setTurns] = useState<TurnView[]>(initial?.turns ?? []);
  const [live, setLive] = useState<{ turnId: string; text: string } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [stopping, setStopping] = useState(false);
  // A conversation's page stays in <Activity> too: coming back to it by a
  // link shows the same instance, with the server's fresh copy as `initial`.
  // Take that copy, which has whatever another tablet or tab sent since; the
  // draft and the tab stay. Back and Forward bring back the copy already
  // taken, which changes nothing. One with fewer messages than the screen
  // isn't newer, and while this tab streams a message the stream is.
  const [taken, setTaken] = useState(initial);
  if (initial !== taken) {
    setTaken(initial);
    if (initial && !streaming && initial.turns.length >= turns.length) {
      setConversation(initial.conversation);
      setTurns(initial.turns);
    }
  }
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Earlier exchanges the tech opened from their one line (by id); the
  // latest is always open (openTurnIds).
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  // The page takes the screen's width (data-wide-page; see the app layout)
  // only while it's shown: when Next keeps it hidden after a navigation
  // (Activity runs layout effects' cleanups then), the marker comes off, so
  // the page now on screen isn't stretched too.
  const widePage = useRef<HTMLDivElement>(null);
  const hasConversation = conversation !== null;
  useLayoutEffect(() => {
    const element = widePage.current;
    element?.setAttribute("data-wide-page", "");
    return () => element?.removeAttribute("data-wide-page");
  }, [hasConversation]);

  const running = turns.find((turn) => turn.status === "running") ?? null;
  const busy = streaming || running !== null;
  const replyTurn = turns.findLast((turn) => turn.status === "done" && turn.reply) ?? null;
  const lastTurn = turns.at(-1) ?? null;

  // On a tablet or phone the diagnosis and the chat are two tabs: the
  // diagnosis first once there is one. A dot on the other tab says when
  // something new arrived there (a new reply, new causes).
  const [tab, setTab] = useState<"diagnosis" | "chat">(() =>
    initial?.turns.some((turn) => turn.status === "done" && turn.reply) ? "diagnosis" : "chat",
  );
  const replyId = replyTurn?.id ?? null;
  const finishedId = lastTurn && lastTurn.status !== "running" ? lastTurn.id : null;
  const [seenReply, setSeenReply] = useState(replyId);
  const [seenChat, setSeenChat] = useState(finishedId);
  if (tab === "diagnosis" && seenReply !== replyId) setSeenReply(replyId);
  if (tab === "chat" && seenChat !== finishedId) setSeenChat(finishedId);
  const diagnosisNews = replyId !== null && replyId !== seenReply;
  const chatNews = finishedId !== null && finishedId !== seenChat;

  function show(next: "diagnosis" | "chat") {
    setTab(next);
    requestAnimationFrame(() => {
      if (next === "chat") bottom.current?.scrollIntoView({ block: "end" });
      else document.getElementById("diagnosis-pane")?.scrollIntoView({ block: "start" });
    });
  }

  // The message box, focused at the end of what's in it and in view.
  function focusBox() {
    const field = box.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    field.scrollIntoView({ block: "nearest" });
  }

  // One of Claude's questions, quoted into the reply box to answer.
  function quote(question: string) {
    setDraft((old) => addQuote(old, question));
    requestAnimationFrame(focusBox);
  }

  // A question for Claude from the diagnosis ("How do I check cause 2, …?"),
  // put in the message box to send or change, never sent from here. On a
  // tablet or phone the box is behind the Chat tab, so that opens. From the
  // full-screen view the page behind is still inert for a moment while the
  // view closes: the box is focused once it can be.
  function ask(question: string) {
    setDraft((old) => addAsk(old, question));
    const tabbed = (document.querySelector("[data-tabbar]")?.getBoundingClientRect().height ?? 0) > 0;
    if (tabbed) setTab("chat");
    let frames = 30;
    const focusWhenFree = () => {
      if (box.current?.closest("[inert]") && frames-- > 0) requestAnimationFrame(focusWhenFree);
      else focusBox();
    };
    requestAnimationFrame(focusWhenFree);
  }

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
        setConversation((old) =>
          old
            ? {
                ...old,
                scope: event.scope,
                unit: event.scope.label ?? old.unit,
                vin: event.vin ?? old.vin,
                modelNumber: event.modelNumber,
                vehicle: event.vehicle,
                model: event.model,
              }
            : old,
        );
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

  const working = running ? (running.progress.at(-1)?.label ?? "Thinking it over") : null;
  const latest = openTurnIds(turns);
  // The causes in the reply before the latest, to mark what's new.
  const previousReply = replyTurn ? turns.filter((turn) => turn.status === "done" && turn.reply && turn.seq < replyTurn.seq).at(-1) : undefined;
  const previousTitles = previousReply?.reply ? new Set(previousReply.reply.likelyCauses.map((cause) => cause.title.toLowerCase())) : null;
  const questions = replyTurn?.id === lastTurn?.id ? (replyTurn?.reply?.questions.length ?? 0) : 0;
  // What the Chat tab and the strip say when something happened there.
  const news = lastTurn && lastTurn.status !== "running" ? chatNewsFor(lastTurn.status) : null;
  const chatBadge = chatNews && news ? { text: news.badge, tone: news.tone } : null;

  function showQuestions() {
    setTab("chat");
    requestAnimationFrame(() =>
      document.querySelector(`li[data-turn="${lastTurn?.seq}"] [data-question="0"]`)?.scrollIntoView({ block: "center" }),
    );
  }

  // Wide: the conversation's heading and thread on the left, the diagnosis
  // beside them from the top (from 1280 px, itself two columns: the causes
  // and checks, and the unit with the manual pictures), using the screen's
  // whole width (data-wide-page; see the app layout). Narrow: the heading,
  // the tabs, then one tab.
  return (
    <div
      ref={widePage}
      data-wide-page
      className="max-lg:space-y-4 lg:grid lg:grid-cols-[minmax(0,1fr)_30rem] lg:grid-rows-[auto_1fr] lg:gap-x-6 lg:gap-y-4 xl:grid-cols-[minmax(19rem,0.78fr)_minmax(0,2fr)]"
    >
      <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 lg:col-start-1 lg:row-start-1">
        <div className="flex w-full items-center justify-between gap-3 lg:contents">
          <Link href="/diagnose" className="shrink-0 text-sm text-glow/90 hover:text-glow hover:underline lg:hidden">
            ‹ Diagnose
          </Link>
          <span className="lg:order-2">
            {/* Narrow, the solved cause is at the top of the list instead. */}
            {conversation.outcome ? (
              <Badge tone="glow">
                Solved<span className="max-lg:hidden">: {conversation.outcome.title}</span>
              </Badge>
            ) : (
              <Badge>Open</Badge>
            )}
          </span>
        </div>
        <div className="min-w-0 lg:order-1">
          <Link href="/diagnose" className="text-sm text-glow/90 hover:text-glow hover:underline max-lg:hidden">
            ‹ Diagnose
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight break-words text-ink max-lg:mt-0 max-lg:text-lg max-lg:leading-snug">{conversation.title}</h1>
          {conversation.unit && <p className="text-sm text-ink-muted">{conversation.unit}</p>}
          <CustomerLine
            conversationId={conversation.id}
            customer={conversation.customer}
            canOpen={customerLinks}
            onChange={(customer) => setConversation((old) => (old ? { ...old, customer } : old))}
          />
        </div>
      </header>

      <div data-tabbar className="sticky top-0 z-20 -mx-4 bg-forest-950/85 px-4 py-1.5 backdrop-blur-md sm:-mx-8 sm:px-8 lg:hidden">
        <div role="group" aria-label="Show" className="grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-charcoal-900/90 p-1">
          <TabButton tab="diagnosis" active={tab === "diagnosis"} badge={diagnosisNews ? { text: "Updated", tone: "glow" } : null} onClick={() => show("diagnosis")}>
            <CausesIcon />
            Diagnosis
          </TabButton>
          <TabButton tab="chat" active={tab === "chat"} badge={chatBadge} working={running !== null} onClick={() => show("chat")}>
            <ChatIcon />
            Chat
          </TabButton>
        </div>
      </div>

      <section aria-label="Conversation" className={`min-w-0 scroll-mt-20 space-y-4 lg:col-start-1 lg:row-start-2 ${tab === "chat" ? "" : "max-lg:hidden"}`}>
        <ol className="space-y-3">
          {turns.map((turn) =>
            !latest.has(turn.id) && !opened.has(turn.id) ? (
              <FoldedTurn key={turn.id} turn={turn} onOpen={() => setOpened((old) => new Set(old).add(turn.id))} />
            ) : (
              <TurnBlock
                key={turn.id}
                turn={turn}
                liveText={live?.turnId === turn.id ? live.text : null}
                canRetry={turn.id === lastTurn?.id && (turn.status === "failed" || turn.status === "stopped")}
                onRetry={() => void send({ conversationId: conversation.id, retryTurnId: turn.id })}
                busy={busy}
                onQuote={conversation.full ? null : quote}
                onShowDiagnosis={turn.id === replyTurn?.id && turn.id === lastTurn?.id ? () => show("diagnosis") : null}
                onFold={
                  latest.has(turn.id)
                    ? null
                    : () =>
                        setOpened((old) => {
                          const next = new Set(old);
                          next.delete(turn.id);
                          return next;
                        })
                }
              />
            ),
          )}
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
            boxRef={box}
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

      <aside
        id="diagnosis-pane"
        aria-label="Diagnosis"
        className={`min-w-0 scroll-mt-20 space-y-4 lg:sticky lg:top-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:pr-1 lg:[scrollbar-width:thin] ${tab === "diagnosis" ? "" : "max-lg:hidden"}`}
      >
        {/* On a tablet the chat is behind its tab: what happened there,
            and that this conversation is full, show here too. */}
        {conversation.full && (
          <p className="flex flex-wrap items-center gap-x-2 rounded-xl border border-trail/40 bg-trail/10 px-4 py-2 text-sm text-trail lg:hidden" data-testid="full-strip">
            <span>This diagnosis is full.</span>
            <Link href={`/diagnose/new?from=${conversation.id}`} className="inline-flex min-h-11 items-center font-medium underline">
              Start a new diagnosis for this unit
            </Link>
          </p>
        )}
        {working ? (
          <div className="flex items-center gap-3 rounded-xl border border-glow/25 bg-glow/5 py-1 pr-1 pl-4 text-sm" data-testid="working-strip">
            <WorkingIcon className="size-4 text-glow" />
            <span className="min-h-11 min-w-0 flex-1 content-center truncate text-ink">{working}…</span>
            <button type="button" onClick={() => show("chat")} className="min-h-11 shrink-0 rounded-lg px-3 font-medium text-glow hover:bg-glow/10 lg:hidden">
              Open chat
            </button>
          </div>
        ) : (
          chatNews &&
          news && (
            <div role="status" className="flex items-center gap-3 rounded-xl border border-glow/25 bg-glow/5 py-1 pr-1 pl-4 text-sm lg:hidden">
              <span className="min-w-0 flex-1 text-ink">{news.text}</span>
              <button type="button" onClick={() => show("chat")} className="min-h-11 shrink-0 rounded-lg px-3 font-medium text-glow hover:bg-glow/10">
                {news.action}
              </button>
            </div>
          )
        )}
        <CausesPanel
          conversation={conversation}
          reply={replyTurn?.reply ?? null}
          replyTurnId={replyTurn?.id ?? null}
          previousTitles={previousTitles}
          busy={busy}
          afterCauses={
            questions > 0 && !conversation.full && !running ? (
              <button
                type="button"
                data-testid="questions-pointer"
                onClick={showQuestions}
                className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-glow/25 bg-glow/5 px-4 text-left text-sm font-medium text-glow transition hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none lg:hidden"
              >
                <ReplyIcon />
                {questions === 1 ? "Claude asks a question" : `Claude asks ${questions} questions`}
                <span className="ml-auto text-ink-muted">Answer</span>
              </button>
            ) : null
          }
          onConversation={(update) => setConversation((old) => (old ? { ...old, ...update } : old))}
          onAsk={conversation.full ? undefined : ask}
        />
      </aside>
    </div>
  );
}

function TabButton({
  tab,
  active,
  badge,
  working = false,
  onClick,
  children,
}: {
  tab: string;
  active: boolean;
  badge: { text: string; tone: "glow" | "trail" } | null;
  working?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-tab={tab}
      aria-pressed={active}
      onClick={onClick}
      className={`relative flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
        active ? "bg-glow/15 text-glow" : "text-ink-muted hover:text-ink"
      }`}
    >
      {children}
      {working && !active && (
        <span data-working className="flex items-center gap-1.5 text-xs text-glow">
          <WorkingIcon className="size-3.5 text-glow" />
          <span className="max-sm:sr-only">Working</span>
        </span>
      )}
      {badge && !active && !working && (
        <span
          data-news
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.tone === "glow" ? "bg-glow/20 text-glow" : "bg-trail/20 text-trail"}`}
        >
          {badge.text}
        </span>
      )}
    </button>
  );
}

function MessageBox({
  boxRef,
  draft,
  setDraft,
  onSubmit,
  busy,
  action,
}: {
  boxRef: RefObject<HTMLTextAreaElement | null>;
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
        ref={boxRef}
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
