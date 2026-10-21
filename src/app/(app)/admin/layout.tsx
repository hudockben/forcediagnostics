import type { ReactNode } from "react";

import { NavTabs } from "@/components/app/nav-tabs";

// The pages check the accounts.manage permission themselves; this layout only
// draws the System Admin sub-menu.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <NavTabs
        label="System Admin"
        variant="pills"
        items={[
          { href: "/admin/accounts", label: "Accounts", section: "/admin/accounts" },
          { href: "/admin/permissions", label: "Permissions", section: "/admin/permissions" },
        ]}
      />
      {children}
    </div>
  );
}
