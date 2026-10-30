"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";

import { inputBaseClass } from "@/components/hud";
import { RELATION_LABELS, type ConversationCustomer, type CustomerVehicleChoice } from "@/lib/customer-rules";

import { linkCustomerAction, searchCustomerVehiclesAction } from "./actions";
import { PersonIcon } from "./icons";

// Diagnose's link to System Admin > Customers: which customer's vehicle a
// diagnosis is for. Only the customer's name and the vehicle show here,
// never how to reach them; those with access to Customers can open the
// record from the name.

// A box that finds customers' vehicles as the tech types: by the
// customer's name or phone number, or the vehicle's model, model number or
// VIN.
export function CustomerVehiclePicker({
  id,
  onPick,
  autoFocus = false,
}: {
  id: string;
  onPick: (choice: CustomerVehicleChoice) => void;
  autoFocus?: boolean;
}) {
  const listId = useId();
  const [value, setValue] = useState("");
  const [found, setFound] = useState<{ query: string; items: CustomerVehicleChoice[] } | null>(null);
  const [focused, setFocused] = useState(false);
  const query = value.trim();

  useEffect(() => {
    if (query.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const items = await searchCustomerVehiclesAction(query);
      if (!cancelled) setFound({ query, items });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const shown = found?.query === query ? found.items : null;
  const open = focused && query.length >= 2 && shown !== null;

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setFocused(true)}
        // Long enough for a tap on a suggestion to land first.
        onBlur={() => setTimeout(() => setFocused(false), 200)}
        placeholder="Customer's name or phone, or the VIN"
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        autoFocus={autoFocus}
        className={inputBaseClass}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Customers' vehicles"
          className="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-white/10 bg-charcoal-900 shadow-xl shadow-black/50"
        >
          {shown.length === 0 ? (
            <li className="px-3.5 py-3 text-sm text-ink-muted" role="option" aria-selected={false} aria-disabled>
              No customer&apos;s vehicle matches. Customers and their vehicles are added under System Admin.
            </li>
          ) : (
            shown.map((item) => (
              <li key={item.vehicleId} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onPick(item);
                    setValue("");
                    setFocused(false);
                  }}
                  className="flex min-h-12 w-full flex-col items-start justify-center px-3.5 py-2 text-left text-sm hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
                >
                  <span className="text-ink">
                    {item.customerName} <span className="text-ink-muted">·</span> {item.label}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {[RELATION_LABELS[item.relation], item.modelNumber, item.vin && `VIN …${item.vin.slice(-8)}`].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

const smallButtonClass =
  "inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-glow/90 transition hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

// "John Smith · 2021 Polaris Sportsman 850", the name a link to their
// record for those who can open it.
export function CustomerName({ customer, canOpen }: { customer: ConversationCustomer; canOpen: boolean }) {
  return (
    <>
      {canOpen ? (
        <Link
          href={`/admin/customers/${customer.customerId}/vehicles/${customer.vehicleId}`}
          className="font-medium text-glow/90 hover:text-glow hover:underline"
        >
          {customer.customerName}
        </Link>
      ) : (
        <span className="font-medium text-ink">{customer.customerName}</span>
      )}
      <span className="text-ink-muted"> · {customer.label}</span>
    </>
  );
}

// Under a diagnosis's title: whose vehicle it is, with Change and Unlink,
// or a way to link one.
export function CustomerLine({
  conversationId,
  customer,
  canOpen,
  onChange,
}: {
  conversationId: string;
  customer: ConversationCustomer | null;
  canOpen: boolean;
  onChange: (customer: ConversationCustomer | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pickerId = useId();

  async function link(vehicleId: string | null) {
    setPending(true);
    setMessage(null);
    const result = await linkCustomerAction({ conversationId, vehicleId }).catch(() => ({
      error: "That didn't go through. Check the connection and try again.",
    }));
    setPending(false);
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    onChange(result.customer);
    setEditing(false);
  }

  return (
    <div className="text-sm" data-customer-line>
      <p className="flex flex-wrap items-center gap-x-1 leading-6">
        <PersonIcon className="mr-0.5 size-3.5 shrink-0 text-ink-muted" />
        {customer ? (
          <span className="min-w-0 break-words">
            <span className="text-ink-muted">For </span>
            <CustomerName customer={customer} canOpen={canOpen} />
          </span>
        ) : (
          <span className="text-ink-muted">No customer linked</span>
        )}
        {!editing && (
          <button type="button" disabled={pending} onClick={() => setEditing(true)} className={`${smallButtonClass} -my-2`}>
            {customer ? "Change" : "Link a customer"}
          </button>
        )}
      </p>
      {editing && (
        <div className="mt-1 space-y-2">
          <label htmlFor={pickerId} className="sr-only">
            Customer&apos;s vehicle
          </label>
          <CustomerVehiclePicker id={pickerId} autoFocus onPick={(choice) => void link(choice.vehicleId)} />
          <div className="flex flex-wrap gap-2">
            {customer && (
              <button
                type="button"
                disabled={pending}
                onClick={() => void link(null)}
                className="inline-flex min-h-11 items-center rounded-lg border border-white/15 px-3 text-sm font-medium text-ink-muted transition hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60"
              >
                Unlink
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => setEditing(false)}
              className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="mt-1 text-sm text-trail">
          {message}
        </p>
      )}
    </div>
  );
}
