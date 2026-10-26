"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";

import { inputBaseClass } from "@/components/hud";
import { MAX_LIST_QUERY_LENGTH, cleanListQuery, listHref } from "@/lib/diagnose-list-rules";

import { CrossIcon, SearchIcon } from "./icons";

// How long after the last key the list follows what's typed.
const TYPING_PAUSE_MS = 300;

// The search box over Diagnose's list, and the list under it (children,
// from the server). The search lives in the address (/diagnose?q=…), so
// Back and shared links keep it, and a new search starts on page 1. Without
// JavaScript it's a plain GET form (Enter searches, × is a link to the
// whole list); with it, the list follows as you type.
export function ListSearch({ query, children }: { query: string; children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(query);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);

  // Next keeps this page mounted while only the address changes, so the
  // box hears of each search the list comes back with. A search it sent
  // itself leaves the box as it is (more may have been typed since); any
  // other (Back, the Diagnose tab, Clear the search) is put in the box.
  const [shown, setShown] = useState(query);
  const [sent, setSent] = useState<string[]>([]);
  if (query !== shown) {
    setShown(query);
    const own = sent.includes(query) && (pending || query === sent.at(-1));
    if (!own) {
      setSent([]);
      if (cleanListQuery(text) !== query) setText(query);
    }
  }

  // Nothing left to send once the page is hidden or gone.
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Starting a search from the plain list, and ×, are a new step for Back;
  // refining a search isn't.
  function search(value: string, { step = false } = {}) {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const next = cleanListQuery(value);
    if (next === (sent.at(-1) ?? query)) return;
    const push = step || (sent.length === 0 && query === "");
    setSent((list) => [...list.slice(-20), next]);
    startTransition(() => {
      if (push) router.push(listHref(next), { scroll: false });
      else router.replace(listHref(next), { scroll: false });
    });
  }

  return (
    <div>
      <form
        action="/diagnose"
        role="search"
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          search(text);
        }}
      >
        <label htmlFor="diagnose-q" className="sr-only">
          Search diagnoses
        </label>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-muted" />
        <input
          ref={input}
          id="diagnose-q"
          name="q"
          type="search"
          value={text}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setText(value);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => search(value), TYPING_PAUSE_MS);
          }}
          // Leaving the box before the pause is up searches now, so a row
          // tapped straight after typing opens (its navigation comes later
          // and wins) instead of the search pulling the page back.
          onBlur={() => {
            if (timer.current !== undefined) search(text);
          }}
          maxLength={MAX_LIST_QUERY_LENGTH}
          placeholder="Complaint, unit, VIN or tech"
          autoComplete="off"
          enterKeyHint="search"
          data-list-search
          className={`${inputBaseClass} pr-12 pl-10 [&::-webkit-search-cancel-button]:appearance-none`}
        />
        {text && (
          <Link
            href="/diagnose"
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
