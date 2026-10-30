"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useEffect, useId, useRef, useState, useTransition, type ComponentProps, type ReactNode, type TransitionStartFunction } from "react";

import { Notice } from "@/components/app/ui";
import { inputBaseClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { cleanListQuery, listHref } from "@/lib/diagnose-list-rules";
import { SUPPLIER_FIELD_LABELS, SUPPLIER_LIMITS, type SupplierField, type SupplierFields } from "@/lib/supplier-rules";
import { useFormAction } from "@/lib/use-form-action";

import { addSupplierAction, removeSupplierAction, saveSupplierAction, type FormState } from "./actions";

type Category = { code: string; id: string | null; suppliers: number };

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

function Field({ name, optional = false, hint, ...props }: { name: SupplierField; optional?: boolean; hint?: string } & ComponentProps<"input">) {
  return (
    <div className="min-w-0">
      <label htmlFor={name} className={labelClass}>
        {SUPPLIER_FIELD_LABELS[name]}
        {optional && <span className="font-normal text-ink-muted"> (optional)</span>}
      </label>
      <input
        id={name}
        name={name}
        maxLength={SUPPLIER_LIMITS[name]}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={hint ? `${name}-hint` : undefined}
        className={inputClass}
        {...props}
      />
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-xs leading-5 text-ink-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

// Adds a supplier, or edits one.
export function SupplierForm({
  supplier,
  suggestedId,
  categories,
}: {
  supplier?: SupplierFields & { id: string };
  suggestedId?: string | null;
  categories: Category[];
}) {
  const { state, pending, formProps } = useFormAction<FormState>(supplier ? saveSupplierAction : addSupplierAction, {});
  const saved = (field: keyof SupplierFields) => supplier?.[field] ?? "";
  // Each field is keyed on its saved value: Next.js keeps visited pages
  // alive, so a change saved elsewhere reloads it.
  return (
    <form {...formProps} className="space-y-4">
      {supplier && <input type="hidden" name="id" value={supplier.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="supplierId"
          required
          key={`id-${saved("supplierId")}`}
          defaultValue={saved("supplierId") || suggestedId || ""}
          hint={!supplier && suggestedId ? "The next number after the highest Supplier ID. Change it to match your system if needed." : undefined}
          className={`${inputClass} font-mono`}
        />
        <Field name="supplierCode" optional key={`code-${saved("supplierCode")}`} defaultValue={saved("supplierCode")} className={`${inputClass} font-mono`} />
      </div>
      <Field name="supplierName" required key={`name-${saved("supplierName")}`} defaultValue={saved("supplierName")} />
      <CategoryFields
        key={`cat-${saved("categoryCode")}\u0000${saved("categoryId")}`}
        categories={categories}
        savedCode={saved("categoryCode")}
        savedId={saved("categoryId")}
      />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={supplier ? secondaryButtonClass : primaryButtonClass}>
        {supplier ? (pending ? "Saving…" : "Save changes") : pending ? "Adding…" : "Add supplier"}
      </button>
    </form>
  );
}

// A Category Code the shop already uses fills in its usual Category ID, so
// a category keeps one ID across the list: while the ID is empty, or still
// the one filled in (typing "10" goes past "1" and ends on 10's ID). An ID
// typed, or already saved, stays.
function CategoryFields({ categories, savedCode, savedId }: { categories: Category[]; savedCode: string; savedId: string }) {
  const [categoryId, setCategoryId] = useState(savedId);
  const [filledFrom, setFilledFrom] = useState<string | null>(null);
  const listId = useId();
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="categoryCode"
          optional
          defaultValue={savedCode}
          list={listId}
          onChange={(event) => {
            if (categoryId && filledFrom === null) return;
            const code = event.target.value.trim().toLowerCase();
            const known = categories.find((category) => category.id && category.code.toLowerCase() === code);
            setCategoryId(known?.id ?? "");
            setFilledFrom(known?.code ?? null);
          }}
          className={`${inputClass} font-mono`}
        />
        <Field
          name="categoryId"
          optional
          value={categoryId}
          hint={filledFrom ? `Filled in: the Category ID of the shop's other ${filledFrom} suppliers.` : undefined}
          onChange={(event) => {
            setCategoryId(event.target.value);
            setFilledFrom(null);
          }}
          className={`${inputClass} font-mono`}
        />
      </div>
      <datalist id={listId}>
        {categories.map((category) => (
          <option key={category.code} value={category.code}>
            {category.id ? `Category ID ${category.id}` : ""}
          </option>
        ))}
      </datalist>
    </>
  );
}

const removeButtonClass =
  "h-12 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

export function RemoveSupplierForm({ supplier }: { supplier: { id: string; supplierName: string } }) {
  const { state, pending, formProps } = useFormAction<FormState>(removeSupplierAction, {});
  const [confirming, setConfirming] = useState(false);
  // Cancel (or Escape) puts focus back on the button that asked.
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
      <input type="hidden" name="id" value={supplier.id} />
      <Feedback state={state} />
      {confirming ? (
        <div
          className="space-y-3"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) {
              cancelled.current = true;
              setConfirming(false);
            }
          }}
        >
          <p id="remove-question" className="text-sm text-ink">
            Remove {supplier.supplierName} from the supplier list? The audit log keeps a record that it was removed.
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
          Remove supplier
        </button>
      )}
    </form>
  );
}

// The Category Code select and the list share one transition, so the list
// dims while a category loads, as it does for a search.
const ListTransition = createContext<[boolean, TransitionStartFunction]>([false, (callback) => void callback()]);

export function CategoryTransition({ children }: { children: ReactNode }) {
  const transition = useTransition();
  return <ListTransition value={transition}>{children}</ListTransition>;
}

export function CategoryPending({ children }: { children: ReactNode }) {
  const [pending] = use(ListTransition);
  return (
    <div aria-busy={pending || undefined} className={`transition-opacity ${pending ? "opacity-60" : ""}`}>
      {children}
    </div>
  );
}

// Narrows the list to one Category Code. The search stays: what's in the
// search box, also a search still on its way.
export function CategoryFilter({ categories, category }: { categories: Category[]; category: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = use(ListTransition);
  // The category picked shows while it loads.
  const [picked, setPicked] = useState("");
  return (
    <div className="relative min-w-48">
      <label htmlFor="supplier-category" className="sr-only">
        Category Code
      </label>
      <select
        id="supplier-category"
        value={pending ? picked : (category ?? "")}
        onChange={(event) => {
          const value = event.target.value;
          const box = document.querySelector<HTMLInputElement>("[data-list-search]");
          const query = cleanListQuery(box?.value ?? "");
          setPicked(value);
          startTransition(() => router.push(listHref(query, 1, value ? `/admin/suppliers?category=${encodeURIComponent(value)}` : "/admin/suppliers")));
        }}
        className={`${inputBaseClass} h-11 appearance-none pr-9 text-sm`}
      >
        <option value="">Every category</option>
        {categories.map((option) => (
          <option key={option.code} value={option.code}>
            {option.code} ({option.suppliers})
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
