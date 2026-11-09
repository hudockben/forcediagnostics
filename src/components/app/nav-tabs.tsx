"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useLayoutEffect, useRef } from "react";

// `exact`: only the section's own address marks it current, not the pages
// under it (a section at the top of others, such as /reports).
export type NavItem = { href: string; label: string; section: string; exact?: boolean };

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
  const list = useRef<HTMLUListElement>(null);
  const shown = useRef(false);

  // On a phone the tabs are wider than the screen and the bar scrolls
  // sideways. When the current tab is cut off, the bar (never the page)
  // scrolls to put it in the middle, with the tabs either side of it
  // showing: at once as a page opens, smoothly after a tap.
  useLayoutEffect(() => {
    const bar = list.current;
    const current = bar?.querySelector<HTMLElement>("[aria-current]");
    const first = !shown.current;
    shown.current = true;
    if (!bar || !current) return;
    const barBox = bar.getBoundingClientRect();
    const tabBox = current.getBoundingClientRect();
    // A pixel's slack for rounding.
    if (tabBox.left >= barBox.left - 1 && tabBox.right <= barBox.right + 1) return;
    const smooth = !first && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bar.scrollTo({
      left: bar.scrollLeft + tabBox.left - barBox.left - (barBox.width - tabBox.width) / 2,
      behavior: smooth ? "smooth" : "auto",
    });
  }, [pathname]);

  return (
    <nav aria-label={label}>
      <ul ref={list} className={style.list}>
        {items.map((item) => {
          const active =
            pathname !== null &&
            (pathname === item.section || (!item.exact && pathname.startsWith(`${item.section}/`)));
          // "page" only for the exact page; otherwise it marks the current section.
          const current = active ? (pathname === item.href ? "page" : "true") : undefined;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current}
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
