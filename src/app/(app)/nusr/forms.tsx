"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type InputHTMLAttributes, type ReactNode, type RefObject } from "react";

import { Notice } from "@/components/app/ui";
import { inputBaseClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import type { SaleCustomer, VinDecode } from "@/lib/nusr";
import {
  CATEGORIES,
  SALE_LABELS,
  SALE_LIMITS,
  UNIT_TYPES,
  UNIT_TYPE_LABELS,
  blankSaleValues,
  cleanVin,
  formatMoney,
  formatPct,
  guessCategory,
  guessUnitType,
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

import { customerForSaleAction, decodeVinAction, removeSaleAction, saveSaleAction, searchSaleCustomersAction, type SaleFormState } from "./actions";

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

// --- The log's filters ---------------------------------------------------------------

type FilterOption = { value: string; label: string };

// A select that narrows the log as soon as it's changed; the other filters
// and the search stay.
export function LogFilter({ name, label, value, options, search }: { name: string; label: string; value: string; options: FilterOption[]; search: string }) {
  const router = useRouter();
  const id = useId();
  return (
    <div className="relative min-w-36 flex-1 sm:flex-none">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          const params = new URLSearchParams(search);
          if (event.target.value) params.set(name, event.target.value);
          else params.delete(name);
          // A month only means something within a year.
          if (name === "year") params.delete("month");
          params.delete("page");
          const next = params.toString();
          router.push(`/nusr${next ? `?${next}` : ""}`);
        }}
        className={`${inputBaseClass} h-11 appearance-none pr-9 text-sm`}
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

// A customer on file, found by name or phone number as it's typed (arrow
// keys and Enter, or a tap). Someone who isn't on file is simply typed into
// the boxes below.
function CustomerSearch({ onPick, inputRef }: { onPick: (choice: CustomerChoice) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ query: string; items: CustomerChoice[] }>({ query: "", items: [] });
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
  const choose = (choice: CustomerChoice) => {
    onPick(choice);
    setText("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <label htmlFor={id} className={labelClass}>
        Find a customer on file
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
            ? "Not on file: type their details below."
            : "Picking one fills in their name, phone and address."}
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
              {choice.detail && <span className="text-xs text-ink-muted">{choice.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- The sale ----------------------------------------------------------------------------

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
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
      />
      {hint && (
        <p id={`${id}-hint`} className={hintClass}>
          {hint}
        </p>
      )}
    </div>
  );
}

// An amount box: what's typed can be a sum ("1250+89.99"), as the
// spreadsheet's cells were, and says what it comes to.
function MoneyField({ name, values, set, problem }: { name: MoneyField; values: SaleValues; set: (name: keyof SaleValues, value: string) => void; problem?: string }) {
  const parsed = parseMoney(values[name]);
  const isSum = !("error" in parsed) && parsed.cents !== null && /\d\s*[+-]/.test(values[name]);
  return (
    <Field
      name={name}
      values={values}
      set={set}
      inputMode="decimal"
      spellCheck={false}
      className={`${inputClass} text-right tabular-nums`}
      aria-invalid={Boolean(problem)}
      hint={problem ? <span className="text-trail">{problem}</span> : isSum && "cents" in parsed ? `= ${formatMoney(parsed.cents)}` : undefined}
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
  lastComs: string | null;
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
}: {
  sale: SaleFormSale | null;
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
  const [addCustomer, setAddCustomer] = useState(true);
  const [addVehicle, setAddVehicle] = useState(true);
  // Boxes the person has set themselves, which the form then leaves alone.
  const [touched, setTouched] = useState<Set<keyof SaleValues>>(() => new Set(sale ? (Object.keys(sale.values) as (keyof SaleValues)[]) : []));
  const [decode, setDecode] = useState<VinDecode | null>(null);
  const [message, setMessage] = useState<SaleFormState>({});
  const customerInput = useRef<HTMLInputElement>(null);
  const nextInput = useRef<HTMLInputElement>(null);

  const set = (name: keyof SaleValues, value: string) => {
    setValues((old) => ({ ...old, [name]: value }));
    setTouched((old) => (old.has(name) ? old : new Set(old).add(name)));
  };

  // What came back: after logging one with "Log and start another", say so
  // and clear the sale, keeping the day, salesman and rates.
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setMessage(state);
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
    if (state.another) customerInput.current?.focus();
  }, [state]);

  // The VIN, once it's a whole one: what it says about the unit.
  const vin = cleanVin(values.vin);
  const wholeVin = "vin" in vin && vin.vin?.length === 17 ? vin.vin : null;
  useEffect(() => {
    if (!wholeVin) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await decodeVinAction(wholeVin).catch(() => null);
      if (cancelled || !found) return;
      setDecode(found);
      // Filled in only where nothing's been typed.
      setValues((old) => ({
        ...old,
        unitYear: old.unitYear || String(found.year ?? found.onFile?.year ?? ""),
        unitModel: old.unitModel || found.model || found.onFile?.model || "",
        category: old.category || found.category || "",
      }));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wholeVin]);
  const shownDecode = decode && decode.vin === wholeVin ? decode : null;

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
  const figures = saleFigures(amounts);
  const flags = saleFlags({ ...amounts, condition, fundingReceivedOn: values.fundingReceivedOn || null, paidOn: values.paidOn || null });

  async function pickCustomer(choice: CustomerChoice) {
    setCustomer(choice);
    const details: SaleCustomer | null = await customerForSaleAction(choice.id).catch(() => null);
    setValues((old) => ({
      ...old,
      customerName: details?.name ?? choice.name,
      customerPhone: details?.phone ?? old.customerPhone,
      customerAddress: details?.address ?? old.customerAddress,
    }));
  }

  const onFileOrNew = customer !== null || (addCustomer && values.customerName.trim() !== "");

  return (
    <form
      {...formProps}
      onSubmit={(event) => {
        if (Object.keys(problems).length > 0) {
          event.preventDefault();
          setMessage({ error: Object.values(problems)[0] });
          return;
        }
        formProps.onSubmit(event);
      }}
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]"
      data-nusr-sale-form
    >
      {sale && <input type="hidden" name="id" value={sale.id} />}
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
      <datalist id="nusr-coms">{suggestions.lastComs && <option value={suggestions.lastComs} />}</datalist>

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
                  type="button"
                  onClick={() => {
                    setCustomer(null);
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
              "error" in vin ? (
                <span className="text-trail">{vin.error}</span>
              ) : shownDecode ? (
                <>
                  {shownDecode.model ? `Model list: ${[shownDecode.year, shownDecode.model].filter(Boolean).join(" ")}${shownDecode.modelNumber ? ` (${shownDecode.modelNumber})` : ""}.` : shownDecode.year ? `A ${shownDecode.year}; not in the model list.` : ""}
                  {shownDecode.onFile ? ` On file: ${shownDecode.onFile.label}, ${shownDecode.onFile.relation === "sold" ? "sold to us by" : "of"} ${shownDecode.onFile.customerName}.` : ""}
                  {!shownDecode.checkDigitOk ? " Its check digit doesn't match: a character may be off." : ""}
                </>
              ) : (
                "A whole VIN fills in the year and model from the shop's model list."
              )
            }
          />
          <Field name="unitYear" values={values} set={set} inputMode="numeric" maxLength={4} />
          <Field name="unitModel" values={values} set={set} list="nusr-models" maxLength={SALE_LIMITS.unitModel} wide />
        </Section>

        <Section title="Unit price">
          {(["msrp", "salesPrice", "dealerCost", "unitLabor", "rebate"] as const).map((name) => (
            <MoneyField key={name} name={name} values={values} set={set} problem={problems[name]} />
          ))}
        </Section>

        <Section title="Accessories">
          {(["accPrice", "accCost", "accLabor"] as const).map((name) => (
            <MoneyField key={name} name={name} values={values} set={set} problem={problems[name]} />
          ))}
        </Section>

        <Section title="Service contract and rewards">
          {(["escPrice", "escCost", "rewards"] as const).map((name) => (
            <MoneyField key={name} name={name} values={values} set={set} problem={problems[name]} />
          ))}
        </Section>

        <Section title="Financing and payoff">
          <Field name="financeCompany" values={values} set={set} list="nusr-finance" maxLength={SALE_LIMITS.financeCompany} hint="Blank for cash." />
          <MoneyField name="amountFinanced" values={values} set={set} problem={problems.amountFinanced} />
          <MoneyField name="downPayment" values={values} set={set} problem={problems.downPayment} />
          <Field name="fundingReceivedOn" values={values} set={set} type="date" />
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
            aria-invalid={Boolean(problems.holdbackRateBp)}
          />
          <Field name="bonusRateBp" values={values} set={set} inputMode="decimal" hint="% of the total profit." aria-invalid={Boolean(problems.bonusRateBp)} />
          <MoneyField name="bonusAdjustment" values={values} set={set} problem={problems.bonusAdjustment} />
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
            disabled={pending}
            onClick={() => {
              if (nextInput.current) nextInput.current.value = "done";
            }}
            className={primaryButtonClass}
          >
            {sale ? (pending ? "Saving…" : "Save changes") : pending ? "Logging…" : "Log sale"}
          </button>
          {!sale && (
            <button
              type="submit"
              disabled={pending}
              onClick={() => {
                if (nextInput.current) nextInput.current.value = "another";
              }}
              className={secondaryButtonClass}
              data-nusr-another
            >
              Log and start another
            </button>
          )}
        </div>
      </aside>
    </form>
  );
}

const removeButtonClass =
  "h-12 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

// Remove, asking first; the Activity log keeps what the sale was.
export function RemoveSaleForm({ sale }: { sale: { id: string; label: string } }) {
  const { state, pending, formProps } = useFormAction<SaleFormState>(removeSaleAction, {});
  const [confirming, setConfirming] = useState(false);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={sale.id} />
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
              onClick={() => setConfirming(false)}
              className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={`${removeButtonClass} w-full`}>
          Remove from the NUSR
        </button>
      )}
    </form>
  );
}
