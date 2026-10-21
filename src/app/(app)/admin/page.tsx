import { redirect } from "next/navigation";
import { Suspense } from "react";

import { LoadingLine } from "@/components/app/ui";
import { ADMIN_SECTIONS } from "@/lib/permissions";
import { allows, getCurrentUser } from "@/lib/session";

// /admin opens the first System Admin section this user may use.
export default function AdminIndexPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <AdminIndex />
    </Suspense>
  );
}

async function AdminIndex(): Promise<null> {
  const user = await getCurrentUser();
  const section = ADMIN_SECTIONS.find((s) => allows(user, s.capability));
  redirect(section?.href ?? "/home");
}
