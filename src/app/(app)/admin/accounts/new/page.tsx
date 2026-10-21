import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { requireCapability } from "@/lib/session";

import { AddStaffForm } from "../forms";

export default function NewStaffPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NewStaff />
    </Suspense>
  );
}

async function NewStaff() {
  const admin = await requireCapability("accounts.manage");
  return (
    <div className="max-w-xl space-y-6">
      <Link href="/admin/accounts" className="text-sm text-glow/90 hover:text-glow hover:underline">
        ‹ Accounts
      </Link>
      <PageHeading
        title="Add staff member"
        description="No email needed. Give them their username and starting password; they can change the password after signing in."
      />
      <Card>
        <AddStaffForm companyCode={admin.shop.code} />
      </Card>
    </div>
  );
}
