"use client";

import Link from "next/link";
import { useState, type ComponentProps, type FormEvent } from "react";

import {
  HudCard,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/hud";
import { PasswordInput } from "@/components/password-input";
import { authClient } from "@/lib/auth-client";
import {
  COMPANY_CODE_PATTERN,
  USERNAME_PATTERN,
  normalizeCompanyCode,
  normalizeUsername,
  storedUsername,
} from "@/lib/usernames";

const NOTICES = {
  invalid: "Company code, username or password is incorrect.",
  tooMany: "Too many sign-in attempts. Wait 15 minutes, then try again.",
  failed: "Couldn't sign in right now. Try again in a moment.",
  disabled: "This account is disabled. Ask an admin to turn it back on.",
  forgot: "Your manager or an admin can reset your password.",
  bayTablet:
    "This is a bay tablet: use Switch user with PIN. Passwords aren't used on shared tablets.",
};

function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & ComponentProps<"input">) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input id={id} name={id} required className={inputClass} {...props} />
    </div>
  );
}

function KeypadIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 24" className="h-5 w-4 fill-current">
      {[3, 9, 15].flatMap((y) =>
        [3, 10, 17].map((x) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r={2} />
        )),
      )}
      <circle cx={10} cy={21} r={2} />
    </svg>
  );
}

export function LoginCard() {
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const company = normalizeCompanyCode(String(form.get("company")));
    const username = normalizeUsername(String(form.get("username")));
    const password = String(form.get("password"));

    // Malformed codes or usernames can't match an account.
    if (
      !COMPANY_CODE_PATTERN.test(company) ||
      !USERNAME_PATTERN.test(username)
    ) {
      setNotice(NOTICES.invalid);
      return;
    }

    setPending(true);
    setNotice(null);
    const { error } = await authClient.signIn.username({
      username: storedUsername(company, username),
      password,
    });
    if (!error) {
      // A full page load, so nothing from before this sign-in (cached pages,
      // this form's contents) stays in memory.
      formElement.reset();
      window.location.replace("/home");
      return;
    }
    setPending(false);
    setNotice(
      error.code === "ACCOUNT_DISABLED"
        ? NOTICES.disabled
        : error.code === "BAY_TABLET"
          ? NOTICES.bayTablet
          : error.status === 429
            ? NOTICES.tooMany
            : error.status === 401 || error.status === 422
              ? NOTICES.invalid
              : NOTICES.failed,
    );
  }

  return (
    <HudCard eyebrow="Shop access" title="Sign in" titleId="sign-in-heading">
      <form method="post" onSubmit={handleSubmit} className="mt-6 space-y-4">
        <Field
          id="company"
          label="Company code"
          autoComplete="organization"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <Field
          id="username"
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />
        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="password" className={labelClass}>
              Password
            </label>
            <button
              type="button"
              onClick={() => setNotice(NOTICES.forgot)}
              className="rounded text-sm text-glow/90 hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Forgot password?
            </button>
          </div>
          <PasswordInput
            id="password"
            name="password"
            required
            autoComplete="current-password"
          />
        </div>

        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div className="my-5 flex items-center gap-3 font-mono text-[11px] tracking-[0.2em] text-ink-muted/70 uppercase">
        <span className="h-px flex-1 bg-white/10" />
        or
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <Link href="/bay" className={secondaryButtonClass}>
        <KeypadIcon />
        Switch user with PIN
      </Link>

      <p
        role="status"
        className="mt-4 text-sm leading-5 text-trail empty:hidden"
      >
        {notice}
      </p>
    </HudCard>
  );
}
