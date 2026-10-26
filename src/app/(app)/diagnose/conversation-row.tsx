import Link from "next/link";

import { LocalTime } from "@/components/app/local-time";
import { Badge } from "@/components/app/ui";
import type { ConversationSummary } from "@/lib/diagnose";

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// One diagnosis in a list (the Diagnose tab's, Home's own open ones): its
// title, unit, who started it, how many messages, when, and where it's at.
// Home leaves out who started it and the Open badge (a list of the viewer's
// open ones).
export function ConversationRow({
  conversation,
  startedBy = true,
  openBadge = true,
}: {
  conversation: ConversationSummary;
  startedBy?: boolean;
  openBadge?: boolean;
}) {
  return (
    <li data-diagnosis-row>
      <Link
        href={`/diagnose/${conversation.id}`}
        className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 transition hover:bg-white/[0.03] focus-visible:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-glow/60 focus-visible:outline-none focus-visible:ring-inset sm:px-6"
      >
        <span className="min-w-0">
          <span className="block font-medium break-words text-ink">{conversation.title}</span>
          <span className="block text-xs text-ink-muted">
            {[conversation.unit, startedBy && conversation.startedBy, plural(conversation.techMessages, "message", "messages")]
              .filter(Boolean)
              .join(" · ")}{" "}
            · <LocalTime value={conversation.updatedAt} />
          </span>
        </span>
        <span className="flex gap-2 empty:hidden">
          {conversation.lastTurn === "running" && <Badge tone="glow">Working</Badge>}
          {conversation.lastTurn === "failed" && <Badge tone="trail">Last message failed</Badge>}
          {conversation.status === "solved" ? <Badge tone="glow">Solved</Badge> : openBadge && <Badge>Open</Badge>}
        </span>
      </Link>
    </li>
  );
}
