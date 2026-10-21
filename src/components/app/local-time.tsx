"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

// Shows a timestamp in the viewer's own time zone. The server doesn't know
// it, so the server render shows the date only and the browser fills in the
// local date and time.
export function LocalTime({ value }: { value: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () =>
      new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    () => value.slice(0, 10),
  );
  return <time dateTime={value}>{text}</time>;
}
