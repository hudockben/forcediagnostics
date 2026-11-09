"use client";

import { useRef, useState, type InputHTMLAttributes } from "react";

import { Notice } from "@/components/app/ui";
import { inputClass, labelClass, primaryButtonClass } from "@/components/hud";
import { UNIT_LIMITS, type UnitFields, type UnitValues } from "@/lib/unit-list-rules";
import { useFormAction } from "@/lib/use-form-action";
import { checkVin } from "@/lib/vin";

import { addUnitAction, removeUnitAction, saveUnitAction, type FormState } from "./actions";

// A unit's form: typed in by hand (Add a unit) or corrected (a unit's own
// page), marked sold or put back in stock. Amount boxes take what the
// NUSR's do ("34,893.00", "34893"); what's wrong shows under its own box.

const hintClass = "mt-1 text-xs leading-5 text-ink-muted";
const removeButtonClass =
  "h-12 rounded-lg border border-trail/40 px-4 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

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

function Field({
  name,
  label,
  values,
  state,
  hint,
  className = "",
  ...props
}: {
  name: keyof UnitFields;
  label: string;
  values: UnitValues;
  state: FormState;
  hint?: string;
  className?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  const wrong = state.field === name;
  return (
    <div className={className}>
      <label htmlFor={`unit-${name}`} className={labelClass}>
        {label}
      </label>
      <input id={`unit-${name}`} name={name} defaultValue={values[name]} aria-invalid={wrong || undefined} aria-describedby={hint ? `unit-${name}-hint` : undefined} className={inputClass} {...props} />
      {hint && (
        <p id={`unit-${name}-hint`} className={hintClass}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function UnitForm({ id, values, today }: { id?: string; values: UnitValues; today: string }) {
  const { state, pending, formProps } = useFormAction<FormState>(id ? saveUnitAction : addUnitAction, {});
  const [vin, setVin] = useState(values.vin);
  const sold = useRef<HTMLInputElement>(null);
  const check = checkVin(vin);
  return (
    <form {...formProps} className="space-y-5" data-unit-form>
      {id && <input type="hidden" name="id" value={id} />}
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-6">
        <Field name="unitYear" label="Year" values={values} state={state} inputMode="numeric" maxLength={4} className="sm:col-span-1" />
        <Field name="model" label="Model" values={values} state={state} maxLength={UNIT_LIMITS.model} required className="sm:col-span-5" hint="As the list shows it, such as Rngr 1000 XP NSU Crew - Blue Lab." />
        <div className="sm:col-span-3">
          <label htmlFor="unit-vin" className={labelClass}>
            VIN
          </label>
          <input
            id="unit-vin"
            name="vin"
            value={vin}
            onChange={(event) => setVin(event.currentTarget.value.toUpperCase())}
            maxLength={UNIT_LIMITS.vin}
            required
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={state.field === "vin" || (check.status === "ok" && !check.checkDigitOk) || undefined}
            aria-describedby="unit-vin-hint"
            className={`${inputClass} font-mono tracking-wide`}
          />
          <p id="unit-vin-hint" className={`${hintClass} ${check.status === "ok" && check.checkDigitOk ? "" : check.status === "empty" ? "" : "text-trail"}`}>
            {check.status === "ok" ? (check.checkDigitOk ? "Check digit matches." : check.warning) : check.status === "empty" ? "All 17 characters." : check.message}
          </p>
        </div>
        <Field name="receivedOn" label="Received" values={values} state={state} type="date" required className="sm:col-span-3" />
        <Field name="cost" label="Cost" values={values} state={state} inputMode="decimal" className="sm:col-span-2 [&_input]:font-mono" hint="What it cost: the invoice's Unit Price." />
        <Field name="listPrice" label="List Price" values={values} state={state} inputMode="decimal" className="sm:col-span-2 [&_input]:font-mono" />
        <div className="sm:col-span-2">
          <label htmlFor="unit-soldOn" className={labelClass}>
            Sold
          </label>
          <input ref={sold} id="unit-soldOn" name="soldOn" type="date" defaultValue={values.soldOn} aria-invalid={state.field === "soldOn" || undefined} aria-describedby="unit-soldOn-hint" className={inputClass} />
          <p id="unit-soldOn-hint" className={hintClass}>
            Blank while it&apos;s in stock.{" "}
            <button
              type="button"
              onClick={() => {
                if (sold.current) sold.current.value = today;
              }}
              className="text-glow/90 hover:text-glow hover:underline focus-visible:underline focus-visible:outline-none"
            >
              Today
            </button>
            {" · "}
            <button
              type="button"
              onClick={() => {
                if (sold.current) sold.current.value = "";
              }}
              className="text-glow/90 hover:text-glow hover:underline focus-visible:underline focus-visible:outline-none"
            >
              In stock
            </button>
          </p>
        </div>
        <Field name="modelNumber" label="Model number" values={values} state={state} maxLength={UNIT_LIMITS.modelNumber} className="sm:col-span-2 [&_input]:font-mono" hint="Polaris's, such as R27RSY99AA." />
        <Field name="description" label="Polaris's description" values={values} state={state} maxLength={UNIT_LIMITS.description} className="sm:col-span-2" />
        <Field name="engineNumber" label="Engine #" values={values} state={state} maxLength={UNIT_LIMITS.engineNumber} className="sm:col-span-2 [&_input]:font-mono" />
        <Field name="notes" label="Notes" values={values} state={state} maxLength={UNIT_LIMITS.notes} className="sm:col-span-6" />
      </div>
      <button type="submit" disabled={pending} className={primaryButtonClass} data-unit-save>
        {pending ? "Saving…" : id ? "Save" : "Add to the list"}
      </button>
    </form>
  );
}

export function RemoveUnitForm({ unit }: { unit: { id: string; name: string } }) {
  const { state, pending, formProps } = useFormAction<FormState>(removeUnitAction, {});
  const [confirming, setConfirming] = useState(false);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={unit.id} />
      <Feedback state={state} />
      {confirming ? (
        <div className="space-y-3">
          <p id="remove-question" className="text-sm text-ink">
            Remove {unit.name} from the list? The Activity log keeps a record that it was removed.
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
          Remove from the list
        </button>
      )}
    </form>
  );
}
