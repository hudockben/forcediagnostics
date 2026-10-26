"use client";

import { useSyncExternalStore } from "react";

import { greetingFor } from "@/lib/greeting";

// Looked at again every minute, so a tablet left on Home moves on to the
// afternoon.
function subscribe(onChange: () => void) {
  const timer = window.setInterval(onChange, 60_000);
  return () => window.clearInterval(timer);
}

// "Good morning, Mike" by the viewer's own clock. The server doesn't know
// it, so the server render says "Welcome back, Mike" and the browser puts in
// the time of day.
export function Greeting({ name }: { name: string }) {
  const greeting = useSyncExternalStore(
    subscribe,
    () => greetingFor(new Date().getHours()),
    () => "Welcome back",
  );
  return (
    <>
      {greeting}, {name}
    </>
  );
}
