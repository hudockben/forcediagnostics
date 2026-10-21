import { Suspense } from "react";

import { ChangePasswordForm } from "@/components/change-password-form";
import { HudCard, HudShell } from "@/components/hud";
import { SignOutButton } from "@/components/sign-out-button";
import type { Role } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";

const ROLE_LABELS: Record<Role, string> = {
  tech: "Tech",
  service_writer: "Service writer",
  parts: "Parts",
  manager: "Manager",
  admin: "Admin",
};

export default function ShopPage() {
  return (
    <HudShell>
      <Suspense fallback={<p className="font-mono text-sm text-glow/70">Loading…</p>}>
        <ShopHome />
      </Suspense>
    </HudShell>
  );
}

async function ShopHome() {
  const user = await getCurrentUser();
  return (
    <HudCard eyebrow={user.shop.name} title={`Welcome, ${user.name}`} titleId="shop-heading">
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-ink-muted">Company code</dt>
        <dd className="font-mono text-ink uppercase">{user.shop.code}</dd>
        <dt className="text-ink-muted">Username</dt>
        <dd className="font-mono text-ink">{user.username}</dd>
        <dt className="text-ink-muted">Role</dt>
        <dd className="text-ink">{ROLE_LABELS[user.role]}</dd>
      </dl>
      <p className="mt-6 text-sm leading-6 text-ink-muted">
        You&apos;re signed in. Repair orders and the diagnostic workspace come next.
      </p>
      <div className="mt-6 space-y-3">
        <ChangePasswordForm />
        <SignOutButton />
      </div>
    </HudCard>
  );
}
