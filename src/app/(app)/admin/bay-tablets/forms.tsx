"use client";

import { useEffect, useRef, useState } from "react";

import { Notice } from "@/components/app/ui";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { useFormAction } from "@/lib/use-form-action";

import { addTablet, removeTablet, repairTablet, unlockStaffPin, type TabletState } from "./actions";

function Feedback({ state }: { state: TabletState }) {
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

function PairingCode({ pairing }: { pairing: NonNullable<TabletState["pairing"]> }) {
  const expires = new Date(pairing.expiresAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className="rounded-xl border border-glow/30 bg-glow/5 p-5 text-center">
      <p className="text-sm text-ink-muted">Pairing code for {pairing.name}</p>
      <p className="mt-2 font-mono text-4xl font-semibold tracking-[0.2em] text-glow">{pairing.code}</p>
      <p className="mt-3 text-sm leading-6 text-ink-muted">
        On the tablet, open <span className="font-mono text-ink">www.forcediagnostics.ai/bay</span> and
        type this code. It works once, until {expires}. If it runs out, use New pairing code next to the
        tablet in the list.
      </p>
    </div>
  );
}

export function AddTabletForm() {
  const { state, pending, formProps } = useFormAction<TabletState>(addTablet, {});
  // Empty the name once the tablet is added, so pressing again doesn't add
  // a second one.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.pairing) form.current?.reset();
  }, [state]);
  return (
    <div className="space-y-4">
      {state.pairing && <PairingCode pairing={state.pairing} />}
      <form ref={form} {...formProps} className="space-y-4">
        <div>
          <label htmlFor="tablet-name" className={labelClass}>
            Tablet name
          </label>
          <input
            id="tablet-name"
            name="name"
            required
            maxLength={40}
            placeholder="Bay 3"
            autoComplete="off"
            className={inputClass}
          />
        </div>
        <Feedback state={state} />
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Making a code…" : "Get pairing code"}
        </button>
      </form>
    </div>
  );
}

export function TabletActions({ id, name }: { id: string; name: string }) {
  const repair = useFormAction<TabletState>(repairTablet, {});
  const remove = useFormAction<TabletState>(removeTablet, {});
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-3">
      {repair.state.pairing && <PairingCode pairing={repair.state.pairing} />}
      <Feedback state={repair.state.error ? repair.state : remove.state} />
      {confirming ? (
        <form {...remove.formProps} className="space-y-3">
          <input type="hidden" name="id" value={id} />
          <p id={`remove-${id}`} className="text-sm text-ink">
            Remove {name}? Anyone signed in on it is signed out, and it needs a new pairing code to be
            used again.
          </p>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={remove.pending}
              // Focus moves into the step the user just opened.
              autoFocus
              aria-describedby={`remove-${id}`}
              className="h-12 flex-1 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60"
            >
              {remove.pending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              disabled={remove.pending}
              onClick={() => setConfirming(false)}
              className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-3">
          <form {...repair.formProps} className="flex-1">
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={repair.pending} className={secondaryButtonClass}>
              {repair.pending ? "Making a code…" : "New pairing code"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="h-12 rounded-lg border border-trail/40 px-4 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

export function UnlockPinForm({ userId, name, allowed }: { userId: string; name: string; allowed: boolean }) {
  const { state, pending, formProps } = useFormAction<TabletState>(unlockStaffPin, {});
  if (!allowed) return <p className="text-sm text-ink-muted">Only an admin can unlock this PIN.</p>;
  return (
    <form {...formProps} className="space-y-2">
      <input type="hidden" name="userId" value={userId} />
      <Feedback state={state} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Unlock ${name}'s PIN`}
        className={`${secondaryButtonClass} sm:w-40`}
      >
        {pending ? "Unlocking…" : "Unlock"}
      </button>
    </form>
  );
}
