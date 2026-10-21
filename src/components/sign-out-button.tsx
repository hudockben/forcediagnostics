"use client";

import { useState } from "react";

import { secondaryButtonClass } from "@/components/hud";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
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
    <div>
      <button type="button" onClick={signOut} disabled={pending} className={secondaryButtonClass}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {failed && (
        <p role="status" className="mt-3 text-sm text-trail">
          Couldn&apos;t sign out. Check the connection and try again.
        </p>
      )}
    </div>
  );
}
