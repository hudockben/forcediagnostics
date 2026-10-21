import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { ROLE_LABELS } from "@/lib/permissions";
import { isRole, listAccountActivity, listStaff, type AuditEntry } from "@/lib/staff";
import { requireCapability } from "@/lib/session";

export const metadata: Metadata = { title: "Accounts" };

export default function AccountsPage(props: PageProps<"/admin/accounts">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Accounts searchParams={props.searchParams} />
    </Suspense>
  );
}

function roleLabel(value: unknown) {
  return typeof value === "string" && isRole(value) ? ROLE_LABELS[value] : String(value);
}

function describe(entry: AuditEntry) {
  const who = String(entry.details.username ?? "an account");
  switch (entry.action) {
    case "account.created":
      return `added ${who} as ${roleLabel(entry.details.role)}`;
    case "account.updated": {
      const role = entry.details.role as { from?: unknown; to?: unknown } | undefined;
      const name = entry.details.name as { to?: unknown } | undefined;
      const parts = [
        role && `changed ${who} from ${roleLabel(role.from)} to ${roleLabel(role.to)}`,
        name && `renamed ${who} to ${String(name.to)}`,
      ].filter(Boolean);
      return parts.join(" and ") || `updated ${who}`;
    }
    case "account.disabled":
      return `disabled ${who}`;
    case "account.enabled":
      return `turned ${who} back on`;
    case "account.password_reset":
      return `reset the password for ${who}`;
    default:
      return `${entry.action} on ${who}`;
  }
}

async function Accounts({
  searchParams,
}: {
  searchParams: PageProps<"/admin/accounts">["searchParams"];
}) {
  const admin = await requireCapability("accounts.manage");
  const [staff, activity, { added }] = await Promise.all([
    listStaff(admin.shop.id),
    listAccountActivity(admin.shop.id),
    searchParams,
  ]);
  const addedMember = typeof added === "string" ? staff.find((m) => m.id === added) : undefined;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Accounts"
        description={
          <>
            Everyone who signs in to {admin.shop.name}. Staff sign in with company code{" "}
            <span className="font-mono text-ink uppercase">{admin.shop.code}</span> and their username.
          </>
        }
        action={
          <Link href="/admin/accounts/new" className={primaryLinkClass}>
            Add staff member
          </Link>
        }
      />

      {addedMember && (
        <Notice>
          Added {addedMember.name}. They can sign in now with username{" "}
          <span className="font-mono">{addedMember.username}</span>.
        </Notice>
      )}

      <Card className="p-0 sm:p-0">
        <ul className="divide-y divide-white/10">
          {staff.map((member) => (
            <li key={member.id}>
              <Link
                href={`/admin/accounts/${member.id}`}
                className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 transition hover:bg-white/[0.03] focus-visible:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-glow/60 focus-visible:outline-none focus-visible:ring-inset sm:px-6"
              >
                <div className={member.disabled ? "opacity-60" : undefined}>
                  <p className="font-medium text-ink">{member.name}</p>
                  <p className="font-mono text-sm text-ink-muted">{member.username}</p>
                </div>
                <div className="flex items-center gap-2">
                  {member.id === admin.id && <Badge>You</Badge>}
                  {member.disabled && <Badge tone="trail">Disabled</Badge>}
                  <Badge tone="glow">{ROLE_LABELS[member.role]}</Badge>
                  <span aria-hidden className="pl-1 text-ink-muted">
                    ›
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Recent account changes">
        {activity.length === 0 ? (
          <p className="text-sm text-ink-muted">No changes yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {activity.map((entry) => (
              <li key={entry.id} className="flex flex-wrap justify-between gap-x-4">
                <span className="text-ink">
                  {entry.actorName ?? "Someone"} {describe(entry)}
                </span>
                <span className="text-ink-muted">
                  <LocalTime value={entry.createdAt.toISOString()} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
