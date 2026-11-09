import { formatMoney, type Cents } from "@/lib/nusr-rules";

// What an invoice's rebates come to by salesman, or by category, one line
// each: the name, how many units, and the amount, the most first. In the
// list of invoices on the page (New invoices) and in Saved rebates'
// invoices.

export type GroupTotal = { label: string; lines: number; amount: Cents };

export function GroupTotals({ groups, by }: { groups: readonly GroupTotal[]; by: "salesman" | "category" }) {
  if (groups.length === 0) return <span className="text-xs text-ink-muted">—</span>;
  return (
    <ul className={`space-y-0.5 text-xs ${by === "salesman" ? "min-w-48" : "min-w-36"}`} data-rebates-by={by}>
      {groups.map((group) => (
        <li key={group.label.toLowerCase()} className="flex justify-between gap-3">
          <span className={group.label === "Not found" ? "text-trail" : "text-ink"}>
            {group.label} <span className="text-ink-muted">({group.lines.toLocaleString("en-US")})</span>
          </span>
          <span className="text-ink tabular-nums">{formatMoney(group.amount)}</span>
        </li>
      ))}
    </ul>
  );
}
