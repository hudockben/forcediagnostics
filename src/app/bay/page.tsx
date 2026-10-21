import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Suspense } from "react";

import { HudShell } from "@/components/hud";
import { ReloadIfSignedInShown } from "@/components/reload-if-signed-in-shown";
import { BAY_COOKIE, findDeviceByToken } from "@/lib/bay";
import { listPinPeople } from "@/lib/pins";
import { lookupCurrentUser } from "@/lib/session";

import { BayPicker } from "./bay-picker";
import { PairTabletCard } from "./pair-tablet";

export const metadata: Metadata = { title: "Bay tablet", robots: { index: false } };

// The PIN screen on a shared bay tablet. Bookmark this page on the tablet.
export default function BayPage() {
  return (
    <HudShell>
      <ReloadIfSignedInShown />
      <Suspense fallback={<p className="font-mono text-sm text-glow/70">Loading…</p>}>
        <Bay />
      </Suspense>
    </HudShell>
  );
}

async function Bay() {
  const device = await findDeviceByToken((await cookies()).get(BAY_COOKIE)?.value);
  if (!device) return <PairTabletCard />;
  const [people, current] = await Promise.all([listPinPeople(device.shopId), lookupCurrentUser()]);
  // Coming back here means switching user, so whoever is still signed in on
  // this tablet is signed out. (Other kinds of session on a tablet were
  // already ended by the lookup.)
  const leftover = "user" in current && current.user.bay?.deviceId === device.id ? current.user.bay.sessionId : null;
  return <BayPicker deviceName={device.name} people={people} leftoverSessionId={leftover} />;
}
