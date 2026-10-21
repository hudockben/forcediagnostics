"use client";

import Link from "next/link";
import { useActionState, type ComponentProps } from "react";

import { HudCard, inputClass, labelClass, primaryButtonClass } from "@/components/hud";
import { PasswordInput } from "@/components/password-input";

import { setUpShop, type SetupState } from "./actions";

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
      {props.type === "password" ? (
        <PasswordInput id={id} name={id} required {...props} />
      ) : (
        <input id={id} name={id} required className={inputClass} {...props} />
      )}
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

export function SetupForm() {
  const [state, action, pending] = useActionState<SetupState, FormData>(setUpShop, {});

  if (state.done) {
    return (
      <HudCard eyebrow="First-run setup" title="Your shop is ready" titleId="setup-heading">
        <p className="mt-4 text-sm leading-6 text-ink-muted">
          Sign in with company code{" "}
          <span className="font-mono text-ink uppercase">{state.done.companyCode}</span> and
          username <span className="font-mono text-ink">{state.done.username}</span>.
        </p>
        <Link href="/" className={`${primaryButtonClass} mt-6 flex items-center justify-center`}>
          Go to sign in
        </Link>
      </HudCard>
    );
  }

  return (
    <HudCard
      eyebrow="First-run setup"
      title="Create your shop"
      titleId="setup-heading"
      className="max-w-md"
    >
      <p className="mt-2 text-sm leading-6 text-ink-muted">
        This creates the shop and your admin account. It only works once.
      </p>
      <form action={action} className="mt-6 space-y-4">
        <Field
          id="setupCode"
          label="Setup code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <Field id="shopName" label="Shop name" autoComplete="organization" />
        <Field
          id="companyCode"
          label="Company code"
          hint="2–16 letters or numbers. Everyone at the shop types this to sign in."
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={16}
        />
        <Field id="name" label="Your name" autoComplete="name" />
        <Field
          id="username"
          label="Your username"
          hint="Letters, numbers, dots or underscores."
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={30}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={8}
        />
        <Field
          id="confirmPassword"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          minLength={8}
        />
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Creating…" : "Create shop"}
        </button>
      </form>
      <p role="status" className="mt-4 text-sm leading-5 text-trail empty:hidden">
        {state.error}
      </p>
    </HudCard>
  );
}
