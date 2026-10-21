"use client";

import { useState, type ComponentProps } from "react";

import { Notice } from "@/components/app/ui";
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { PasswordInput } from "@/components/password-input";
import { ROLES, type Role } from "@/lib/roles";
import { useFormAction } from "@/lib/use-form-action";
import { ROLE_LABELS, ROLE_SUMMARIES } from "@/lib/permissions";

import { addStaff, resetPassword, saveDetails, setDisabled, type FormState } from "./actions";

const MIN_PASSWORD_LENGTH = 8;

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
      <input id={id} name={id} className={inputClass} {...props} />
      {hint && <p className="mt-1 text-xs leading-5 text-ink-muted">{hint}</p>}
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
      <select
        id="role"
        name="role"
        value={role}
        disabled={disabled}
        onChange={(event) => setRole(event.target.value as Role)}
        className={`${inputClass} appearance-none disabled:opacity-60`}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      {/* A disabled select isn't submitted, so send the current role along. */}
      {disabled && <input type="hidden" name="role" value={role} />}
      <p className="mt-1 text-xs leading-5 text-ink-muted">{hint ?? ROLE_SUMMARIES[role]}</p>
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

function NewPasswordField({ label }: { label: string }) {
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
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          setGenerated(null);
        }}
      />
      <p className="mt-1 text-xs leading-5 text-ink-muted">
        {generated ? (
          <>
            Give them <span className="font-mono text-ink">{generated}</span>. They can change it on
            their Home tab.
          </>
        ) : (
          `At least ${MIN_PASSWORD_LENGTH} characters.`
        )}
      </p>
    </div>
  );
}

function Feedback({ state }: { state: FormState }) {
  if (state.error) return <Notice tone="trail">{state.error}</Notice>;
  if (state.success) return <Notice>{state.success}</Notice>;
  return null;
}

export function AddStaffForm({ companyCode }: { companyCode: string }) {
  const [state, submit, pending] = useFormAction<FormState>(addStaff, {});
  return (
    <form onSubmit={submit} className="space-y-4">
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
  const [state, submit, pending] = useFormAction<FormState>(saveDetails, {});
  return (
    <form onSubmit={submit} className="space-y-4">
      <input type="hidden" name="id" value={member.id} />
      <Field id="name" label="Name" required defaultValue={member.name} maxLength={80} />
      <RoleSelect
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
  const [state, submit, pending] = useFormAction<FormState>(resetPassword, {});
  return (
    <form onSubmit={submit} className="space-y-4">
      <input type="hidden" name="id" value={member.id} />
      <NewPasswordField label="New password" />
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}

export function DisableForm({ member }: { member: Member }) {
  const [state, submit, pending] = useFormAction<FormState>(setDisabled, {});
  const [confirming, setConfirming] = useState(false);
  const disabling = !member.disabled;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        setConfirming(false);
        submit(event);
      }}
    >
      <input type="hidden" name="id" value={member.id} />
      <input type="hidden" name="disable" value={String(disabling)} />
      <Feedback state={state} />
      {disabling && confirming ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            Disable {member.name}? They&apos;ll be signed out everywhere and can&apos;t sign in until
            an admin turns the account back on.
          </p>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={pending}
              className="h-12 flex-1 rounded-lg border border-trail/50 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60"
            >
              {pending ? "Disabling…" : "Yes, disable"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type={disabling ? "button" : "submit"}
          onClick={disabling ? () => setConfirming(true) : undefined}
          disabled={pending}
          className={
            disabling
              ? "h-12 w-full rounded-lg border border-trail/40 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60"
              : secondaryButtonClass
          }
        >
          {disabling ? "Disable account" : pending ? "Turning on…" : "Turn account back on"}
        </button>
      )}
    </form>
  );
}
