"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { Notice } from "@/components/app/ui";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { MAX_STICKER_LENGTH, PLATE_CLASSES, PLATE_CLASS_LABELS, normalizeSticker, type PlateClass } from "@/lib/sticker-log-rules";
import { useFormAction } from "@/lib/use-form-action";

import { logStickerAction, removeStickerAction, saveStickerAction, searchLogCustomersAction, type FormState } from "./actions";

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

// The customer the sticker went to: found by name or phone number as it's
// typed (arrow keys and Enter, or a tap), or added as a new customer by the
// name typed. labelId names it (the form's "Customer name" label), and a
// polite announcement says who's picked, as the box turns into their name.
function CustomerBox({ picked, onPick, inputId, labelId }: { picked: Picked; onPick: (picked: Picked) => void; inputId: string; labelId: string }) {
  const id = inputId;
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ query: string; items: CustomerChoice[] }>({ query: "", items: [] });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const change = useRef<HTMLButtonElement>(null);
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

  // The option the arrow keys are on stays in sight in the scrolling list.
  useEffect(() => {
    if (showing) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [showing, active, id]);

  const choose = (option: Picked) => {
    onPick(option);
    setText("");
    setOpen(false);
    // The box becomes the customer's name: focus goes to its Change button.
    requestAnimationFrame(() => change.current?.focus());
  };
  const pickedName = picked?.kind === "existing" ? picked.customer.name : picked?.kind === "new" ? picked.name : "";

  return (
    <div>
      <p className="sr-only" aria-live="polite">
        {picked ? `Customer: ${pickedName}${picked.kind === "new" ? ", a new customer" : ""}.` : ""}
      </p>
      {picked ? (
        <div
          role="group"
          aria-labelledby={labelId}
          className="mt-1.5 flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-glow/40 bg-glow/5 px-3.5 py-2"
          data-sticker-customer
        >
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
            ref={change}
            type="button"
            aria-label={`Change the customer (now ${pickedName})`}
            onClick={() => {
              onPick(null);
              requestAnimationFrame(() => input.current?.focus());
            }}
            className="min-h-11 rounded-lg px-2 text-sm font-medium text-glow/90 hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            Change
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            ref={input}
            id={id}
            type="text"
            role="combobox"
            aria-labelledby={labelId}
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
              // Down opens the list again after Escape closed it.
              if (!showing) {
                if (event.key === "ArrowDown" && options.length > 0) {
                  setOpen(true);
                  event.preventDefault();
                }
                return;
              }
              if (event.key === "ArrowDown") setActive((at) => Math.min(at + 1, options.length - 1));
              else if (event.key === "ArrowUp") setActive((at) => Math.max(at - 1, 0));
              else if (event.key === "Enter") choose(options[Math.min(active, options.length - 1)]);
              else if (event.key === "Escape") setOpen(false);
              else return;
              event.preventDefault();
            }}
            placeholder="Their name or phone number"
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
                    <span className="text-glow">Add “{option.name}” as a new customer</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ClassChoice({ value, onChange }: { value: PlateClass | null; onChange: (value: PlateClass) => void }) {
  return (
    <fieldset>
      <legend className={labelClass}>Plate classification</legend>
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        {PLATE_CLASSES.map((plateClass) => (
          <label
            key={plateClass}
            className={`flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
              value === plateClass ? "border-glow/50 bg-glow/10 text-ink" : "border-white/10 text-ink-muted hover:border-white/20"
            }`}
          >
            <input
              type="radio"
              name="plateClass"
              value={plateClass}
              checked={value === plateClass}
              onChange={() => onChange(plateClass)}
              required
              className="accent-glow"
            />
            {PLATE_CLASS_LABELS[plateClass]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

type SavedEntry = { id: string; stickerNumber: string; plateClass: PlateClass; customer: CustomerChoice };

// Logs a sticker, or corrects one. After logging, the form is ready for
// the next sticker: the number and customer are cleared (also when the form
// was opened from a customer's record) and the class stays, as a run of
// stickers is often all one class. After a correction is saved, the
// customer shown is the one saved, so saving again can't add a new
// customer twice.
export function StickerForm({ entry, initialCustomer }: { entry?: SavedEntry; initialCustomer?: CustomerChoice | null }) {
  const { state, pending, formProps } = useFormAction<FormState>(entry ? saveStickerAction : logStickerAction, {});
  const [sticker, setSticker] = useState(entry?.stickerNumber ?? "");
  const [plateClass, setPlateClass] = useState<PlateClass | null>(entry?.plateClass ?? null);
  const [picked, setPicked] = useState<Picked>(
    entry ? { kind: "existing", customer: entry.customer } : initialCustomer ? { kind: "existing", customer: initialCustomer } : null,
  );
  const stickerInput = useRef<HTMLInputElement>(null);
  // What was sent, to say what was logged.
  const [sent, setSent] = useState("");
  const [message, setMessage] = useState<FormState>({});
  const stickerId = useId();
  const customerId = useId();
  const customerLabelId = useId();

  // What came back: after logging one, say what was logged and get ready
  // for the next.
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.logged) {
      setMessage({ success: `Logged ${sent}.` });
      setSticker("");
      setPicked(null);
    } else {
      setMessage(state);
    }
  }
  // A correction saved: the entry comes back with its customer (a new one
  // has an id now), which the form then shows.
  const [savedCustomer, setSavedCustomer] = useState(entry?.customer.id);
  if (entry && entry.customer.id !== savedCustomer) {
    setSavedCustomer(entry.customer.id);
    setPicked({ kind: "existing", customer: entry.customer });
  }
  useEffect(() => {
    if (state.logged) stickerInput.current?.focus();
  }, [state]);

  return (
    <form
      {...formProps}
      onSubmit={(event) => {
        const name = picked?.kind === "existing" ? picked.customer.name : picked?.kind === "new" ? picked.name : "";
        setSent(`sticker ${normalizeSticker(sticker)} for ${name}`);
        if (!picked) {
          event.preventDefault();
          setMessage({ error: "Pick the customer the sticker went to, or add them." });
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
            Sticker #
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
        </div>
        <div>
          <label id={customerLabelId} htmlFor={customerId} className={labelClass}>
            Customer name
          </label>
          <CustomerBox picked={picked} onPick={setPicked} inputId={customerId} labelId={customerLabelId} />
        </div>
      </div>
      <div className="max-w-sm">
        <ClassChoice value={plateClass} onChange={setPlateClass} />
      </div>
      <Feedback state={message} />
      <button type="submit" disabled={pending} className={entry ? secondaryButtonClass : primaryButtonClass}>
        {entry ? (pending ? "Saving…" : "Save changes") : pending ? "Logging…" : "Log sticker"}
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
  // Cancel puts focus back on the button that asked.
  const opener = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!confirming && cancelled.current) {
      cancelled.current = false;
      opener.current?.focus();
    }
  }, [confirming]);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={entry.id} />
      <Feedback state={state} />
      {confirming ? (
        <div className="space-y-3">
          <p id="remove-question" className="text-sm text-ink">
            Remove sticker {entry.stickerNumber} from the log? The audit log keeps a record that it was removed.
          </p>
          <div className="flex gap-3">
            <button type="submit" disabled={pending} autoFocus aria-describedby="remove-question" className={`${removeButtonClass} flex-1`}>
              {pending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                cancelled.current = true;
                setConfirming(false);
              }}
              className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button ref={opener} type="button" onClick={() => setConfirming(true)} className={`${removeButtonClass} w-full`}>
          Remove from the log
        </button>
      )}
    </form>
  );
}

const subscribe = () => () => {};

// Download the log (as searched and filtered) as CSV, its dates in the
// viewer's own time zone.
export function ExportLink({ query, plateClass }: { query: string; plateClass: PlateClass | null }) {
  const timeZone = useSyncExternalStore(
    subscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "",
  );
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (plateClass) params.set("class", String(plateClass));
  if (timeZone) params.set("tz", timeZone);
  const search = params.toString();
  return (
    <a
      href={`/admin/sticker-plate-log/export${search ? `?${search}` : ""}`}
      className="inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      data-sticker-export
    >
      Download CSV
    </a>
  );
}
