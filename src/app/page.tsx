import { HudShell } from "@/components/hud";
import { LoginCard } from "@/components/login-card";
import { ReloadIfSignedInShown } from "@/components/reload-if-signed-in-shown";

export default function Home() {
  return (
    <HudShell>
      <ReloadIfSignedInShown />
      <LoginCard />
    </HudShell>
  );
}
