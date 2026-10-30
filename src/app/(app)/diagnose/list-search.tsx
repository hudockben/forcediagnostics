"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";

import { inputBaseClass } from "@/components/hud";
import { MAX_LIST_QUERY_LENGTH, cleanListQuery, listHref } from "@/lib/diagnose-list-rules";

import { CrossIcon, SearchIcon } from "./icons";

// How long after the last key the list follows what's typed.
const TYPING_PAUSE_MS = 300;

// The search box over Diagnose's list, and the list under it (children,
// from the server). The search lives in the address (/diagnose?q=…), so
// Back and shared links keep it, and a new search starts on page 1. Without
// JavaScript it's a plain GET form (Enter searches, × is a link to the
// whole list); with it, the list follows as you type. System Admin >
// Customers uses it too, at its own path.
export function ListSearch({
  query,
  children,
  path = "/diagnose",
  label = "Search diagnoses",
  placeholder = "Complaint, unit, VIN, customer or tech",
}: {
  query: string;
  children: ReactNode;
  path?: string;
  label?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(query);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);

  // Next keeps this page mounted while only the address changes, so the
  // box hears of each search the list comes back with. A search it sent
  // itself leaves the box as it is (more may have been typed since); any
  // other (Back, the Diagnose tab, Clear the search) is put in the box. So
  // is the address's own search once the box's last one has been overtaken
  // (a row or a tab tapped before it came back): Next drops that one, and
  // the box would otherwise say one thing over a list of another.
  const [shown, setShown] = useState(query);
  const [sent, setSent] = useState<string[]>([]);
  const [pushed, setPushed] = useState(false);
  const overtaken = !pending && sent.length > 0 && sent.at(-1) !== query;
  if (query !== shown || overtaken) {
    if (query !== shown) setShown(query);
    const own = !overtaken && sent.includes(query) && (pending || query === sent.at(-1));
    if (!own) {
      setSent([]);
      if (cleanListQuery(text) !== query) setText(query);
    }
  }

  // Nothing left to send once the page is hidden or gone.
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function search(value: string, { step = false } = {}) {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const next = cleanListQuery(value);
    // Nothing to do if it's the box's own search on its way, or else the
    // one in the address.
    if (next === (pending ? (sent.at(-1) ?? query) : query)) return;
    // Starting a search from the plain list, and ×, are a new step for
    // Back; refining a search isn't. One sent while the box's last step is
    // still on its way is that step (Next only writes the one that lands,
    // so two pushes before the first comes back still make one step).
    const push = step || query === "" || (pending && pushed);
    setSent((list) => [...list.slice(-20), next]);
    setPushed(push);
    startTransition(() => {
      if (push) router.push(listHref(next, 1, path), { scroll: false });
      else router.replace(listHref(next, 1, path), { scroll: false });
    });
  }

  // The typing pause ends with the latest render's search of the latest
  // text, so it goes by what the address and the box say then, not when
  // the key was pressed: after Back put another search in the box, it has
  // nothing to send.
  const typed = useRef(() => {});
  useLayoutEffect(() => {
    typed.current = () => search(text);
  });

  return (
    <div>
      <form
        action={path}
        role="search"
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          search(text);
        }}
      >
        <label htmlFor="list-q" className="sr-only">
          {label}
        </label>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-muted" />
        <input
          ref={input}
          id="list-q"
          name="q"
          type="search"
          value={text}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setText(value);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => typed.current(), TYPING_PAUSE_MS);
          }}
          // Leaving the box before the pause is up searches now, so a row
          // tapped straight after typing opens (its navigation comes later
          // and wins) instead of the search pulling the page back.
          onBlur={() => {
            if (timer.current !== undefined) search(text);
          }}
          maxLength={MAX_LIST_QUERY_LENGTH}
          placeholder={placeholder}
          autoComplete="off"
          enterKeyHint="search"
          data-list-search
          className={`${inputBaseClass} pr-12 pl-10 [&::-webkit-search-cancel-button]:appearance-none`}
        />
        {text && (
          <Link
            href={path}
            aria-label="Clear the search"
            data-search-clear
            onClick={(event) => {
              event.preventDefault();
              setText("");
              search("", { step: true });
              input.current?.focus();
            }}
            className="absolute top-0 right-0 flex size-12 items-center justify-center rounded-lg text-ink-muted transition hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            <CrossIcon className="size-4" />
          </Link>
        )}
      </form>
      <div aria-busy={pending} data-list-pending={pending || undefined} className={`transition-opacity ${pending ? "opacity-60" : ""}`}>
        {children}
      </div>
    </div>
  );
}
