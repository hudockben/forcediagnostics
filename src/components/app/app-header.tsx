import Link from "next/link";
import type { ReactNode } from "react";

import { NavTabs, type NavItem } from "@/components/app/nav-tabs";
import { SignOutButton } from "@/components/sign-out-button";
import { Wordmark } from "@/components/wordmark";
import { ADMIN_SECTIONS, ROLE_LABELS } from "@/lib/permissions";
import { allows, getCurrentUser } from "@/lib/session";


function HeaderFrame({ user, tabs }: { user?: ReactNode; tabs?: ReactNode }) {
  return (
    <header className="border-b border-white/10 bg-charcoal-900/60 backdrop-blur-md">
      {/* As wide as the page under it (see the app layout). */}
      <div className="mx-auto flex min-h-16 max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 pt-4 group-has-[[data-wide-page]]/shell:max-w-[118rem] sm:px-8">
        <Link
          href="/home"
          className="rounded focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          <Wordmark className="h-7 sm:h-9" />
        </Link>
        {user}
      </div>
      <div className="mx-auto min-h-12 max-w-5xl px-4 group-has-[[data-wide-page]]/shell:max-w-[118rem] sm:px-8">{tabs}</div>
    </header>
  );
}

export async function AppHeader() {
  const user = await getCurrentUser();
  const firstAdminSection = ADMIN_SECTIONS.find((section) => allows(user, section.capability));
  const tabs: NavItem[] = [
    { href: "/home", label: "Home", section: "/home" },
    ...(allows(user, "diagnostics.work") ? [{ href: "/diagnose", label: "Diagnose", section: "/diagnose" }] : []),
    ...(allows(user, "library.read") ? [{ href: "/library", label: "Library", section: "/library" }] : []),
    ...(firstAdminSection
      ? [{ href: firstAdminSection.href, label: "System Admin", section: "/admin" }]
      : []),
  ];

  return (
    <HeaderFrame
      user={
        <div className="flex items-center gap-3">
          <div className="text-right text-sm leading-5">
            <p className="font-medium text-ink">{user.name}</p>
            <p className="text-xs text-ink-muted">
              {user.bay ? user.bay.deviceName : `${ROLE_LABELS[user.role]} · ${user.shop.name}`}
            </p>
          </div>
          <SignOutButton compact switchUser={user.bay !== null} />
        </div>
      }
      tabs={<NavTabs label="Main" items={tabs} />}
    />
  );
}

// Same size as the real header, shown while the session loads.
export function AppHeaderFallback() {
  return <HeaderFrame />;
}
