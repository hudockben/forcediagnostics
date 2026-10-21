"use client";

import { useState, type ComponentProps, type FormEvent } from "react";

// Shown until shop accounts exist. Sign-in is wired up with the database.
const NOTICES = {
  signIn: "Sign-in isn't live yet. Shop accounts arrive with the database setup.",
  forgot: "Your manager or an admin can reset your password.",
  pin: "PIN switching for bay tablets arrives with shop accounts.",
};

const inputClass =
  "mt-1.5 block h-12 w-full rounded-lg border border-white/10 bg-forest-950/70 px-3.5 text-base text-ink outline-none transition placeholder:text-ink-muted/50 focus:border-glow/60 focus:ring-2 focus:ring-glow/25";

const labelClass = "text-sm font-medium text-ink/90";

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

const corners = [
  "-left-px -top-px rounded-tl-2xl border-l border-t",
  "-right-px -top-px rounded-tr-2xl border-r border-t",
  "-bottom-px -left-px rounded-bl-2xl border-b border-l",
  "-bottom-px -right-px rounded-br-2xl border-b border-r",
];

function KeypadIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 24" className="h-5 w-4 fill-current">
      {[3, 9, 15].flatMap((y) =>
        [3, 10, 17].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={2} />),
      )}
      <circle cx={10} cy={21} r={2} />
    </svg>
  );
}

export function LoginCard() {
  const [notice, setNotice] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(NOTICES.signIn);
  }

  return (
    <section
      aria-labelledby="sign-in-heading"
      className="relative w-full max-w-sm rounded-2xl border border-glow/15 bg-charcoal-900/75 p-6 shadow-2xl shadow-black/60 backdrop-blur-md sm:p-8"
    >
      {corners.map((corner) => (
        <span
          key={corner}
          aria-hidden
          className={`pointer-events-none absolute size-6 border-glow/70 ${corner}`}
        />
      ))}

      <p className="font-mono text-[11px] tracking-[0.2em] text-glow/80 uppercase">
        Shop access
      </p>
      <h1
        id="sign-in-heading"
        className="mt-2 text-2xl font-semibold tracking-tight text-ink"
      >
        Sign in
      </h1>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className={inputClass}
          />
        </div>

        <button
          type="submit"
          className="h-12 w-full rounded-lg bg-trail text-base font-semibold text-charcoal-900 shadow-lg shadow-trail/15 transition hover:bg-trail-bright focus-visible:ring-2 focus-visible:ring-trail/60 focus-visible:ring-offset-2 focus-visible:ring-offset-charcoal-900 focus-visible:outline-none"
        >
          Sign in
        </button>
      </form>

      <div className="my-5 flex items-center gap-3 font-mono text-[11px] tracking-[0.2em] text-ink-muted/70 uppercase">
        <span className="h-px flex-1 bg-white/10" />
        or
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <button
        type="button"
        onClick={() => setNotice(NOTICES.pin)}
        className="flex h-12 w-full items-center justify-center gap-2.5 rounded-lg border border-glow/30 text-base font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        <KeypadIcon />
        Switch user with PIN
      </button>

      <p role="status" className="mt-4 text-sm leading-5 text-ink-muted empty:hidden">
        {notice}
      </p>
    </section>
  );
}
