"use client";

import { useEffect, useState, type ComponentProps } from "react";

import { inputBaseClass } from "@/components/hud";

// Long enough to check what was typed, short enough that a password isn't
// left showing on a shared bay tablet.
const REVEAL_MS = 5000;

function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-5 fill-none stroke-current"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx={12} cy={12} r={3} />
      {crossed && <path d="M4 20 20 4" />}
    </svg>
  );
}

// A password field with an eye button that shows the password for a moment.
export function PasswordInput({ className = "", ...props }: ComponentProps<"input">) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  return (
    <div className={`relative mt-1.5 ${className}`}>
      <input
        {...props}
        type={visible ? "text" : "password"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={`${inputBaseClass} pr-12`}
      />
      <button
        type="button"
        // Keep focus (and the on-screen keyboard) in the field.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setVisible((shown) => !shown)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={props.id}
        className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-ink-muted transition hover:text-glow focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        <EyeIcon crossed={visible} />
      </button>
    </div>
  );
}
