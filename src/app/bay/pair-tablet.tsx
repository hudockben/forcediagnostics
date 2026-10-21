"use client";

import Link from "next/link";
import { useEffect } from "react";

import { HudCard, inputClass, labelClass, primaryButtonClass } from "@/components/hud";
import { authClient } from "@/lib/auth-client";
import { useFormAction } from "@/lib/use-form-action";

import { pairTablet, type PairState } from "./actions";

export function PairTabletCard() {
  const { state, pending, formProps } = useFormAction<PairState>(pairTablet, {});

  useEffect(() => {
    if (!state.paired) return;
    // Clear any leftover sign-in cookie, then start fresh on the PIN screen.
    void authClient.signOut().finally(() => window.location.replace("/bay"));
  }, [state.paired]);

  return (
    <HudCard eyebrow="Bay tablet" title="Pair this tablet" titleId="pair-heading">
      <p className="mt-2 text-sm leading-6 text-ink-muted">
        A manager or admin gets a pairing code from System Admin → Bay tablets on their own computer
        or phone. Type it here. After that, staff switch on this tablet with their PIN.
      </p>
      <form {...formProps} className="mt-6 space-y-4">
        <div>
          <label htmlFor="code" className={labelClass}>
            Pairing code
          </label>
          <input
            id="code"
            name="code"
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ABCD-1234"
            maxLength={12}
            className={`${inputClass} font-mono text-lg tracking-widest uppercase`}
          />
        </div>
        <div role="status" aria-live="polite" className="text-sm text-trail empty:hidden">
          {state.paired ? `Paired as ${state.paired}. Opening the PIN screen…` : state.error}
        </div>
        <button type="submit" disabled={pending || Boolean(state.paired)} className={primaryButtonClass}>
          {pending ? "Pairing…" : "Pair tablet"}
        </button>
      </form>
      <p className="mt-5 text-sm text-ink-muted">
        Not a shared tablet?{" "}
        <Link href="/" className="text-glow hover:underline">
          Sign in with your password
        </Link>
      </p>
    </HudCard>
  );
}
