"use client";

import { useSyncExternalStore } from "react";

import type { AuditArea } from "@/lib/audit-log-rules";

const subscribe = () => () => {};

// Download CSV, for the log as searched and filtered, with its times in the
// viewer's own time zone (which only the browser knows).
export function ExportLink({ query, area }: { query: string; area: AuditArea | null }) {
  const timeZone = useSyncExternalStore(
    subscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "",
  );
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (area) params.set("area", area);
  if (timeZone) params.set("tz", timeZone);
  const search = params.toString();
  return (
    <a
      href={`/admin/activity-log/export${search ? `?${search}` : ""}`}
      className="inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      data-activity-export
    >
      Download CSV
    </a>
  );
}
