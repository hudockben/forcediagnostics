import { Suspense, type ReactNode } from "react";

import { NavTabs } from "@/components/app/nav-tabs";
import { ADMIN_SECTIONS } from "@/lib/permissions";
import { allows, getCurrentUser } from "@/lib/session";

// The pages check their permissions themselves; this layout only draws the
// System Admin sub-menu, with the sections this user may open.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<div className="h-10" />}>
        <AdminNav />
      </Suspense>
      {children}
    </div>
  );
}

async function AdminNav() {
  const user = await getCurrentUser();
  return (
    <NavTabs
      label="System Admin"
      variant="pills"
      items={ADMIN_SECTIONS.filter((s) => allows(user, s.capability)).map((s) => ({
        href: s.href,
        label: s.label,
        section: s.href,
      }))}
    />
  );
}
