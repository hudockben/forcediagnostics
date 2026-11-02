import Link from "next/link";

import { LocalTime } from "@/components/app/local-time";
import { Badge } from "@/components/app/ui";
import { RELATION_DATE_LABELS, RELATION_LABELS, formatDay, type VehicleRelation } from "@/lib/customer-rules";
import type { VehicleDiagnosis } from "@/lib/customers";

// A vehicle's diagnoses, newest first: what the complaint was, the fix
// when one was confirmed ("This was it" on Diagnose), who started it and
// when. Those who can use Diagnose can open each one.
export function DiagnosisHistory({ diagnoses, canOpen }: { diagnoses: VehicleDiagnosis[]; canOpen: boolean }) {
  if (diagnoses.length === 0) return <p className="text-sm text-ink-muted">No diagnoses yet.</p>;
  return (
    <ul className="divide-y divide-white/10 rounded-lg border border-white/10" data-diagnosis-history>
      {diagnoses.map((diagnosis) => {
        const content = (
          <>
            <span className="min-w-0">
              <span className="block text-sm font-medium break-words text-ink">{diagnosis.title}</span>
              {diagnosis.fix && (
                <span className="block text-sm break-words text-glow" data-fix>
                  Fix: {diagnosis.fix}
                </span>
              )}
              <span className="block text-xs text-ink-muted">
                {diagnosis.startedBy} · <LocalTime value={diagnosis.createdAt.toISOString()} />
              </span>
            </span>
            {diagnosis.status === "solved" ? <Badge tone="glow">Solved</Badge> : <Badge>Open</Badge>}
          </>
        );
        const rowClass = "flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5";
        return (
          <li key={diagnosis.id}>
            {canOpen ? (
              <Link
                href={`/diagnose/${diagnosis.id}`}
                className={`${rowClass} transition hover:bg-white/[0.03] focus-visible:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-glow/60 focus-visible:outline-none focus-visible:ring-inset`}
              >
                {content}
              </Link>
            ) : (
              <div className={rowClass}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// "Bought from us" with its date beside it, as a badge.
export function RelationBadge({ relation, date }: { relation: VehicleRelation; date: string | null }) {
  return (
    <Badge tone={relation === "bought" ? "glow" : "neutral"}>
      {RELATION_LABELS[relation]}
      {date && RELATION_DATE_LABELS[relation] ? ` ${formatDay(date)}` : ""}
    </Badge>
  );
}
