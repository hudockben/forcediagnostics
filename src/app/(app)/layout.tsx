import { Suspense, type ReactNode } from "react";

import { AppHeader, AppHeaderFallback } from "@/components/app/app-header";

// Shell for every signed-in screen: header with the tabs, then the page.
// Each page also checks the session itself; layouts don't re-run on every
// navigation, so they can't be the only gate.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-backdrop flex flex-1 flex-col">
      <Suspense fallback={<AppHeaderFallback />}>
        <AppHeader />
      </Suspense>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8">{children}</main>
    </div>
  );
}
