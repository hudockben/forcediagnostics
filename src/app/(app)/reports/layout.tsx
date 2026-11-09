import { Suspense, type ReactNode } from "react";

import { NavTabs } from "@/components/app/nav-tabs";
import { REPORT_SECTIONS } from "@/lib/permissions";
import { allows, getCurrentUser } from "@/lib/session";

// The pages check their permissions themselves; this layout only draws the
// Reports sub-menu (Salesman bonuses, Diagnosis times), with the reports
// this user may see.
export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<div className="h-10" />}>
        <ReportsNav />
      </Suspense>
      {children}
    </div>
  );
}

async function ReportsNav() {
  const user = await getCurrentUser();
  return (
    <NavTabs
      label="Reports"
      variant="pills"
      items={REPORT_SECTIONS.filter((section) => allows(user, section.capability)).map((section) => ({
        href: section.href,
        label: section.label,
        section: section.href,
        exact: section.exact,
      }))}
    />
  );
}
