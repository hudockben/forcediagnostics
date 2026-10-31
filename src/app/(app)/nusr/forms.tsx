"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Notice } from "@/components/app/ui";
import { inputBaseClass, inputClass, labelClass, primaryButtonClass, primaryLinkClass, secondaryButtonClass } from "@/components/hud";
import type { BuyerChoice, SaleCustomer, VinDecode } from "@/lib/nusr";
import {
  CATEGORIES,
  SALE_LABELS,
  SALE_LIMITS,
  UNIT_TYPES,
  UNIT_TYPE_LABELS,
  blankSaleValues,
  cleanVin,
  formatDay,
  formatMoney,
  formatPct,
  guessCategory,
  guessUnitType,
  moneyInput,
  parseCondition,
  parseMoney,
  readSaleValues,
  saleFigures,
  saleFlags,
  type MoneyField,
  type SaleValues,
  type UnitType,
} from "@/lib/nusr-rules";
import type { CustomerChoice } from "@/lib/sticker-log";
import { useFormAction } from "@/lib/use-form-action";

import { customerForSaleAction, decodeVinAction, markPaidAction, removeSaleAction, saveSaleAction, searchSaleCustomersAction, type SaleFormState } from "./actions";

// NUSR's forms: a sale (new or being corrected), removing one, the log's
// filters, and the wide page and print button the log and printout use.

const hintClass = "mt-1 text-xs leading-5 text-ink-muted";
const sectionClass = "rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6";
const legendClass = "float-left mb-4 w-full text-base font-semibold text-ink";

// The live region is always on the page and only its message changes, which
// screen readers announce far more reliably than a region that appears.
function Feedback({ state }: { state: SaleFormState }) {
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

// The page takes the screen's width while it's shown (data-wide-page; see
// the app layout), for the log's many columns. Next keeps a page mounted
// but hidden after a navigation and runs its layout effects' cleanups then,
// so the marker comes off and the page now on screen isn't stretched.
export function WidePage({ children, className = "" }: { children: ReactNode; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const page = element.current;
    page?.setAttribute("data-wide-page", "");
    return () => page?.removeAttribute("data-wide-page");
  }, []);
  return (
    <div ref={element} className={className}>
      {children}
    </div>
  );
}

// "Saved.", after a sale's changes are saved: the page comes back fresh, so
// it takes the focus the Save button had.
export function SavedNotice() {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    element.current?.focus();
  }, []);
  return (
    <div ref={element} tabIndex={-1} className="outline-none" data-nusr-saved>
      <Notice>Saved.</Notice>
    </div>
  );
}

// Opens the browser's print dialog, where Save as PDF is one of the printers.
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex min-h-11 items-center rounded-lg bg-trail px-5 text-sm font-semibold text-charcoal-900 transition hover:bg-trail-bright focus-visible:ring-2 focus-visible:ring-trail/60 focus-visible:outline-none print:hidden"
      data-nusr-print-button
    >
      Print or save as PDF
    </button>
  );
}

const noSubscription = () => () => {};

// Download Excel, for the log as filtered (its search, "?year=2025…"), with
// the day in the file's name and its "Downloaded" line in the viewer's own
// time zone, which only the browser knows.
export function ExcelLink({ search, className }: { search: string; className: string }) {
  const timeZone = useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "",
  );
  const params = new URLSearchParams(search);
  if (timeZone) params.set("tz", timeZone);
  const query = params.toString();
  return (
    <a href={`/nusr/export${query ? `?${query}` : ""}`} className={className} data-nusr-export>
      Download Excel
    </a>
  );
}

// --- Paid off together ----------------------------------------------------------------

// The Not paid off list's units, ticked, marked paid off together: one
// floorplan payment pays off several, so its Date Paid and COMS # are
// typed once. The tick boxes are in the table (their form attribute is
// formId); the server checks each again.
const tickBoxes = (formId: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${formId}"]`)];

export function MarkPaidForm({ formId, back, today, comsNumbers }: { formId: string; back: string; today: string; comsNumbers: string[] }) {
  const { state, pending, formProps } = useFormAction<SaleFormState>(markPaidAction, {});
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
  return (
    <form
      id={formId}
      {...formProps}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        if (ticked === 0) {
          setProblem("Tick the units the payment paid off.");
          return;
        }
        formProps.onSubmit(event);
      }}
      className="mt-4 rounded-xl border border-glow/30 bg-glow/5 p-4"
      data-nusr-mark-paid
    >
      <input type="hidden" name="back" value={back} />
      <p className="text-sm text-ink">Paid off together: tick the units one payment paid off, then enter its date and COMS # once.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${formId}-paidOn`} className={labelClass}>
            {SALE_LABELS.paidOn}
          </label>
          <input id={`${formId}-paidOn`} type="date" name="paidOn" defaultValue={today} required className={`${inputClass} w-44`} />
        </div>
        <div>
          <label htmlFor={`${formId}-coms`} className={labelClass}>
            {SALE_LABELS.comsNumber}
          </label>
          <input id={`${formId}-coms`} name="comsNumber" list={`${formId}-coms-list`} maxLength={SALE_LIMITS.comsNumber} autoComplete="off" spellCheck={false} className={`${inputClass} w-44`} />
          <datalist id={`${formId}-coms-list`}>
            {comsNumbers.map((number) => (
              <option key={number} value={number} />
            ))}
          </datalist>
        </div>
        <button type="submit" aria-disabled={pending || ticked === 0} className={`${primaryLinkClass} aria-disabled:opacity-60`} data-nusr-mark-paid-submit>
          {pending ? "Marking…" : ticked === 0 ? "Mark paid off" : `Mark ${ticked} paid off`}
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
          {all ? "Untick all" : "Tick all on this page"}
        </button>
      </div>
      <div className="mt-3">
        <Feedback state={problem ? { error: problem } : state} />
      </div>
    </form>
  );
}

// --- The log's filters ---------------------------------------------------------------

type FilterOption = { value: string; label: string };

// A select that narrows the log as soon as it's changed; the other filters
// and the search stay.
export function LogFilter({ name, label, value, options, search }: { name: string; label: string; value: string; options: FilterOption[]; search: string }) {
  const router = useRouter();
  const id = useId();
  // What was picked shows at once, while the log loads it; the page's own
  // value takes over when it comes.
  const [shown, setShown] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setShown(value);
  }
  const [loading, startLoading] = useTransition();
  return (
    <div className="relative min-w-36 flex-1 sm:flex-none">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={shown}
        aria-busy={loading}
        onChange={(event) => {
          const params = new URLSearchParams(search);
          if (event.target.value) params.set(name, event.target.value);
          else params.delete(name);
          // A month only means something within a year.
          if (name === "year") params.delete("month");
          params.delete("page");
          const next = params.toString();
          setShown(event.target.value);
          startLoading(() => router.push(`/nusr${next ? `?${next}` : ""}`));
        }}
        className={`${inputBaseClass} h-11 appearance-none pr-9 text-sm transition-opacity ${loading ? "opacity-60" : ""}`}
        data-nusr-filter={name}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 fill-none stroke-ink-muted"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m5 8 5 5 5-5" />
      </svg>
    </div>
  );
}

// --- Picking the customer -----------------------------------------------------------

// A customer on file, or someone the NUSR has sold to before who isn't
// (an import brings years of them), found by name or phone number as it's
// typed (arrow keys and Enter, or a tap). Someone new is simply typed into
// the boxes below.
function CustomerSearch({ onPick, inputRef }: { onPick: (choice: BuyerChoice) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ query: string; items: BuyerChoice[] }>({ query: "", items: [] });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const query = text.trim();

  useEffect(() => {
    if (query.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const items = await searchSaleCustomersAction(query).catch(() => []);
      if (!cancelled) setFound({ query, items });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const looking = query.length >= 2 && found.query !== query;
  const items = found.query === query ? found.items : [];
  const showing = open && items.length > 0;
  const choose = (choice: BuyerChoice) => {
    onPick(choice);
    setText("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <label htmlFor={id} className={labelClass}>
        Find a customer
      </label>
      <input
        ref={inputRef}
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
          if (event.key === "Enter" && (looking || showing)) event.preventDefault();
          if (!showing) return;
          if (event.key === "ArrowDown") setActive((at) => Math.min(at + 1, items.length - 1));
          else if (event.key === "ArrowUp") setActive((at) => Math.max(at - 1, 0));
          else if (event.key === "Enter") choose(items[Math.min(active, items.length - 1)]);
          else if (event.key === "Escape") setOpen(false);
          else return;
          event.preventDefault();
        }}
        placeholder="Name or phone"
        autoComplete="off"
        spellCheck={false}
        maxLength={120}
        className={inputClass}
        data-nusr-customer-search
      />
      <p id={`${id}-hint`} className={hintClass} aria-live="polite">
        {open && looking
          ? "Looking…"
          : open && query.length >= 2 && items.length === 0
            ? "Not on file or in the NUSR: type their details below."
            : "On file or bought from us before: picking one fills in their name, phone and address."}
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
          {items.map((choice, index) => (
            <li
              key={choice.id}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === active}
              onClick={() => choose(choice)}
              onMouseEnter={() => setActive(index)}
              className={`flex min-h-12 cursor-pointer flex-col justify-center px-3.5 py-2 text-sm ${index === active ? "bg-white/5" : ""}`}
            >
              <span className="text-ink">{choice.name}</span>
              <span className="text-xs text-ink-muted">{[choice.kind === "customer" ? "On file" : "In the NUSR", choice.detail].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- The sale ----------------------------------------------------------------------------

// What's wrong in each box, as the form reads it or as the server said:
// shown under the box, and tied to it for screen readers.
const ProblemsContext = createContext<Partial<Record<keyof SaleValues, string>>>({});

// The days between two days ("2026-10-01"), whichever comes first; NaN for
// a day that isn't one.
const daysBetween = (from: string, to: string) => Math.abs(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

function Field({
  name,
  label,
  values,
  set,
  hint,
  list,
  wide = false,
  ...props
}: {
  name: keyof SaleValues;
  label?: string;
  values: SaleValues;
  set: (name: keyof SaleValues, value: string) => void;
  hint?: ReactNode;
  list?: string;
  wide?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "value" | "onChange" | "list">) {
  const id = `sale-${name}`;
  const problem = useContext(ProblemsContext)[name];
  const shownHint = problem ? <span className="text-trail">{problem}</span> : hint;
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label htmlFor={id} className={labelClass}>
        {label ?? SALE_LABELS[name]}
      </label>
      <input
        id={id}
        name={name}
        value={values[name]}
        onChange={(event) => set(name, event.target.value)}
        list={list}
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

// An amount box: what's typed can be a sum ("1250+89.99"), as the
// spreadsheet's cells were, and says what it comes to.
// Amounts that do go below zero (a rebate taken back, a chargeback) get a
// phone's whole keyboard: its decimal pad, quicker for the rest, has no -.
const SIGNED: readonly MoneyField[] = ["rebate", "bonusAdjustment"];

function MoneyField({ name, values, set }: { name: MoneyField; values: SaleValues; set: (name: keyof SaleValues, value: string) => void }) {
  const parsed = parseMoney(values[name]);
  const isSum = !("error" in parsed) && parsed.cents !== null && /\d\s*[+-]/.test(values[name]);
  return (
    <Field
      name={name}
      values={values}
      set={set}
      inputMode={SIGNED.includes(name) ? "text" : "decimal"}
      spellCheck={false}
      autoCapitalize="off"
      className={`${inputClass} text-right tabular-nums`}
      hint={isSum && "cents" in parsed ? `= ${formatMoney(parsed.cents)}` : undefined}
      data-nusr-money={name}
    />
  );
}

function Section({ title, children, columns = "sm:grid-cols-2 xl:grid-cols-3" }: { title: string; children: ReactNode; columns?: string }) {
  return (
    <fieldset className={sectionClass}>
      <legend className={legendClass}>{title}</legend>
      <div className={`clear-both grid gap-4 ${columns}`}>{children}</div>
    </fieldset>
  );
}

function Figure({ label, value, strong = false, sub }: { label: string; value: string; strong?: boolean; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className={strong ? "font-semibold text-ink" : "text-ink-muted"}>{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? "text-base font-semibold text-glow" : "text-ink"}`}>
        {value}
        {sub && <span className="ml-1.5 text-xs text-ink-muted">{sub}</span>}
      </dd>
    </div>
  );
}

export type SaleSuggestionLists = {
  salespeople: string[];
  financeCompanies: string[];
  categories: string[];
  models: string[];
  // The COMS #s entered last, the newest first.
  comsNumbers: string[];
};

export type SaleFormSale = { id: string; values: SaleValues; customer: CustomerChoice | null };

// A sale, new or being corrected. It fills itself in where it can: picking
// a customer on file brings their name, phone and address; a VIN brings
// the year and model from the shop's model list (or the unit's record, if
// it was traded in); the model says the category; New or Used and the
// category say the kind of deal, which sets the holdback (none on a trade
// or trailer). The figures work themselves out as it's typed, the way the
// spreadsheet's formulas did. "Log and start another" keeps the date,
// salesman and rates for the next sale of a busy day.
export function SaleForm({
  sale,
  initialCustomer = null,
  defaults,
  suggestions,
  back = "",
}: {
  sale: SaleFormSale | null;
  // The log as it was before the sale was opened ("?year=2025…").
  back?: string;
  // Opened from a customer's record: them, filled in.
  initialCustomer?: { choice: CustomerChoice; details: SaleCustomer } | null;
  defaults: { soldOn: string; holdbackRateBp: number; bonusRateBp: number };
  suggestions: SaleSuggestionLists;
}) {
  const { state, pending, formProps } = useFormAction<SaleFormState>(saveSaleAction, {});
  const fresh = () => blankSaleValues(defaults);
  const [values, setValues] = useState<SaleValues>(
    () =>
      sale?.values ??
      (initialCustomer
        ? {
            ...fresh(),
            customerName: initialCustomer.details.name,
            customerPhone: initialCustomer.details.phone ?? "",
            customerAddress: initialCustomer.details.address ?? "",
          }
        : fresh()),
  );
  const [customer, setCustomer] = useState<CustomerChoice | null>(sale?.customer ?? initialCustomer?.choice ?? null);
  // A new buyer and the unit are added to Customers when a sale's logged;
  // a correction adds nothing unless it's ticked.
  const [addCustomer, setAddCustomer] = useState(!sale);
  const [addVehicle, setAddVehicle] = useState(!sale);
  // Boxes the person has set themselves, which the form then leaves alone.
  const [touched, setTouched] = useState<Set<keyof SaleValues>>(() => new Set(sale ? (Object.keys(sale.values) as (keyof SaleValues)[]) : []));
  const [decode, setDecode] = useState<VinDecode | null>(null);
  // The boxes set by hand as they are now, for what comes back after a wait.
  const touchedNow = useRef(touched);
  useEffect(() => {
    touchedNow.current = touched;
  }, [touched]);
  const [message, setMessage] = useState<SaleFormState>({});
  const customerInput = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const nextInput = useRef<HTMLInputElement>(null);
  // A save on its way: a second click or Enter doesn't send it again.
  const sending = useRef(false);
  // The box the server said was wrong, until it's changed.
  const [serverProblem, setServerProblem] = useState<{ field: string; error: string } | null>(null);

  const set = (name: keyof SaleValues, value: string) => {
    setValues((old) => ({ ...old, [name]: value }));
    setTouched((old) => (old.has(name) ? old : new Set(old).add(name)));
    setServerProblem((old) => (old?.field === name ? null : old));
  };

  // What came back: after logging one with "Log and start another", say so
  // and clear the sale, keeping the day, salesman and rates.
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setMessage(state);
    setServerProblem(state.error && state.field ? { field: state.field, error: state.error } : null);
    if (state.another) {
      setValues((old) => ({ ...fresh(), soldOn: old.soldOn, salesperson: old.salesperson, bonusRateBp: old.bonusRateBp }));
      setCustomer(null);
      setTouched(new Set(["soldOn", "salesperson"]));
      setDecode(null);
      setAddCustomer(true);
      setAddVehicle(true);
    }
  }
  useEffect(() => {
    sending.current = false;
    if (state.another) customerInput.current?.focus();
    else if (state.error && state.field) focusBox(state.field);
  }, [state]);

  // The VIN, once it's a whole one: what it says about the unit.
  const vin = cleanVin(values.vin);
  const wholeVin = "vin" in vin && vin.vin?.length === 17 ? vin.vin : null;
  useEffect(() => {
    if (!wholeVin) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await decodeVinAction(wholeVin, sale?.id ?? "").catch(() => null);
      if (cancelled || !found) return;
      setDecode(found);
      // Filled in only where nothing's been typed: from this unit's own
      // earlier sale, the shop's last of its model, the model list, or a
      // customer's record of it. Sold before, it's back as a trade.
      setValues((old) => {
        const before = found.sold !== null && old.soldOn !== "" && found.sold.soldOn < old.soldOn;
        return {
          ...old,
          unitYear: old.unitYear || String(found.year ?? found.sold?.year ?? found.onFile?.year ?? ""),
          unitModel: old.unitModel || found.sold?.model || found.sameModel?.model || found.model || found.onFile?.model || "",
          category: old.category || found.sold?.category || found.sameModel?.category || found.category || "",
          condition: before && !touchedNow.current.has("condition") ? "used" : old.condition,
        };
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wholeVin, sale?.id]);
  const shownDecode = decode && decode.vin === wholeVin ? decode : null;
  const soldBefore = shownDecode?.sold ?? null;
  // The prices of the last of this model sold, to use with a click where
  // nothing's typed: they change, so they're offered, not filled in. A
  // rebate only from a sale of the month before (rebates run that long).
  const lastModel = shownDecode?.sameModel ?? null;
  const lastPrices: [MoneyField, number][] = [];
  if (lastModel?.msrp != null) lastPrices.push(["msrp", lastModel.msrp]);
  if (lastModel?.dealerCost != null) lastPrices.push(["dealerCost", lastModel.dealerCost]);
  if (lastModel?.rebate != null && values.soldOn && daysBetween(lastModel.soldOn, values.soldOn) <= 31) lastPrices.push(["rebate", lastModel.rebate]);
  const pricesToUse = lastPrices.filter(([name]) => values[name].trim() === "");

  // What the form works out until the person sets it: the category from the
  // model, the kind of deal from New/Used and the category, and the
  // holdback rate from the kind of deal.
  const condition = parseCondition(values.condition) ?? "new";
  const category = touched.has("category") || values.category ? values.category : (guessCategory(values.unitModel) ?? "");
  const unitType: UnitType = touched.has("unitType")
    ? (values.unitType as UnitType)
    : guessUnitType({ condition, category: category || null, model: values.unitModel || null });
  const holdbackRate = touched.has("holdbackRateBp") ? values.holdbackRateBp : unitType === "whole_good" ? blankSaleValues(defaults).holdbackRateBp : "0";
  const shown: SaleValues = { ...values, category, unitType, holdbackRateBp: holdbackRate, condition };

  const { sale: amounts, problems } = readSaleValues(shown);
  const boxProblems: Partial<Record<keyof SaleValues, string>> = {
    ...problems,
    ...("error" in vin ? { vin: vin.error } : {}),
    ...(serverProblem ? { [serverProblem.field]: serverProblem.error } : {}),
  };
  const figures = saleFigures(amounts);
  const flags = saleFlags({ ...amounts, condition, fundingReceivedOn: values.fundingReceivedOn || null, paidOn: values.paidOn || null });

  async function pickCustomer(choice: BuyerChoice) {
    if (choice.kind === "buyer") {
      // Someone the NUSR has sold to before: their latest details, and
      // they're added to Customers unless that's unticked.
      setCustomer(null);
      setValues((old) => ({ ...old, customerName: choice.name, customerPhone: choice.phone ?? "", customerAddress: choice.address ?? "" }));
      return;
    }
    setCustomer({ id: choice.id, name: choice.name, detail: choice.detail });
    // The search box goes: the focus goes to the Change button that's there now.
    requestAnimationFrame(() => changeButton.current?.focus());
    const details: SaleCustomer | null = await customerForSaleAction(choice.id).catch(() => null);
    // Their details as they're on file, blank where they have none; what
    // was typed stays only if they couldn't be loaded.
    setValues((old) => ({
      ...old,
      customerName: details?.name ?? choice.name,
      customerPhone: details ? (details.phone ?? "") : old.customerPhone,
      customerAddress: details ? (details.address ?? "") : old.customerAddress,
    }));
  }

  const onFileOrNew = customer !== null || (addCustomer && values.customerName.trim() !== "");

  return (
    <ProblemsContext.Provider value={boxProblems}>
    <form
      {...formProps}
      onSubmit={(event) => {
        event.preventDefault();
        if (sending.current) return;
        const first = (Object.keys(boxProblems) as (keyof SaleValues)[])[0];
        if (first && first !== serverProblem?.field) {
          setMessage({ error: boxProblems[first] });
          focusBox(first);
          return;
        }
        sending.current = true;
        formProps.onSubmit(event);
      }}
      onKeyDown={enterGoesOn}
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]"
      data-nusr-sale-form
    >
      {sale && <input type="hidden" name="id" value={sale.id} />}
      {back && <input type="hidden" name="back" value={back} />}
      <input type="hidden" name="customerId" value={customer?.id ?? ""} />
      <input ref={nextInput} type="hidden" name="next" defaultValue="done" />
      <datalist id="nusr-salespeople">
        {suggestions.salespeople.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="nusr-finance">
        {suggestions.financeCompanies.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="nusr-categories">
        {[...new Set([...CATEGORIES, ...suggestions.categories])].map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="nusr-models">
        {suggestions.models.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="nusr-coms">
        {suggestions.comsNumbers.map((number) => (
          <option key={number} value={number} />
        ))}
      </datalist>

      <div className="min-w-0 space-y-5">
        <Section title="The sale">
          <Field name="soldOn" values={values} set={set} type="date" required />
          <Field name="salesperson" values={values} set={set} list="nusr-salespeople" maxLength={SALE_LIMITS.salesperson} />
          <fieldset>
            <legend className={labelClass}>{SALE_LABELS.condition}</legend>
            <div className="mt-1.5 grid h-12 grid-cols-2 gap-1 rounded-lg border border-white/10 bg-forest-950/70 p-1">
              {(["new", "used"] as const).map((option) => (
                <label
                  key={option}
                  className={`flex cursor-pointer items-center justify-center rounded-md text-sm font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
                    condition === option ? "bg-glow/15 text-glow" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  <input
                    type="radio"
                    name="condition"
                    value={option}
                    checked={condition === option}
                    onChange={() => set("condition", option)}
                    className="sr-only"
                  />
                  {option === "new" ? "New" : "Used"}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="sale-unitType" className={labelClass}>
              {SALE_LABELS.unitType}
            </label>
            <select
              id="sale-unitType"
              name="unitType"
              value={unitType}
              onChange={(event) => set("unitType", event.target.value)}
              className={`${inputClass} appearance-none`}
            >
              {UNIT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {UNIT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <Field
            name="category"
            values={shown}
            set={set}
            list="nusr-categories"
            maxLength={SALE_LIMITS.category}
            hint={!touched.has("category") && !values.category && category ? "From the model." : undefined}
          />
        </Section>

        <Section title="Customer" columns="sm:grid-cols-2">
          <div className="sm:col-span-2">
            {customer ? (
              <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-glow/40 bg-glow/5 px-3.5 py-2" data-nusr-customer>
                <span className="min-w-0 text-sm break-words">
                  <span className="font-medium text-ink">{customer.name}</span>
                  <span className="text-ink-muted"> · on file{customer.detail ? ` · ${customer.detail}` : ""}</span>
                </span>
                <button
                  ref={changeButton}
                  type="button"
                  onClick={() => {
                    // Their details go with them: the next customer is picked or typed afresh.
                    setCustomer(null);
                    setValues((old) => ({ ...old, customerName: "", customerPhone: "", customerAddress: "" }));
                    requestAnimationFrame(() => customerInput.current?.focus());
                  }}
                  className="min-h-11 rounded-lg px-2 text-sm font-medium text-glow/90 hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
                >
                  Change
                </button>
              </div>
            ) : (
              <CustomerSearch onPick={(choice) => void pickCustomer(choice)} inputRef={customerInput} />
            )}
          </div>
          <Field name="customerName" values={values} set={set} required maxLength={SALE_LIMITS.customerName} wide />
          <Field name="customerPhone" values={values} set={set} type="tel" maxLength={SALE_LIMITS.customerPhone} />
          <Field name="customerAddress" values={values} set={set} maxLength={SALE_LIMITS.customerAddress} hint="Street, town, state ZIP" />
          {!customer && (
            <label className="flex min-h-11 items-center gap-3 text-sm text-ink sm:col-span-2">
              <input
                type="checkbox"
                name="addCustomer"
                value="on"
                checked={addCustomer}
                onChange={(event) => setAddCustomer(event.target.checked)}
                className="size-5 accent-glow"
              />
              Add them to Customers, so the next sale finds them
            </label>
          )}
          {onFileOrNew && wholeVin && (
            <label className="flex min-h-11 items-center gap-3 text-sm text-ink sm:col-span-2">
              <input
                type="checkbox"
                name="addVehicle"
                value="on"
                checked={addVehicle}
                onChange={(event) => setAddVehicle(event.target.checked)}
                className="size-5 accent-glow"
              />
              Add the unit to their vehicles as bought from us (unless it&apos;s there already)
            </label>
          )}
        </Section>

        <Section title="Unit">
          <Field
            name="vin"
            values={values}
            set={set}
            maxLength={SALE_LIMITS.vin + 6}
            spellCheck={false}
            autoCapitalize="characters"
            className={`${inputClass} font-mono tracking-wide uppercase`}
            wide
            hint={
              shownDecode ? (
                <>
                  {soldBefore ? (
                    <span className="text-trail" data-nusr-vin-sold>
                      In the NUSR already: sold {soldBefore.condition === "new" ? "new" : "used"} {formatDay(soldBefore.soldOn)} to {soldBefore.customerName}.{" "}
                      {values.soldOn && soldBefore.soldOn < values.soldOn ? "A trade coming back, so it's Used unless you say otherwise." : "Check it isn't logged twice."}{" "}
                    </span>
                  ) : null}
                  {shownDecode.model
                    ? `Model list: ${[shownDecode.year, shownDecode.model].filter(Boolean).join(" ")}${shownDecode.modelNumber ? ` (${shownDecode.modelNumber})` : ""}.`
                    : lastModel?.model
                      ? `A ${[shownDecode.year, lastModel.model].filter(Boolean).join(" ")}, as sold ${formatDay(lastModel.soldOn)}.`
                      : shownDecode.year
                        ? `A ${shownDecode.year}; not in the model list.`
                        : ""}
                  {shownDecode.onFile ? ` On file: ${shownDecode.onFile.label}, ${shownDecode.onFile.relation === "sold" ? "sold to us by" : "of"} ${shownDecode.onFile.customerName}.` : ""}
                  {!shownDecode.checkDigitOk ? " Its check digit doesn't match: a character may be off." : ""}
                </>
              ) : (
                "A whole VIN fills in the year and model from the shop's earlier sales and its model list."
              )
            }
          />
          <Field name="unitYear" values={values} set={set} inputMode="numeric" maxLength={4} />
          <Field name="unitModel" values={values} set={set} list="nusr-models" maxLength={SALE_LIMITS.unitModel} wide />
        </Section>

        <Section title="Unit price">
          {lastModel && pricesToUse.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-glow/30 bg-glow/5 px-3.5 py-2 text-sm sm:col-span-2 xl:col-span-3" data-nusr-last-prices>
              <p className="min-w-0 text-ink">
                The last {lastModel.model ?? "of this model"} sold, {formatDay(lastModel.soldOn)}:{" "}
                {lastPrices.map(([name, cents]) => `${SALE_LABELS[name]} ${formatMoney(cents)}`).join(" · ")}
              </p>
              <button
                type="button"
                onClick={() => {
                  for (const [name, cents] of pricesToUse) set(name, moneyInput(cents));
                }}
                className="min-h-11 rounded-lg px-3 text-sm font-medium text-glow hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
              >
                Use {pricesToUse.length === lastPrices.length ? "these" : "the rest"}
              </button>
            </div>
          )}
          {(["msrp", "salesPrice", "dealerCost", "unitLabor", "rebate"] as const).map((name) => (
            <MoneyField key={name} name={name} values={values} set={set} />
          ))}
        </Section>

        <Section title="Accessories">
          {(["accPrice", "accCost", "accLabor"] as const).map((name) => (
            <MoneyField key={name} name={name} values={values} set={set} />
          ))}
        </Section>

        <Section title="Service contract and rewards">
          {(["escPrice", "escCost", "rewards"] as const).map((name) => (
            <MoneyField key={name} name={name} values={values} set={set} />
          ))}
        </Section>

        <Section title="Financing and payoff">
          <Field name="financeCompany" values={values} set={set} list="nusr-finance" maxLength={SALE_LIMITS.financeCompany} hint="Blank for cash." />
          <MoneyField name="amountFinanced" values={values} set={set} />
          <MoneyField name="downPayment" values={values} set={set} />
          <Field
            name="fundingReceivedOn"
            values={values}
            set={set}
            type="date"
            hint={
              !values.fundingReceivedOn && values.soldOn && !values.amountFinanced.trim() ? (
                <button
                  type="button"
                  onClick={() => set("fundingReceivedOn", values.soldOn)}
                  className="-mx-1 inline-flex min-h-11 items-center px-1 font-medium text-glow/90 hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
                  data-nusr-same-day
                >
                  Same day as the sale (cash)
                </button>
              ) : undefined
            }
          />
          <Field name="paidOn" values={values} set={set} type="date" hint="When the unit was paid off." />
          <Field name="comsNumber" values={values} set={set} list="nusr-coms" maxLength={SALE_LIMITS.comsNumber} spellCheck={false} />
        </Section>

        <Section title="Holdback and bonus">
          <Field
            name="holdbackRateBp"
            values={shown}
            set={set}
            inputMode="decimal"
            hint={unitType === "whole_good" ? "% of MSRP." : "No holdback on this kind of deal."}
          />
          <Field name="bonusRateBp" values={values} set={set} inputMode="decimal" hint="% of the total profit." />
          <MoneyField name="bonusAdjustment" values={values} set={set} />
        </Section>

        <div className={sectionClass}>
          <label htmlFor="sale-notes" className={labelClass}>
            {SALE_LABELS.notes}
          </label>
          <textarea
            id="sale-notes"
            name="notes"
            value={values.notes}
            onChange={(event) => set("notes", event.target.value)}
            rows={3}
            maxLength={SALE_LIMITS.notes}
            className={`${inputBaseClass} mt-1.5 h-auto py-3`}
          />
        </div>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-4" aria-label="What it comes to">
        <div className={sectionClass} data-nusr-figures>
          <h2 className="text-base font-semibold text-ink">What it comes to</h2>
          <dl className="mt-3 divide-y divide-white/10 text-sm">
            <Figure label="Unit profit" value={formatMoney(figures.unitProfit)} sub={formatPct(figures.unitProfitPct)} />
            <Figure label="Acc. profit" value={formatMoney(figures.accProfit)} sub={formatPct(figures.accProfitPct)} />
            <Figure label="ESC profit" value={formatMoney(figures.escProfit)} />
            <Figure label="Holdback" value={formatMoney(figures.holdback)} />
            <Figure label="Total profit" value={formatMoney(figures.totalProfit)} sub={formatPct(figures.profitPct)} strong />
            <Figure label="Total bonus" value={formatMoney(figures.totalBonus)} />
            <Figure label="Holdback bonus" value={formatMoney(figures.holdbackBonus)} />
            <Figure label="Sales bonus" value={formatMoney(figures.salesBonus)} strong />
            {figures.discount !== null && <Figure label="Off MSRP" value={formatMoney(figures.discount)} />}
          </dl>
          {(flags.awaitingFunding || flags.notPaidOff) && (
            <p className="mt-3 text-xs leading-5 text-trail">
              {[flags.awaitingFunding && "Awaiting funding", flags.notPaidOff && "Not paid off yet"].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <Feedback state={message} />
        <div className="space-y-3">
          <button
            type="submit"
            aria-disabled={pending}
            onClick={() => {
              if (nextInput.current && !sending.current) nextInput.current.value = "done";
            }}
            className={`${primaryButtonClass} aria-disabled:cursor-wait aria-disabled:opacity-70`}
          >
            {sale ? (pending ? "Saving…" : "Save changes") : pending ? "Logging…" : "Log sale"}
          </button>
          {!sale && (
            <button
              type="submit"
              aria-disabled={pending}
              onClick={() => {
                if (nextInput.current && !sending.current) nextInput.current.value = "another";
              }}
              className={`${secondaryButtonClass} aria-disabled:cursor-wait aria-disabled:opacity-70`}
              data-nusr-another
            >
              Log and start another
            </button>
          )}
        </div>
      </aside>
    </form>
    </ProblemsContext.Provider>
  );
}

// A box by its field, to put the focus in it (New or Used by its choice).
function focusBox(field: string) {
  const box = field === "condition" ? document.querySelector<HTMLInputElement>('input[name="condition"]:checked') : document.getElementById(`sale-${field}`);
  box?.focus();
}

// Enter in a box goes on to the next one, as in a spreadsheet: only the
// buttons log or save the sale, so an Enter never sends half a sale.
function enterGoesOn(event: KeyboardEvent<HTMLFormElement>) {
  const target = event.target;
  if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
  if (!(target instanceof HTMLInputElement) || ["submit", "button", "file"].includes(target.type)) return;
  event.preventDefault();
  const boxes = [...event.currentTarget.querySelectorAll<HTMLElement>("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button[type=submit]")].filter(
    (box) => !(box instanceof HTMLInputElement && box.type === "radio" && !box.checked),
  );
  boxes[boxes.indexOf(target) + 1]?.focus();
}

const removeButtonClass =
  "h-12 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

// Remove, asking first; the Activity log keeps what the sale was.
export function RemoveSaleForm({ sale, back = "" }: { sale: { id: string; label: string }; back?: string }) {
  const { state, pending, formProps } = useFormAction<SaleFormState>(removeSaleAction, {});
  const [confirming, setConfirming] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={sale.id} />
      {back && <input type="hidden" name="back" value={back} />}
      <Feedback state={state} />
      {confirming ? (
        <div className="space-y-3">
          <p id="remove-question" className="text-sm text-ink">
            Remove the sale of {sale.label} from the NUSR? The Activity log keeps a record of what it was.
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
          Remove from the NUSR
        </button>
      )}
    </form>
  );
}
