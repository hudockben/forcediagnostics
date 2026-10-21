import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Badge, Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { ROLE_LABELS } from "@/lib/permissions";
import { requireCapability } from "@/lib/session";
import { getStaffMember } from "@/lib/staff";

import { DetailsForm, DisableForm, ResetPasswordForm } from "../forms";

export const metadata: Metadata = { title: "Staff member" };

export default function StaffMemberPage(props: PageProps<"/admin/accounts/[id]">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <StaffMember params={props.params} />
    </Suspense>
  );
}

async function StaffMember({ params }: { params: PageProps<"/admin/accounts/[id]">["params"] }) {
  const admin = await requireCapability("accounts.manage");
  const { id } = await params;
  // Only finds accounts in the admin's own shop.
  const member = await getStaffMember(admin.shop.id, id);
  if (!member) notFound();
  const isSelf = member.id === admin.id;

  return (
    <div className="max-w-xl space-y-6">
      <Link href="/admin/accounts" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Accounts
      </Link>
      <PageHeading
        title={member.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-ink">{member.username}</span>
            <Badge tone="glow">{ROLE_LABELS[member.role]}</Badge>
            {member.disabled && <Badge tone="trail">Disabled</Badge>}
            {isSelf && <Badge>You</Badge>}
          </span>
        }
      />

      <Card title="Details">
        <DetailsForm member={member} isSelf={isSelf} />
      </Card>

      <Card
        title="Password"
        description={
          isSelf
            ? undefined
            : "Set a new password and tell them what it is. They're signed out everywhere."
        }
      >
        {isSelf ? (
          <p className="text-sm leading-6 text-ink-muted">
            Change your own password on the{" "}
            <Link href="/home" className="text-glow hover:underline">
              Home tab
            </Link>
            .
          </p>
        ) : (
          <ResetPasswordForm member={member} />
        )}
      </Card>

      <Card
        title="Access"
        description={
          member.disabled
            ? "This account is disabled and can't sign in."
            : "Disabling keeps their history but stops them signing in."
        }
      >
        {isSelf ? (
          <p className="text-sm leading-6 text-ink-muted">You can&apos;t disable your own account.</p>
        ) : (
          <DisableForm member={member} />
        )}
      </Card>
    </div>
  );
}
