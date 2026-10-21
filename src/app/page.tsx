import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HudShell } from "@/components/hud";
import { LoginCard } from "@/components/login-card";
import { ReloadIfSignedInShown } from "@/components/reload-if-signed-in-shown";
import { BAY_COOKIE, findDeviceByToken } from "@/lib/bay";

export default function Home() {
  return (
    <HudShell>
      <ReloadIfSignedInShown />
      <Suspense fallback={null}>
        <SendBayTabletsToPinScreen />
      </Suspense>
      <LoginCard />
    </HudShell>
  );
}

// Bay tablets only take PINs, so they never show the password form.
async function SendBayTabletsToPinScreen() {
  const device = await findDeviceByToken((await cookies()).get(BAY_COOKIE)?.value);
  if (device) redirect("/bay");
  return null;
}
