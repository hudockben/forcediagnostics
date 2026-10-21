import { Suspense, type ReactNode } from "react";

import { AppHeader, AppHeaderFallback } from "@/components/app/app-header";
import { BayLock } from "@/components/app/bay-lock";
import { SignedInMarker } from "@/components/app/signed-in-marker";
import { BAY_HEARTBEAT_MS, BAY_IDLE_MS, lookupCurrentUser } from "@/lib/session";

// Shell for every signed-in screen: header with the tabs, then the page.
// Each page also checks the session itself; layouts don't re-run on every
// navigation, so they can't be the only gate.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div id="app-shell" className="app-backdrop flex flex-1 flex-col">
        <Suspense fallback={<AppHeaderFallback />}>
          <AppHeader />
        </Suspense>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8">{children}</main>
      </div>
      <Suspense fallback={null}>
        <BayLockForPinSessions />
      </Suspense>
      <SignedInMarker />
    </>
  );
}

async function BayLockForPinSessions() {
  const result = await lookupCurrentUser();
  if ("redirectTo" in result || !result.user.bay) return null;
  return (
    <BayLock
      userId={result.user.id}
      sessionId={result.user.bay.sessionId}
      name={result.user.name}
      idleMs={BAY_IDLE_MS}
      heartbeatMs={BAY_HEARTBEAT_MS}
    />
  );
}
