"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type ComponentProps } from "react";

import { Notice } from "@/components/app/ui";
import { inputBaseClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { listHref } from "@/lib/diagnose-list-rules";
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

// Adds a supplier, or edits one. A Category Code the shop already uses
// fills in its Category ID (when that's still empty), so a category keeps
// one ID across the list.
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
  const [categoryId, setCategoryId] = useState(supplier?.categoryId ?? "");
  const listId = useId();
  const saved = (field: keyof SupplierFields) => supplier?.[field] ?? "";
  return (
    <form {...formProps} className="space-y-4">
      {supplier && <input type="hidden" name="id" value={supplier.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="supplierId"
          required
          // Keyed on the saved value: Next.js keeps visited pages alive, so
          // a change saved elsewhere reloads the field.
          key={`id-${saved("supplierId")}`}
          defaultValue={saved("supplierId") || suggestedId || ""}
          hint={!supplier && suggestedId ? "The next number after the highest Supplier ID. Change it to match your system if needed." : undefined}
          className={`${inputClass} font-mono`}
        />
        <Field name="supplierCode" optional key={`code-${saved("supplierCode")}`} defaultValue={saved("supplierCode")} className={`${inputClass} font-mono`} />
      </div>
      <Field name="supplierName" required key={`name-${saved("supplierName")}`} defaultValue={saved("supplierName")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="categoryCode"
          optional
          key={`cat-${saved("categoryCode")}`}
          defaultValue={saved("categoryCode")}
          list={listId}
          onChange={(event) => {
            const known = categories.find((category) => category.code.toLowerCase() === event.target.value.trim().toLowerCase());
            if (known?.id && !categoryId) setCategoryId(known.id);
          }}
          className={`${inputClass} font-mono`}
        />
        <Field
          name="categoryId"
          optional
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
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
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={supplier ? secondaryButtonClass : primaryButtonClass}>
        {supplier ? (pending ? "Saving…" : "Save changes") : pending ? "Adding…" : "Add supplier"}
      </button>
    </form>
  );
}

const removeButtonClass =
  "h-12 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

export function RemoveSupplierForm({ supplier }: { supplier: { id: string; supplierName: string } }) {
  const { state, pending, formProps } = useFormAction<FormState>(removeSupplierAction, {});
  const [confirming, setConfirming] = useState(false);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={supplier.id} />
      <Feedback state={state} />
      {confirming ? (
        <div className="space-y-3">
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
              onClick={() => setConfirming(false)}
              className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={`${removeButtonClass} w-full`}>
          Remove supplier
        </button>
      )}
    </form>
  );
}

// Narrows the list to one Category Code; the search stays.
export function CategoryFilter({ categories, category, query }: { categories: Category[]; category: string | null; query: string }) {
  const router = useRouter();
  return (
    <div className="relative min-w-48">
      <label htmlFor="supplier-category" className="sr-only">
        Category Code
      </label>
      <select
        id="supplier-category"
        value={category ?? ""}
        onChange={(event) => {
          const value = event.target.value;
          router.push(listHref(query, 1, value ? `/admin/suppliers?category=${encodeURIComponent(value)}` : "/admin/suppliers"));
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
