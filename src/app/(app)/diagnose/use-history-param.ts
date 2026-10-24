"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

// A full-screen view that the browser's Back (or Android's back gesture)
// closes: it's open while the address has `?name=value`. Opening adds a
// history entry with the native history API, which Next's router follows
// (useSearchParams updates, nothing is fetched); closing goes back over
// that entry, or, when the view was opened from the address itself (a
// refresh), takes the value off the address. Kept in the address rather
// than in state, so a page Next brings back from its cache doesn't come
// back with a view open (see the Next docs on preserving UI state).

// Views opened here, whose entry Back can safely remove.
const pushed = new Set<string>();

function addressWith(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useHistoryParam(name: string) {
  const params = useSearchParams();
  const value = params.get(name);

  useEffect(() => {
    if (value === null) pushed.delete(name);
  }, [name, value]);

  function open(next: string) {
    if (value === null) {
      window.history.pushState(null, "", addressWith(name, next));
      pushed.add(name);
    } else if (next !== value) {
      window.history.replaceState(null, "", addressWith(name, next));
    }
  }

  function close() {
    if (value === null) return;
    if (pushed.has(name)) {
      pushed.delete(name);
      window.history.back();
    } else {
      window.history.replaceState(null, "", addressWith(name, null));
    }
  }

  return [value, open, close] as const;
}
