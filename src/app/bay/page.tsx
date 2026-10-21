import { getSessionCookie } from "better-auth/cookies";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { Suspense } from "react";

import { HudShell } from "@/components/hud";
import { ReloadIfSignedInShown } from "@/components/reload-if-signed-in-shown";
import { BAY_COOKIE, findDeviceByToken } from "@/lib/bay";
import { listPinPeople } from "@/lib/pins";

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
  const [people, sessionCookie] = await Promise.all([
    listPinPeople(device.shopId),
    headers().then((h) => getSessionCookie(h)),
  ]);
  return <BayPicker deviceName={device.name} people={people} endLeftoverSession={Boolean(sessionCookie)} />;
}
