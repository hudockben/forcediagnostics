"use client";

import { useEffect } from "react";

// Takes one-time notices' parameters (?added=, ?removed=) out of the
// address once the page has shown them, so the notice doesn't come back on
// a reload or stay while the page is used.
export function ClearParams({ names }: { names: string[] }) {
  const key = names.join(",");
  useEffect(() => {
    const url = new URL(window.location.href);
    const before = url.search;
    for (const name of key.split(",")) url.searchParams.delete(name);
    if (url.search !== before) window.history.replaceState(window.history.state, "", url);
  }, [key]);
  return null;
}
