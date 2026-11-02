"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";

import { Notice } from "@/components/app/ui";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import {
  CUSTOMER_LIMITS,
  RELATION_DATE_LABELS,
  RELATION_HINTS,
  RELATION_LABELS,
  VEHICLE_LIMITS,
  VEHICLE_RELATIONS,
  type CustomerFields,
  type VehicleFields,
  type VehicleRelation,
} from "@/lib/customer-rules";
import { useFormAction } from "@/lib/use-form-action";

import {
  addCustomer,
  addVehicleAction,
  removeCustomerAction,
  removeVehicleAction,
  saveCustomer,
  saveVehicle,
  type FormState,
} from "./actions";

const hintClass = "mt-1 text-xs leading-5 text-ink-muted";

function Field({
  id,
  label,
  hint,
  optional = true,
  ...props
}: { id: string; label: string; hint?: string; optional?: boolean } & ComponentProps<"input">) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={labelClass}>
        {label}
        {optional && <span className="font-normal text-ink-muted"> (optional)</span>}
      </label>
      <input
        id={id}
        name={id}
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

function NotesField({ defaultValue, maxLength }: { defaultValue: string; maxLength: number }) {
  return (
    <div>
      <label htmlFor="notes" className={labelClass}>
        Notes <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <textarea
        // Keyed on the saved value, like the other fields (see CustomerForm).
        key={defaultValue}
        id="notes"
        name="notes"
        rows={3}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className={`${inputClass} h-auto py-3`}
      />
    </div>
  );
}

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

type SavedCustomer = CustomerFields & { id: string };

// Adds a customer, or edits one. Each field is keyed on its saved value:
// Next.js keeps visited pages alive, so when someone else changes the
// record the fields reload instead of posting old values back.
export function CustomerForm({ customer }: { customer?: SavedCustomer }) {
  const { state, pending, formProps } = useFormAction<FormState>(customer ? saveCustomer : addCustomer, {});
  const saved = (name: keyof CustomerFields) => customer?.[name] ?? "";
  const keyed = (name: keyof CustomerFields) => ({ key: saved(name), defaultValue: saved(name) });
  return (
    <form {...formProps} className="space-y-4">
      {customer && <input type="hidden" name="id" value={customer.id} />}
      <Field id="name" label="Name" optional={false} required autoComplete="off" maxLength={CUSTOMER_LIMITS.name} {...keyed("name")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="phone"
          label="Phone"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          maxLength={CUSTOMER_LIMITS.phone}
          placeholder="(555) 123-4567"
          {...keyed("phone")}
        />
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={CUSTOMER_LIMITS.email}
          {...keyed("email")}
        />
      </div>
      <Field id="addressLine1" label="Street address" autoComplete="off" maxLength={CUSTOMER_LIMITS.addressLine} {...keyed("addressLine1")} />
      <Field
        id="addressLine2"
        label="Apartment, suite or PO box"
        autoComplete="off"
        maxLength={CUSTOMER_LIMITS.addressLine}
        {...keyed("addressLine2")}
      />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="col-span-2 sm:col-span-1">
          <Field id="city" label="City" autoComplete="off" maxLength={CUSTOMER_LIMITS.city} {...keyed("city")} />
        </div>
        <Field id="state" label="State" autoComplete="off" maxLength={CUSTOMER_LIMITS.state} placeholder="PA" {...keyed("state")} />
        <Field id="postalCode" label="ZIP" autoComplete="off" maxLength={CUSTOMER_LIMITS.postalCode} {...keyed("postalCode")} />
      </div>
      <NotesField defaultValue={saved("notes")} maxLength={CUSTOMER_LIMITS.notes} />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={customer ? secondaryButtonClass : primaryButtonClass}>
        {customer ? (pending ? "Saving…" : "Save changes") : pending ? "Adding…" : "Add customer"}
      </button>
    </form>
  );
}

type SavedVehicle = VehicleFields & { id: string };

// How a vehicle is the customer's: three choices with what each means.
function RelationChoice({ value, onChange }: { value: VehicleRelation; onChange: (value: VehicleRelation) => void }) {
  return (
    <fieldset>
      <legend className={labelClass}>How it&apos;s theirs</legend>
      <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
        {VEHICLE_RELATIONS.map((relation) => (
          <label
            key={relation}
            className={`flex min-h-12 cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
              value === relation ? "border-glow/50 bg-glow/10" : "border-white/10 hover:border-white/20"
            }`}
          >
            <input
              type="radio"
              name="relation"
              value={relation}
              checked={value === relation}
              onChange={() => onChange(relation)}
              className="mt-1 accent-glow"
            />
            <span>
              <span className="block font-medium text-ink">{RELATION_LABELS[relation]}</span>
              <span className="block text-xs leading-5 text-ink-muted">{RELATION_HINTS[relation]}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// Adds a vehicle to a customer's record, or edits one.
export function VehicleForm({ customerId, vehicle }: { customerId: string; vehicle?: SavedVehicle }) {
  const { state, pending, formProps } = useFormAction<FormState>(vehicle ? saveVehicle : addVehicleAction, {});
  const [relation, setRelation] = useState<VehicleRelation>(vehicle?.relation ?? "bought");
  // A change saved elsewhere puts the choice back to what's saved.
  const [shownFor, setShownFor] = useState(vehicle?.relation);
  if (shownFor !== vehicle?.relation) {
    setShownFor(vehicle?.relation);
    if (vehicle) setRelation(vehicle.relation);
  }
  const saved = (name: keyof VehicleFields) => String(vehicle?.[name] ?? "");
  const keyed = (name: keyof VehicleFields) => ({ key: saved(name), defaultValue: saved(name) });
  const dateLabel = RELATION_DATE_LABELS[relation];
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="customerId" value={customerId} />
      {vehicle && <input type="hidden" name="id" value={vehicle.id} />}
      <RelationChoice value={relation} onChange={setRelation} />
      {dateLabel && (
        <div className="max-w-56">
          <Field id="relationDate" label={dateLabel} type="date" {...keyed("relationDate")} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)_minmax(0,2fr)]">
        <Field
          id="year"
          label="Year"
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
          autoComplete="off"
          placeholder="2021"
          {...keyed("year")}
        />
        <Field id="make" label="Make" autoComplete="off" maxLength={VEHICLE_LIMITS.make} placeholder="Polaris" {...keyed("make")} />
        <div className="col-span-2 sm:col-span-1">
          <Field id="model" label="Model" autoComplete="off" maxLength={VEHICLE_LIMITS.model} placeholder="Sportsman 850 Ultimate Trail" {...keyed("model")} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="modelNumber"
          label="Model number"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={VEHICLE_LIMITS.modelNumber}
          placeholder="A21SXZ85A1"
          hint="On the frame or VIN plate. Diagnose finds the unit's manuals by it."
          className={`${inputClass} font-mono uppercase placeholder:font-sans placeholder:normal-case`}
          {...keyed("modelNumber")}
        />
        <Field
          id="vin"
          label="VIN"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          placeholder="17 characters"
          hint="A whole VIN: a serial number on its own goes in the notes."
          className={`${inputClass} font-mono tracking-wide uppercase placeholder:font-sans placeholder:tracking-normal placeholder:normal-case`}
          {...keyed("vin")}
        />
      </div>
      <div className="max-w-xs">
        <Field id="color" label="Color" autoComplete="off" maxLength={VEHICLE_LIMITS.color} {...keyed("color")} />
      </div>
      <NotesField defaultValue={saved("notes")} maxLength={VEHICLE_LIMITS.notes} />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={vehicle ? secondaryButtonClass : primaryButtonClass}>
        {vehicle ? (pending ? "Saving…" : "Save changes") : pending ? "Adding…" : "Add vehicle"}
      </button>
    </form>
  );
}

const removeButtonClass =
  "h-12 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

// A Remove button that asks first.
function RemoveForm({
  action,
  fields,
  label,
  question,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  fields: Record<string, string>;
  label: string;
  question: string;
}) {
  const { state, pending, formProps } = useFormAction<FormState>(action, {});
  const [confirming, setConfirming] = useState(false);
  // Set by Cancel, so focus goes back to the button that opened the step.
  const returnFocus = useRef(false);
  const openButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      openButton.current?.focus();
    }
  }, [confirming]);

  return (
    <form {...formProps} className="space-y-4">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Feedback state={state} />
      {confirming ? (
        <div className="space-y-3">
          <p id="remove-question" className="text-sm text-ink">
            {question}
          </p>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={pending}
              // Focus moves into the step the user just opened.
              autoFocus
              aria-describedby="remove-question"
              className={`${removeButtonClass} flex-1`}
            >
              {pending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                returnFocus.current = true;
                setConfirming(false);
              }}
              className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button ref={openButton} type="button" onClick={() => setConfirming(true)} className={`${removeButtonClass} w-full`}>
          {label}
        </button>
      )}
    </form>
  );
}

export function RemoveCustomerForm({ customer }: { customer: { id: string; name: string } }) {
  return (
    <RemoveForm
      action={removeCustomerAction}
      fields={{ id: customer.id }}
      label="Remove customer"
      question={`Remove ${customer.name} and their vehicles from the shop's records? This can't be undone.`}
    />
  );
}

export function RemoveVehicleForm({ customerId, vehicle }: { customerId: string; vehicle: { id: string; label: string } }) {
  return (
    <RemoveForm
      action={removeVehicleAction}
      fields={{ customerId, id: vehicle.id }}
      label="Remove vehicle"
      question={`Remove the ${vehicle.label} from this customer's record? This can't be undone.`}
    />
  );
}
