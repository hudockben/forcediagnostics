import Link from "next/link";

import { listHref, pageItems } from "@/lib/diagnose-list-rules";

import { BackIcon } from "./icons";

const pageControl =
  "flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";
const pageLink = `${pageControl} text-ink-muted hover:bg-white/5 hover:text-ink`;

// Previous, the page numbers and Next, 44px to tap. On a phone only the
// first, last and current page numbers show; wider, one either side too.
// The Diagnose list's, and System Admin > Customers' at its own path.
export function Pagination({
  query,
  page,
  pages,
  label,
  path = "/diagnose",
}: {
  query: string;
  page: number;
  pages: number;
  label: string;
  path?: string;
}) {
  if (pages <= 1) return null;
  const numbers = (around: number, only: string) =>
    pageItems(page, pages, around).map((item, index) => (
      <li key={`${only}-${index}`} className={only}>
        {item === null ? (
          <span aria-hidden className="flex h-11 w-5 items-center justify-center text-sm text-ink-muted">
            …
          </span>
        ) : item === page ? (
          <span aria-current="page" data-page={item} className={`${pageControl} bg-glow/15 font-mono text-glow`}>
            <span className="sr-only">Page </span>
            {item}
          </span>
        ) : (
          <Link href={listHref(query, item, path)} data-page={item} className={`${pageLink} font-mono`}>
            <span className="sr-only">Page </span>
            {item}
          </Link>
        )}
      </li>
    ));
  // On a phone the arrow alone (the label stays for screen readers).
  const step = (to: number, label: string, rel: "prev" | "next") => {
    const content = (
      <>
        <BackIcon className={`size-4 ${rel === "next" ? "order-last rotate-180" : ""}`} />
        <span className="max-sm:sr-only">{label}</span>
      </>
    );
    // There's nothing before the first page or after the last: shown dimmed
    // so the row doesn't shift, and left out for screen readers.
    return to < 1 || to > pages ? (
      <span aria-hidden className={`${pageControl} text-ink-muted/40`}>
        {content}
      </span>
    ) : (
      <Link href={listHref(query, to, path)} rel={rel} data-page-step={rel} className={pageLink}>
        {content}
      </Link>
    );
  };
  return (
    <nav aria-label={label} data-pagination>
      <ul className="flex items-center gap-1.5">
        <li>{step(page - 1, "Previous", "prev")}</li>
        {numbers(0, "sm:hidden")}
        {numbers(1, "max-sm:hidden")}
        <li>{step(page + 1, "Next", "next")}</li>
      </ul>
    </nav>
  );
}
