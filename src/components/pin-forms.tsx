"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";

import { Notice } from "@/components/app/ui";
import { inputClass, labelClass, secondaryButtonClass } from "@/components/hud";
import { PasswordInput } from "@/components/password-input";
import { PIN_MAX_LENGTH, checkPin } from "@/lib/pin-rules";
import { useFormAction } from "@/lib/use-form-action";

type State = { error?: string; success?: string };
type Action = (state: State, form: FormData) => Promise<State>;

function Feedback({ state }: { state: State }) {
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

function PinInput({ id, label, ...props }: { id: string; label: string } & ComponentProps<"input">) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        required
        maxLength={PIN_MAX_LENGTH}
        className={`${inputClass} font-mono tracking-[0.3em]`}
        {...props}
      />
    </div>
  );
}

// New PIN + confirmation, with the PIN rules checked as you type. Pass
// `withPassword` when the person sets their own PIN.
export function SetPinForm({
  action,
  hiddenFields,
  withPassword,
  submitLabel,
}: {
  action: Action;
  hiddenFields?: Record<string, string>;
  withPassword?: boolean;
  submitLabel: string;
}) {
  const { state, pending, formProps } = useFormAction<State>(action, {});
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  // Clear the PINs once one is saved, and the password with them.
  const [shownState, setShownState] = useState(state);
  if (shownState !== state) {
    setShownState(state);
    if (state.success) {
      setPin("");
      setConfirmPin("");
    }
  }
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.success) form.current?.reset();
  }, [state]);
  const hint = pin.length >= 4 ? checkPin(pin) : null;

  return (
    <form ref={form} {...formProps} className="space-y-4">
      {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="grid gap-4 sm:grid-cols-2">
        <PinInput
          id="pin"
          label="New PIN"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          aria-describedby="pin-hint"
        />
        <PinInput
          id="confirmPin"
          label="Confirm PIN"
          value={confirmPin}
          onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))}
        />
      </div>
      <p id="pin-hint" aria-live="polite" className="text-xs leading-5 text-ink-muted">
        {hint ?? "4–6 digits. Not a run like 1234, a repeat like 1111, or a year."}
      </p>
      {withPassword && (
        <div>
          <label htmlFor="pin-password" className={labelClass}>
            Your password
          </label>
          <PasswordInput id="pin-password" name="password" required autoComplete="current-password" />
        </div>
      )}
      <Feedback state={state} />
      <button type="submit" disabled={pending || Boolean(hint)} className={secondaryButtonClass}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

// A one-button form (remove, unlock), optionally asking for your password.
export function PinButtonForm({
  action,
  hiddenFields,
  withPassword,
  label,
  pendingLabel,
}: {
  action: Action;
  hiddenFields?: Record<string, string>;
  withPassword?: boolean;
  label: string;
  pendingLabel: string;
}) {
  const { state, pending, formProps } = useFormAction<State>(action, {});
  const [open, setOpen] = useState(!withPassword);
  return (
    <form {...formProps} className="space-y-3">
      {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {withPassword && open && (
        <div>
          <label htmlFor={`password-${label}`} className={labelClass}>
            Your password
          </label>
          <PasswordInput id={`password-${label}`} name="password" required autoComplete="current-password" />
        </div>
      )}
      <Feedback state={state} />
      <button
        type={open ? "submit" : "button"}
        onClick={open ? undefined : () => setOpen(true)}
        disabled={pending}
        className="h-12 w-full rounded-lg border border-white/15 text-base text-ink-muted transition hover:border-white/30 hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60"
      >
        {pending ? pendingLabel : label}
      </button>
    </form>
  );
}
