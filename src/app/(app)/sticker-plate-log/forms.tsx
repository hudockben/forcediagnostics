"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { Notice } from "@/components/app/ui";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import {
  ENTRY_KINDS,
  ENTRY_KIND_LABELS,
  ENTRY_KIND_PLURALS,
  MAX_STICKER_LENGTH,
  classOf,
  entryWords,
  kindOf,
  normalizeSticker,
  type EntryKind,
  type PlateClass,
} from "@/lib/sticker-log-rules";
import { useFormAction } from "@/lib/use-form-action";

import {
  addStockAction,
  logStickerAction,
  removeStickerAction,
  saveStickerAction,
  searchLogCustomersAction,
  type FormState,
} from "./actions";

type CustomerChoice = { id: string; name: string; detail: string | null };
// The customer picked: one on file, or a new one by name.
type Picked = { kind: "existing"; customer: CustomerChoice } | { kind: "new"; name: string } | null;

const hintClass = "mt-1 text-xs leading-5 text-ink-muted";

// The live region is always on the page and only its message changes, which
// screen readers announce far more reliably than a region that appears.
function Feedback({ state }: { state: FormState }) {
  return (
    <div role="status" aria-live="polite" className="empty:my-0">
      {state.error ? (
        <Notice tone="trail" live={false}>
          {state.error}
        </Notice>
      ) : state.success ? (
        <Notice live={false}>{state.success}</Notice>
      ) : null}
    </div>
  );
}

// The customer it went to: found by name or phone number as it's
// typed (arrow keys and Enter, or a tap), or added as a new customer by the
// name typed.
function CustomerBox({ picked, onPick }: { picked: Picked; onPick: (picked: Picked) => void }) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ query: string; items: CustomerChoice[] }>({ query: "", items: [] });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const query = text.trim();

  useEffect(() => {
    if (query.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const items = await searchLogCustomersAction(query).catch(() => []);
      if (!cancelled) setFound({ query, items });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Until the search for what's typed has come back, nothing can be picked:
  // otherwise Enter straight after typing would add a new customer when one
  // on file was about to be offered.
  const looking = query.length >= 2 && found.query !== query;
  const items = found.query === query ? found.items : [];
  // The customers found, then adding the name typed as a new customer.
  const options: Picked[] =
    query.length >= 2 && !looking ? [...items.map((customer) => ({ kind: "existing" as const, customer })), { kind: "new", name: query }] : [];
  const showing = open && options.length > 0;
  const choose = (option: Picked) => {
    onPick(option);
    setText("");
    setOpen(false);
  };

  if (picked) {
    return (
      <div className="mt-1.5 flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-glow/40 bg-glow/5 px-3.5 py-2" data-sticker-customer>
        <span className="min-w-0 text-sm break-words">
          {picked.kind === "existing" ? (
            <>
              <span className="font-medium text-ink">{picked.customer.name}</span>
              {picked.customer.detail && <span className="text-ink-muted"> · {picked.customer.detail}</span>}
            </>
          ) : (
            <>
              <span className="font-medium text-ink">{picked.name}</span>
              <span className="text-ink-muted"> · a new customer</span>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => {
            onPick(null);
            requestAnimationFrame(() => input.current?.focus());
          }}
          className="min-h-11 rounded-lg px-2 text-sm font-medium text-glow/90 hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showing ? `${id}-option-${active}` : undefined}
        aria-describedby={`${id}-hint`}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          // Enter while still looking waits for the results, not the form.
          if (event.key === "Enter" && looking) {
            event.preventDefault();
            return;
          }
          if (!showing) return;
          if (event.key === "ArrowDown") setActive((at) => Math.min(at + 1, options.length - 1));
          else if (event.key === "ArrowUp") setActive((at) => Math.max(at - 1, 0));
          else if (event.key === "Enter") choose(options[Math.min(active, options.length - 1)]);
          else if (event.key === "Escape") setOpen(false);
          else return;
          event.preventDefault();
        }}
        placeholder="Customer's name or phone"
        autoComplete="off"
        spellCheck={false}
        maxLength={120}
        className={inputClass}
        data-sticker-customer-search
      />
      <p id={`${id}-hint`} className={hintClass} aria-live="polite">
        {open && looking ? "Looking…" : "Pick them from your customers, or add them as a new one."}
      </p>
      {showing && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Customers"
          className="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-white/10 bg-charcoal-900 shadow-xl shadow-black/50"
          // Keeps focus in the box while an option is tapped.
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <li
              key={option?.kind === "existing" ? option.customer.id : "new"}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === active}
              onClick={() => choose(option)}
              onMouseEnter={() => setActive(index)}
              className={`flex min-h-12 cursor-pointer flex-col justify-center px-3.5 py-2 text-sm ${index === active ? "bg-white/5" : ""} ${
                option?.kind === "new" ? "border-t border-white/10" : ""
              }`}
            >
              {option?.kind === "existing" ? (
                <>
                  <span className="text-ink">{option.customer.name}</span>
                  {option.customer.detail && <span className="text-xs text-ink-muted">{option.customer.detail}</span>}
                </>
              ) : option?.kind === "new" ? (
                <span className="text-glow">
                  Add “{option.name}” as a new customer
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// One of a few choices, as a row of big radio buttons (a bay tablet's
// fingers).
function Choices<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  columns = "grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]",
}: {
  legend: string;
  name: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  columns?: string;
}) {
  return (
    <fieldset>
      <legend className={labelClass}>{legend}</legend>
      <div className={`mt-1.5 grid gap-2 ${columns}`}>
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
              value === option.value ? "border-glow/50 bg-glow/10 text-ink" : "border-white/10 text-ink-muted hover:border-white/20"
            }`}
          >
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} required className="accent-glow" />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// A sticker, or a Class 1 or Class 2 plate.
function KindChoice({ value, onChange }: { value: EntryKind | null; onChange: (value: EntryKind) => void }) {
  return (
    <Choices
      legend="What it is"
      name="plateClass"
      options={ENTRY_KINDS.map((kind) => ({ value: kind, label: ENTRY_KIND_LABELS[kind] }))}
      value={value}
      onChange={onChange}
      columns="grid-cols-3"
    />
  );
}

// customer: null for one on hand.
type SavedEntry = { id: string; stickerNumber: string; plateClass: PlateClass | null; customer: CustomerChoice | null };

// Logs a sticker or plate, or corrects one. After logging, the form is
// ready for the next: the number and customer are cleared and what it is
// stays, as a run is often all stickers or all one class of plate. A
// number on hand is handed out by logging it: nextOnHand offers the next
// of the kind picked. An entry on hand can be corrected with no customer
// (it stays on hand), or handed out to the customer picked.
export function StickerForm({
  entry,
  initialCustomer,
  nextOnHand = {},
}: {
  entry?: SavedEntry;
  initialCustomer?: CustomerChoice | null;
  nextOnHand?: Partial<Record<EntryKind, string>>;
}) {
  const { state, pending, formProps } = useFormAction<FormState>(entry ? saveStickerAction : logStickerAction, {});
  const [sticker, setSticker] = useState(entry?.stickerNumber ?? "");
  const [kind, setKind] = useState<EntryKind | null>(entry ? kindOf(entry.plateClass) : null);
  const [picked, setPicked] = useState<Picked>(
    entry?.customer ? { kind: "existing", customer: entry.customer } : !entry && initialCustomer ? { kind: "existing", customer: initialCustomer } : null,
  );
  const onHand = entry !== undefined && entry.customer === null;
  const next = !entry && kind ? nextOnHand[kind] : undefined;
  const stickerInput = useRef<HTMLInputElement>(null);
  // What was sent, to say what was logged.
  const [sent, setSent] = useState("");
  const [message, setMessage] = useState<FormState>({});
  const stickerId = useId();

  // What came back: after logging one, say what was logged and get ready
  // for the next.
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.logged) {
      setMessage({ success: `Logged ${sent}${state.fromStock ? ", from stock" : ""}.` });
      setSticker("");
      setPicked(initialCustomer ? { kind: "existing", customer: initialCustomer } : null);
    } else {
      setMessage(state);
    }
  }
  useEffect(() => {
    if (state.logged) stickerInput.current?.focus();
  }, [state]);

  return (
    <form
      {...formProps}
      onSubmit={(event) => {
        const name = picked?.kind === "existing" ? picked.customer.name : picked?.kind === "new" ? picked.name : "";
        setSent(`${kind ? entryWords(classOf(kind)) : "sticker"} ${normalizeSticker(sticker)} for ${name}`);
        if (!picked && !onHand) {
          event.preventDefault();
          setMessage({ error: "Pick the customer it went to, or add them." });
          return;
        }
        formProps.onSubmit(event);
      }}
      className="space-y-4"
      data-sticker-form
    >
      {entry && <input type="hidden" name="id" value={entry.id} />}
      {picked?.kind === "existing" && <input type="hidden" name="customerId" value={picked.customer.id} />}
      {picked?.kind === "new" && <input type="hidden" name="newCustomerName" value={picked.name} />}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div>
          <label htmlFor={stickerId} className={labelClass}>
            Sticker or plate #
          </label>
          <input
            ref={stickerInput}
            id={stickerId}
            name="stickerNumber"
            value={sticker}
            onChange={(event) => setSticker(event.target.value)}
            required
            maxLength={MAX_STICKER_LENGTH + 4}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className={`${inputClass} font-mono tracking-wide uppercase`}
            data-sticker-number
          />
          {next && (
            <p className={hintClass} data-next-on-hand>
              Next on hand:{" "}
              <button
                type="button"
                onClick={() => {
                  setSticker(next);
                  stickerInput.current?.focus();
                }}
                className="rounded font-mono text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
              >
                {next}
              </button>
            </p>
          )}
        </div>
        <div>
          <span className={labelClass}>Customer name{onHand && " (to hand it out)"}</span>
          <CustomerBox picked={picked} onPick={setPicked} />
        </div>
      </div>
      <div className="max-w-lg">
        <KindChoice value={kind} onChange={setKind} />
      </div>
      <Feedback state={message} />
      <button type="submit" disabled={pending} className={entry ? secondaryButtonClass : primaryButtonClass}>
        {entry ? (pending ? "Saving…" : onHand && picked ? "Hand it out" : "Save changes") : pending ? "Logging…" : "Log it"}
      </button>
    </form>
  );
}

const removeButtonClass =
  "h-12 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

// Remove, asking first.
export function RemoveStickerForm({ entry }: { entry: { id: string; stickerNumber: string } }) {
  const { state, pending, formProps } = useFormAction<FormState>(removeStickerAction, {});
  const [confirming, setConfirming] = useState(false);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={entry.id} />
      <Feedback state={state} />
      {confirming ? (
        <div className="space-y-3">
          <p id="remove-question" className="text-sm text-ink">
            Remove {entry.stickerNumber} from the log? The audit log keeps a record that it was removed.
          </p>
          <div className="flex gap-3">
            <button type="submit" disabled={pending} autoFocus aria-describedby="remove-question" className={`${removeButtonClass} flex-1`}>
              {pending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={`${removeButtonClass} w-full`}>
          Remove from the log
        </button>
      )}
    </form>
  );
}

// A delivery added to stock, on hand: what they are, and one number or the
// first and last of a run (T280400 to T280449). After adding, the numbers
// clear for the next; what they are stays.
export function AddStockForm() {
  const { state, pending, formProps } = useFormAction<FormState>(addStockAction, {});
  const [kind, setKind] = useState<EntryKind | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const fromId = useId();
  const toId = useId();

  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.success) {
      setFrom("");
      setTo("");
    }
  }

  const numberProps = {
    maxLength: MAX_STICKER_LENGTH + 4,
    autoComplete: "off",
    autoCapitalize: "characters",
    spellCheck: false,
    className: `${inputClass} font-mono tracking-wide uppercase`,
  } as const;
  return (
    <form {...formProps} className="space-y-4" data-add-stock-form>
      <Choices legend="What" name="kind" options={ENTRY_KINDS.map((value) => ({ value, label: ENTRY_KIND_PLURALS[value] }))} value={kind} onChange={setKind} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={fromId} className={labelClass}>
            First #
          </label>
          <input id={fromId} name="from" value={from} onChange={(event) => setFrom(event.target.value)} {...numberProps} required data-stock-from />
        </div>
        <div>
          <label htmlFor={toId} className={labelClass}>
            Last # <span className="font-normal text-ink-muted">(for a run)</span>
          </label>
          <input id={toId} name="to" value={to} onChange={(event) => setTo(event.target.value)} {...numberProps} data-stock-to />
        </div>
      </div>
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Adding…" : "Add to stock"}
      </button>
    </form>
  );
}

const subscribe = () => () => {};

// Download the log (as searched and filtered) as CSV, its dates in the
// viewer's own time zone.
export function ExportLink({ query, kind, onHand }: { query: string; kind: EntryKind | null; onHand: boolean }) {
  const timeZone = useSyncExternalStore(
    subscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "",
  );
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (kind) params.set("type", kind);
  if (onHand) params.set("status", "on-hand");
  if (timeZone) params.set("tz", timeZone);
  const search = params.toString();
  return (
    <a
      href={`/sticker-plate-log/export${search ? `?${search}` : ""}`}
      className="inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      data-sticker-export
    >
      Download CSV
    </a>
  );
}
