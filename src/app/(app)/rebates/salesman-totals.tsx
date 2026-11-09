import { formatMoney, type Cents } from "@/lib/nusr-rules";

// What an invoice's rebates come to by salesman, one line each: the name,
// how many units, and the amount, the most first. In the list of invoices
// on the page (New invoices) and in Saved rebates' invoices.

export type SalesmanTotal = { label: string; lines: number; amount: Cents };

export function SalesmanTotals({ groups }: { groups: readonly SalesmanTotal[] }) {
  if (groups.length === 0) return <span className="text-xs text-ink-muted">—</span>;
  return (
    <ul className="min-w-48 space-y-0.5 text-xs" data-rebates-by-salesman>
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
