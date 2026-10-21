"use client";

import { useState } from "react";

import { secondaryButtonClass } from "@/components/hud";
import { authClient } from "@/lib/auth-client";

export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    try {
      const { error } = await authClient.signOut();
      if (!error) {
        // A full page load, not a client navigation, so nothing from the
        // signed-in session (cached pages, filled-in forms) survives.
        window.location.replace("/");
        return;
      }
    } catch {
      // Network failure: fall through and let them retry.
    }
    setPending(false);
    setFailed(true);
  }

  return (
    <div className={compact ? "relative" : undefined}>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className={
          compact
            ? "h-10 rounded-lg border border-white/15 px-3 text-sm text-ink-muted transition hover:border-white/30 hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60"
            : secondaryButtonClass
        }
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {failed && (
        <p
          role="status"
          className={
            compact
              ? "absolute top-full right-0 z-10 mt-2 w-56 rounded-lg border border-trail/30 bg-charcoal-900 p-2 text-xs text-trail"
              : "mt-3 text-sm text-trail"
          }
        >
          Couldn&apos;t sign out. Check the connection and try again.
        </p>
      )}
    </div>
  );
}
