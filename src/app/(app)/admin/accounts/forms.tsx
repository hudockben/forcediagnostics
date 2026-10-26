"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";

import { Notice } from "@/components/app/ui";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { PasswordInput } from "@/components/password-input";
import { ROLE_LABELS, ROLE_SUMMARIES } from "@/lib/permissions";
import { ROLES, type Role } from "@/lib/roles";
import { useFormAction } from "@/lib/use-form-action";

import { addStaff, resetPassword, saveDetails, setDisabled, type FormState } from "./actions";

const MIN_PASSWORD_LENGTH = 8;

const hintClass = "mt-1 text-xs leading-5 text-ink-muted";

function Field({
  id,
  label,
  hint,
  ...props
}: { id: string; label: string; hint?: string } & ComponentProps<"input">) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
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

function RoleSelect({
  defaultValue = "tech",
  disabled,
  hint,
}: {
  defaultValue?: Role;
  disabled?: boolean;
  hint?: string;
}) {
  const [role, setRole] = useState<Role>(defaultValue);
  return (
    <div>
      <label htmlFor="role" className={labelClass}>
        Role
      </label>
      <div className="relative">
        <select
          id="role"
          name="role"
          value={role}
          disabled={disabled}
          aria-describedby="role-hint"
          onChange={(event) => setRole(event.target.value as Role)}
          className={`${inputClass} appearance-none pr-10 disabled:opacity-60`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="pointer-events-none absolute top-1/2 right-3.5 mt-0.75 size-4 -translate-y-1/2 fill-none stroke-ink-muted"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m5 8 5 5 5-5" />
        </svg>
      </div>
      {/* A disabled select isn't submitted, so send the current role along. */}
      {disabled && <input type="hidden" name="role" value={role} />}
      <p id="role-hint" className={hintClass}>
        {hint ?? ROLE_SUMMARIES[role]}
      </p>
    </div>
  );
}

// Readable random passwords for admins to hand to staff: no look-alike
// characters (0/O, 1/l/I), grouped in fours.
const PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

function generatePassword() {
  const chars: string[] = [];
  const bytes = new Uint8Array(1);
  while (chars.length < 12) {
    crypto.getRandomValues(bytes);
    // Skip values that would bias the pick toward the start of the alphabet.
    if (bytes[0] < 256 - (256 % PASSWORD_ALPHABET.length)) {
      chars.push(PASSWORD_ALPHABET[bytes[0] % PASSWORD_ALPHABET.length]);
    }
  }
  return chars.join("").match(/.{4}/g)!.join("-");
}

function NewPasswordField({ label, onEdit }: { label: string; onEdit?: () => void }) {
  const [password, setPassword] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor="password" className={labelClass}>
          {label}
        </label>
        <button
          type="button"
          onClick={() => {
            const value = generatePassword();
            setPassword(value);
            setGenerated(value);
            onEdit?.();
          }}
          className="rounded text-sm text-glow/90 hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          Generate one
        </button>
      </div>
      <PasswordInput
        id="password"
        name="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        autoComplete="new-password"
        aria-describedby="password-hint"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          setGenerated(null);
          onEdit?.();
        }}
      />
      {/* Always present and live, so a generated password is read out. */}
      <p id="password-hint" aria-live="polite" className={hintClass}>
        {generated ? (
          <>
            Generated <span className="font-mono text-ink">{generated}</span>. Save it, then give it
            to them; they can change it on their account page.
          </>
        ) : (
          `At least ${MIN_PASSWORD_LENGTH} characters.`
        )}
      </p>
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

export function AddStaffForm({ companyCode }: { companyCode: string }) {
  const { state, pending, formProps } = useFormAction<FormState>(addStaff, {});
  return (
    <form {...formProps} className="space-y-4">
      <Field id="name" label="Name" required autoComplete="off" maxLength={80} />
      <Field
        id="username"
        label="Username"
        required
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={30}
        hint={`Letters, numbers, dots or underscores. They sign in with company code ${companyCode.toUpperCase()} and this username.`}
      />
      <RoleSelect />
      <NewPasswordField label="Starting password" />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? "Adding…" : "Add staff member"}
      </button>
    </form>
  );
}

type Member = { id: string; name: string; role: Role; disabled: boolean };

export function DetailsForm({ member, isSelf }: { member: Member; isSelf: boolean }) {
  const { state, pending, formProps } = useFormAction<FormState>(saveDetails, {});
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={member.id} />
      {/* Keyed on the saved values: Next.js keeps visited pages alive, so if
          another admin changes this account, the fields reload instead of
          posting old values back. */}
      <Field
        key={member.name}
        id="name"
        label="Name"
        required
        defaultValue={member.name}
        maxLength={80}
      />
      <RoleSelect
        key={member.role}
        defaultValue={member.role}
        disabled={isSelf}
        hint={isSelf ? "You can't change your own role." : undefined}
      />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

export function ResetPasswordForm({ member }: { member: Member }) {
  const { state, pending, formProps } = useFormAction<FormState>(resetPassword, {});
  // Once the password field changes again, the last result no longer applies.
  const [edited, setEdited] = useState(false);
  return (
    <form
      {...formProps}
      onSubmit={(event) => {
        setEdited(false);
        formProps.onSubmit(event);
      }}
      className="space-y-4"
    >
      <input type="hidden" name="id" value={member.id} />
      <NewPasswordField label="New password" onEdit={() => setEdited(true)} />
      <Feedback state={edited ? {} : state} />
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}

const disableButtonClass =
  "h-12 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

export function DisableForm({ member }: { member: Member }) {
  const { state, pending, formProps } = useFormAction<FormState>(setDisabled, {});
  const [confirming, setConfirming] = useState(false);
  // Set by Cancel, so focus goes back to the button that opened the step.
  const returnFocus = useRef(false);
  const disableButton = useRef<HTMLButtonElement>(null);
  const disabling = !member.disabled;

  // Close the confirmation once the account's state has actually changed.
  const [shownFor, setShownFor] = useState(member.disabled);
  if (shownFor !== member.disabled) {
    setShownFor(member.disabled);
    setConfirming(false);
  }

  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      disableButton.current?.focus();
    }
  }, [confirming]);

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="id" value={member.id} />
      <input type="hidden" name="disable" value={String(disabling)} />
      <Feedback state={state} />
      {disabling && confirming ? (
        <div className="space-y-3">
          <p id="disable-question" className="text-sm text-ink">
            Disable {member.name}? They&apos;ll be signed out everywhere and can&apos;t sign in until
            an admin turns the account back on.
          </p>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={pending}
              // Focus moves into the step the user just opened.
              autoFocus
              aria-describedby="disable-question"
              className={`${disableButtonClass} flex-1`}
            >
              {pending ? "Disabling…" : "Yes, disable"}
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
      ) : disabling ? (
        <button
          ref={disableButton}
          type="button"
          onClick={() => setConfirming(true)}
          className={`${disableButtonClass} w-full`}
        >
          Disable account
        </button>
      ) : (
        <button type="submit" disabled={pending} className={secondaryButtonClass}>
          {pending ? "Turning on…" : "Turn account back on"}
        </button>
      )}
    </form>
  );
}
