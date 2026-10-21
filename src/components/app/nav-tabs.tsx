"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

export type NavItem = { href: string; label: string; section: string };

const styles = {
  tabs: {
    list: "-mb-px flex gap-1 overflow-x-auto",
    link: "flex h-12 items-center border-b-2 px-4 text-sm font-medium whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none",
    active: "border-glow text-ink",
    idle: "border-transparent text-ink-muted hover:text-ink",
  },
  pills: {
    list: "flex flex-wrap gap-2",
    link: "flex h-10 items-center rounded-full px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none",
    active: "bg-glow/15 text-glow",
    idle: "text-ink-muted hover:bg-white/5 hover:text-ink",
  },
};

type Props = { items: NavItem[]; label: string; variant?: keyof typeof styles };

function TabList({ items, label, variant = "tabs", pathname }: Props & { pathname: string | null }) {
  const style = styles[variant];
  return (
    <nav aria-label={label}>
      <ul className={style.list}>
        {items.map((item) => {
          const active =
            pathname !== null &&
            (pathname === item.section || pathname.startsWith(`${item.section}/`));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`${style.link} ${active ? style.active : style.idle}`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ActiveTabList(props: Props) {
  return <TabList {...props} pathname={usePathname()} />;
}

// Tab bar that highlights the section the current page belongs to. Pages
// with an ID in the address only know it at request time, so the tabs first
// render without a highlight (Next.js needs the Suspense boundary for that).
export function NavTabs(props: Props) {
  return (
    <Suspense fallback={<TabList {...props} pathname={null} />}>
      <ActiveTabList {...props} />
    </Suspense>
  );
}
