"use client";

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

import { Notice } from "@/components/app/ui";
import { inputBaseClass, inputClass, labelClass, primaryButtonClass, primaryLinkClass, secondaryButtonClass } from "@/components/hud";
import {
  LOC_ACCOUNT,
  LOC_LABELS,
  LOC_LIMITS,
  LOC_SECTION_LABELS,
  blankLocValues,
  checkLocUnit,
  floorDateLooksOff,
  floorStatus,
  floorStatusText,
  locCategories,
  stockFromVin,
  type LocSection,
  type LocValueKey,
  type LocValues,
} from "@/lib/loc-rules";
import type { VinDecode } from "@/lib/nusr";
import { cleanVin, formatDay, formatMoney, guessCategory, moneyInput, parseMoney } from "@/lib/nusr-rules";
import { useFormAction } from "@/lib/use-form-action";

import { decodeLocVinAction, markLocUnitsAction, removeLocUnitAction, saveLocUnitAction, type LocFormState } from "./actions";

// The LOC tab's forms: a unit (coming in, or being corrected), marking
// units paid off or sold, removing one, and checking the LOC's total
// against the books.

const hintClass = "mt-1 text-xs leading-5 text-ink-muted";
const sectionClass = "rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6";
const legendClass = "float-left mb-4 w-full text-base font-semibold text-ink";

// The live region is always on the page and only its message changes, which
// screen readers announce far more reliably than a region that appears.
function Feedback({ state }: { state: LocFormState }) {
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

// --- A unit --------------------------------------------------------------------------

function Field({
  name,
  values,
  set,
  problems,
  hint,
  wide = false,
  ...props
}: {
  name: LocValueKey;
  values: LocValues;
  set: (name: LocValueKey, value: string) => void;
  problems: Partial<Record<LocValueKey, string>>;
  hint?: ReactNode;
  wide?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "value" | "onChange">) {
  const id = `loc-${name}`;
  const problem = problems[name];
  const shownHint = problem ? <span className="text-trail">{problem}</span> : hint;
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label htmlFor={id} className={labelClass}>
        {LOC_LABELS[name]}
      </label>
      <input
        id={id}
        name={name}
        value={values[name]}
        onChange={(event) => set(name, event.target.value)}
        autoComplete="off"
        className={inputClass}
        aria-describedby={shownHint ? `${id}-hint` : undefined}
        aria-invalid={problem ? true : undefined}
        {...props}
      />
      {shownHint && (
        <p id={`${id}-hint`} className={hintClass}>
          {shownHint}
        </p>
      )}
    </div>
  );
}

// Two choices side by side, as the NUSR's New/Used.
function Toggle<T extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <fieldset>
      <legend className={labelClass}>{legend}</legend>
      <div className="mt-1.5 grid h-12 grid-cols-2 gap-1 rounded-lg border border-white/10 bg-forest-950/70 p-1">
        {options.map(([option, label]) => (
          <label
            key={option}
            className={`flex cursor-pointer items-center justify-center rounded-md text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
              value === option ? "bg-glow/15 text-glow" : "text-ink-muted hover:text-ink"
            }`}
          >
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} className="sr-only" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// A unit, coming in or being corrected. A VIN fills in what the app knows:
// its year and model (as the shop last sold the model, or from the model
// list), its stock # (the VIN's last digits), and its category from the
// model; what the last one of the model cost is offered. A new unit goes on
// the LOC as it's floored; "Add and start another" keeps the day it came
// in, its free floor and where it goes, for the rest of a delivery.
export function LocUnitForm({
  unit,
  today,
  models,
  categories,
  back = "",
}: {
  unit: { id: string; values: LocValues } | null;
  today: string;
  models: string[];
  categories: string[];
  back?: string;
}) {
  const { state, pending, formProps } = useFormAction<LocFormState>(saveLocUnitAction, {});
  const [values, setValues] = useState<LocValues>(() => unit?.values ?? blankLocValues(today));
  // Boxes the person has set themselves, which the form then leaves alone.
  const [touched, setTouched] = useState<Set<LocValueKey>>(() => new Set(unit ? (Object.keys(unit.values) as LocValueKey[]) : []));
  const [decode, setDecode] = useState<VinDecode | null>(null);
  const [message, setMessage] = useState<LocFormState>({});
  const [serverProblem, setServerProblem] = useState<{ field: string; error: string } | null>(null);
  const nextInput = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const listId = useId();

  const set = (name: LocValueKey, value: string) => {
    setValues((old) => ({ ...old, [name]: value }));
    setTouched((old) => (old.has(name) ? old : new Set(old).add(name)));
    setServerProblem((old) => (old?.field === name ? null : old));
  };

  // After "Add and start another": say so and clear the unit, keeping the
  // day it came in, its free floor, New or Used and where it goes.
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setMessage(state);
    setServerProblem(state.error && state.field ? { field: state.field, error: state.error } : null);
    if (state.another) {
      setValues((old) => ({ ...blankLocValues(today), receivedOn: old.receivedOn, freeFloorEnds: old.freeFloorEnds, condition: old.condition, section: old.section }));
      setTouched(new Set(["receivedOn", "freeFloorEnds", "condition", "section"]));
      setDecode(null);
    }
  }
  useEffect(() => {
    sending.current = false;
    if (state.another) document.getElementById("loc-vin")?.focus();
    else if (state.error && state.field) document.getElementById(`loc-${state.field}`)?.focus();
  }, [state]);

  // The VIN, once it's a whole one: what it says about the unit, filled in
  // where nothing's been typed.
  const vin = cleanVin(values.vin);
  const wholeVin = "vin" in vin && vin.vin?.length === 17 ? vin.vin : null;
  useEffect(() => {
    if (!wholeVin) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await decodeLocVinAction(wholeVin).catch(() => null);
      if (cancelled || !found) return;
      setDecode(found);
      setValues((old) => ({
        ...old,
        unitYear: old.unitYear || String(found.year ?? found.sold?.year ?? ""),
        model: old.model || found.sameModel?.model || found.model || found.sold?.model || "",
        category: old.category || found.sameModel?.category || found.category || "",
      }));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wholeVin]);
  const shownDecode = decode && decode.vin === wholeVin ? decode : null;
  const ownStock = unit !== null && decode?.onLoc?.id === unit.id;

  // Worked out until it's set, never written in, so a VIN or model typed
  // again takes it back: the stock # from the VIN, the category from the
  // model.
  const stockNumber = touched.has("stockNumber") || values.stockNumber ? values.stockNumber : (stockFromVin(wholeVin) ?? "");
  const category = touched.has("category") || values.category ? values.category : (guessCategory(values.model) ?? "");
  const shown: LocValues = { ...values, stockNumber, category };

  const checked = checkLocUnit(shown);
  // What doesn't read shows as it's typed; what's still to fill in (the
  // model, the cost) when it's sent.
  const typedProblem = "error" in checked && checked.field && !/^Enter /.test(checked.error) ? { [checked.field]: checked.error } : {};
  const problems: Partial<Record<LocValueKey, string>> = { ...typedProblem, ...(serverProblem ? { [serverProblem.field]: serverProblem.error } : {}) };

  const cost = parseMoney(values.cost);
  const sum = !("error" in cost) && cost.cents !== null && /\d\s*[+-]/.test(values.cost) ? `= ${formatMoney(cost.cents)}` : null;
  const lastCost = shownDecode?.sameModel?.dealerCost ?? null;
  const floor = floorStatus(values.freeFloorEnds || null, today);
  const year = /^\d{4}$/.test(values.unitYear) ? Number(values.unitYear) : null;
  const section = values.section === "owned" ? "owned" : "loc";

  return (
    <form
      {...formProps}
      onSubmit={(event) => {
        event.preventDefault();
        if (sending.current) return;
        if ("error" in checked) {
          setMessage({ error: checked.error });
          if (checked.field) {
            setServerProblem({ field: checked.field, error: checked.error });
            document.getElementById(`loc-${checked.field}`)?.focus();
          }
          return;
        }
        sending.current = true;
        formProps.onSubmit(event);
      }}
      onKeyDown={enterGoesOn}
      className="space-y-5"
      data-loc-unit-form
    >
      {unit && <input type="hidden" name="id" value={unit.id} />}
      {back && <input type="hidden" name="back" value={back} />}
      <input ref={nextInput} type="hidden" name="next" defaultValue="done" />
      <datalist id={`${listId}-models`}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      <datalist id={`${listId}-categories`}>
        {locCategories(categories).map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <fieldset className={sectionClass}>
        <legend className={legendClass}>The unit</legend>
        <div className="clear-both grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field
            name="vin"
            values={values}
            set={set}
            problems={problems}
            wide
            maxLength={LOC_LIMITS.vin + 6}
            spellCheck={false}
            autoCapitalize="characters"
            className={`${inputClass} font-mono tracking-wide uppercase`}
            hint={
              shownDecode ? (
                <>
                  {shownDecode.onLoc && !ownStock ? (
                    <span className="text-trail" data-loc-vin-on-list>
                      On the LOC already{shownDecode.onLoc.stockNumber ? ` as stock # ${shownDecode.onLoc.stockNumber}` : ""} ({shownDecode.onLoc.label}).{" "}
                    </span>
                  ) : null}
                  {shownDecode.sameModel?.model
                    ? `A ${[shownDecode.year, shownDecode.sameModel.model].filter(Boolean).join(" ")}, as sold ${formatDay(shownDecode.sameModel.soldOn)}. `
                    : shownDecode.model
                      ? `Model list: ${[shownDecode.year, shownDecode.model].filter(Boolean).join(" ")}. `
                      : shownDecode.year
                        ? `A ${shownDecode.year}; not in the model list. `
                        : ""}
                  {shownDecode.sold ? `Sold ${shownDecode.sold.condition === "new" ? "new" : "used"} ${formatDay(shownDecode.sold.soldOn)} to ${shownDecode.sold.customerName}. ` : ""}
                  {!shownDecode.checkDigitOk ? "Its check digit doesn't match: a character may be off." : ""}
                </>
              ) : (
                "A whole VIN fills in the year, the model and the stock #."
              )
            }
          />
          <Field
            name="stockNumber"
            values={shown}
            set={set}
            problems={problems}
            maxLength={LOC_LIMITS.stockNumber}
            spellCheck={false}
            autoCapitalize="characters"
            className={`${inputClass} font-mono`}
            hint={!touched.has("stockNumber") && !values.stockNumber && stockNumber ? "From the VIN's last digits." : "Kept as typed, zeros and all."}
          />
          <Field name="unitYear" values={values} set={set} problems={problems} inputMode="numeric" maxLength={4} />
          <Field name="model" values={values} set={set} problems={problems} list={`${listId}-models`} maxLength={LOC_LIMITS.model} wide hint="As the sheet writes it: “Rngr 1000 XP NS - Havasu Red”." />
          <Field
            name="category"
            values={shown}
            set={set}
            problems={problems}
            list={`${listId}-categories`}
            maxLength={LOC_LIMITS.category}
            hint={!touched.has("category") && !values.category && category ? "From the model." : undefined}
          />
          <Toggle
            name="condition"
            legend={LOC_LABELS.condition}
            value={values.condition === "used" ? "used" : "new"}
            options={[
              ["new", "New"],
              ["used", "Used"],
            ]}
            onChange={(value) => set("condition", value)}
          />
        </div>
      </fieldset>

      <fieldset className={sectionClass}>
        <legend className={legendClass}>Cost and free floor</legend>
        <div className="clear-both grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {lastCost !== null && values.cost.trim() === "" && (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-glow/30 bg-glow/5 px-3.5 py-2 text-sm sm:col-span-2 xl:col-span-3" data-loc-last-cost>
              <p className="min-w-0 text-ink">
                The last {shownDecode?.sameModel?.model ?? "of this model"} sold ({formatDay(shownDecode?.sameModel?.soldOn ?? null)}) cost {formatMoney(lastCost)}.
              </p>
              <button
                type="button"
                onClick={() => set("cost", moneyInput(lastCost))}
                className="min-h-11 rounded-lg px-3 text-sm font-medium text-glow hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
              >
                Use it
              </button>
            </div>
          )}
          <Field
            name="cost"
            values={values}
            set={set}
            problems={problems}
            inputMode="decimal"
            spellCheck={false}
            autoCapitalize="off"
            className={`${inputClass} text-right tabular-nums`}
            hint={sum ?? "What it's floored at: the invoice, or a trade-in's value."}
          />
          <Field
            name="freeFloorEnds"
            values={values}
            set={set}
            problems={problems}
            type="date"
            hint={
              floorDateLooksOff(year, values.freeFloorEnds || null) ? (
                <span className="text-trail">Before a {year} could have come in: check the year.</span>
              ) : floor.state !== "none" ? (
                <span className={floor.state === "ended" ? "text-trail" : undefined}>{floorStatusText(floor)}</span>
              ) : (
                "Its last day of free flooring."
              )
            }
          />
          <Field name="receivedOn" values={values} set={set} problems={problems} type="date" hint="When it came in: its days in stock count from here." />
        </div>
      </fieldset>

      <fieldset className={sectionClass}>
        <legend className={legendClass}>On the LOC or ours</legend>
        <div className="clear-both grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Toggle<LocSection>
            name="section"
            legend="Where it is"
            value={section}
            options={[
              ["loc", LOC_SECTION_LABELS.loc],
              ["owned", LOC_SECTION_LABELS.owned],
            ]}
            onChange={(value) => set("section", value)}
          />
          {section === "owned" && (
            <Field name="paidOffOn" values={values} set={set} problems={problems} type="date" hint="When it was paid off the LOC, if it was on it." />
          )}
          {unit && <Field name="soldOn" values={values} set={set} problems={problems} type="date" hint={section === "loc" ? "Sold, it stays on the LOC until it's paid off." : "Sold, it comes off the list."} />}
        </div>
        <p className={`${hintClass} clear-both mt-3`}>
          {section === "loc" ? `Owed on the line: it counts in the LOC's total, which balances with account ${LOC_ACCOUNT}.` : "The shop's own: paid off, or a trade-in. It isn't owed on the line."}
        </p>
      </fieldset>

      <div className={sectionClass}>
        <label htmlFor="loc-notes" className={labelClass}>
          {LOC_LABELS.notes}
        </label>
        <textarea
          id="loc-notes"
          name="notes"
          value={values.notes}
          onChange={(event) => set("notes", event.target.value)}
          rows={3}
          maxLength={LOC_LIMITS.notes}
          className={`${inputBaseClass} mt-1.5 h-auto py-3`}
        />
      </div>

      <Feedback state={message} />
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="submit"
          aria-disabled={pending}
          onClick={() => {
            if (nextInput.current && !sending.current) nextInput.current.value = "done";
          }}
          className={`${primaryButtonClass} aria-disabled:cursor-wait aria-disabled:opacity-70`}
        >
          {unit ? (pending ? "Saving…" : "Save changes") : pending ? "Adding…" : section === "loc" ? "Add to the LOC" : "Add as ours"}
        </button>
        {!unit && (
          <button
            type="submit"
            aria-disabled={pending}
            onClick={() => {
              if (nextInput.current && !sending.current) nextInput.current.value = "another";
            }}
            className={`${secondaryButtonClass} aria-disabled:cursor-wait aria-disabled:opacity-70`}
            data-loc-another
          >
            Add and start another
          </button>
        )}
      </div>
    </form>
  );
}

// Enter in a box goes on to the next one, as in a spreadsheet: only the
// buttons save, so an Enter never sends half a unit.
function enterGoesOn(event: KeyboardEvent<HTMLFormElement>) {
  const target = event.target;
  if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || ["submit", "button", "file"].includes(target.type)) return;
  event.preventDefault();
  const boxes = [...event.currentTarget.querySelectorAll<HTMLElement>("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button[type=submit]")].filter(
    (box) => !(box instanceof HTMLInputElement && box.type === "radio" && !box.checked),
  );
  boxes[boxes.indexOf(target) + 1]?.focus();
}

// --- Marking units ----------------------------------------------------------------------

// The list's units, ticked, marked together: paid off the LOC (one payoff
// often covers several) or sold. The tick boxes are in the table (their
// form attribute is formId); the server checks each again.
const tickBoxes = (formId: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${formId}"]`)];

export function MarkUnitsForm({ formId, back, today }: { formId: string; back: string; today: string }) {
  const { state, pending, formProps } = useFormAction<LocFormState>(markLocUnitsAction, {});
  const [ticked, setTicked] = useState(0);
  const [boxCount, setBoxCount] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const count = () => {
      const boxes = tickBoxes(formId);
      setTicked(boxes.filter((box) => box.checked).length);
      setBoxCount(boxes.length);
    };
    count();
    document.addEventListener("change", count);
    return () => document.removeEventListener("change", count);
  }, [formId]);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setProblem(null);
  }
  const all = ticked > 0 && ticked === boxCount;
  const buttonClass = `${primaryLinkClass} h-11 aria-disabled:opacity-60`;
  return (
    <form
      id={formId}
      {...formProps}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        if (ticked === 0) {
          setProblem("Tick the units first.");
          return;
        }
        formProps.onSubmit(event);
      }}
      className="mt-4 rounded-xl border border-glow/30 bg-glow/5 p-4"
      data-loc-mark
    >
      <input type="hidden" name="back" value={back} />
      <p className="text-sm text-ink">Tick units, then mark them paid off (one payoff often covers several) or sold, on the day below.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${formId}-on`} className={labelClass}>
            Day
          </label>
          <input id={`${formId}-on`} type="date" name="on" defaultValue={today} required className={`${inputClass} w-44`} />
        </div>
        <button type="submit" name="mark" value="paid" aria-disabled={pending || ticked === 0} className={buttonClass} data-loc-mark-paid>
          {pending ? "Marking…" : ticked === 0 ? "Paid off" : `Mark ${ticked} paid off`}
        </button>
        <button
          type="submit"
          name="mark"
          value="sold"
          aria-disabled={pending || ticked === 0}
          className="inline-flex h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none aria-disabled:opacity-60"
          data-loc-mark-sold
        >
          {ticked === 0 ? "Sold" : `Mark ${ticked} sold`}
        </button>
        <button
          type="button"
          onClick={() => {
            const boxes = tickBoxes(formId);
            for (const box of boxes) box.checked = !all;
            setTicked(all ? 0 : boxes.length);
          }}
          className="min-h-11 rounded-lg px-3 text-sm font-medium text-glow/90 hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          {all ? "Untick all" : "Tick all listed"}
        </button>
      </div>
      <div className="mt-3">
        <Feedback state={problem ? { error: problem } : state} />
      </div>
    </form>
  );
}

// One unit marked as the NUSR has it: sold on the sale's day, or paid off
// on its Date Paid.
export function QuickMark({ id, mark, on, back, children }: { id: string; mark: "paid" | "sold"; on: string; back: string; children: ReactNode }) {
  const { state, pending, formProps } = useFormAction<LocFormState>(markLocUnitsAction, {});
  return (
    <form {...formProps} className="inline">
      <input type="hidden" name="ids" value={id} />
      <input type="hidden" name="mark" value={mark} />
      <input type="hidden" name="on" value={on} />
      <input type="hidden" name="back" value={back} />
      <button
        type="submit"
        disabled={pending}
        className="min-h-9 rounded-md px-2 text-xs font-medium text-glow hover:bg-glow/10 hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60"
        data-loc-quick-mark={mark}
      >
        {pending ? "Marking…" : children}
      </button>
      {state.error && <span className="block text-xs text-trail">{state.error}</span>}
    </form>
  );
}

// --- Removing ------------------------------------------------------------------------------

const removeButtonClass =
  "h-12 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

// Remove, asking first; the Activity log keeps what the unit was.
export function RemoveLocUnitForm({ unit, back = "" }: { unit: { id: string; label: string }; back?: string }) {
  const { state, pending, formProps } = useFormAction<LocFormState>(removeLocUnitAction, {});
  const [confirming, setConfirming] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={unit.id} />
      {back && <input type="hidden" name="back" value={back} />}
      <Feedback state={state} />
      {confirming ? (
        <div className="space-y-3">
          <p id="remove-question" className="text-sm text-ink">
            Remove {unit.label} from the LOC? The Activity log keeps a record of what it was. (A unit that sold is marked sold instead.)
          </p>
          <div className="flex gap-3">
            <button type="submit" disabled={pending} autoFocus aria-describedby="remove-question" className={`${removeButtonClass} flex-1`}>
              {pending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => removeButton.current?.focus());
              }}
              className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button ref={removeButton} type="button" onClick={() => setConfirming(true)} className={`${removeButtonClass} w-full`}>
          Remove from the LOC
        </button>
      )}
    </form>
  );
}

// --- Balancing with the books ------------------------------------------------------------

// The LOC's total beside the books' flooring account, as the sheet said it
// must always balance: the account's balance typed in, and how far apart
// they are. Nothing's saved.
export function BalanceCheck({ total }: { total: number }) {
  const [typed, setTyped] = useState("");
  const parsed = parseMoney(typed);
  const balance = "error" in parsed ? null : parsed.cents;
  const difference = balance === null ? null : total - balance;
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2" data-loc-balance>
      <div>
        <label htmlFor="loc-balance" className={labelClass}>
          Account {LOC_ACCOUNT}&apos;s balance
        </label>
        <input
          id="loc-balance"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="From the books"
          className={`${inputClass} w-52 text-right tabular-nums`}
        />
      </div>
      <p role="status" aria-live="polite" className="min-h-11 content-center text-sm">
        {"error" in parsed ? (
          <span className="text-trail">That isn&apos;t an amount.</span>
        ) : difference === null ? (
          <span className="text-ink-muted">Type it in to check the LOC&apos;s total against it.</span>
        ) : difference === 0 ? (
          <span className="font-medium text-glow">Balances: the LOC&apos;s total is the account&apos;s.</span>
        ) : (
          <span className="font-medium text-trail">
            Off by {formatMoney(Math.abs(difference))}: the LOC lists {difference > 0 ? "more" : "less"} than the account.
          </span>
        )}
      </p>
    </div>
  );
}
