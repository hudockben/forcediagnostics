"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { secondaryButtonClass } from "@/components/hud";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    await authClient.signOut();
    router.replace("/");
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className={secondaryButtonClass}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
