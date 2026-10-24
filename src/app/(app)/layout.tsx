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
      <div id="app-shell" className="group/shell app-backdrop flex flex-1 flex-col">
        <Suspense fallback={<AppHeaderFallback />}>
          <AppHeader />
        </Suspense>
        {/* A page that needs the room (Diagnose's conversation) marks
            itself data-wide-page while it's shown (not while Next keeps it
            hidden after a navigation) and gets the screen's width. */}
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8 has-[[data-wide-page]]:max-w-[118rem] has-[[data-wide-page]]:lg:py-6">{children}</main>
        {/* Full-screen views (Diagnose's examine view and manual pages)
            open here: inside the shell, so the bay tablet's lock covers
            them, and beside the page they hold inert. */}
        <div id="app-overlays" />
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
