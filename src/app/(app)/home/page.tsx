import { Suspense } from "react";

import { Badge, Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { ChangePasswordForm } from "@/components/change-password-form";
import { ROLE_LABELS, ROLE_SUMMARIES } from "@/lib/permissions";
import { getCurrentUser } from "@/lib/session";

export default function HomePage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const user = await getCurrentUser();
  return (
    <div className="space-y-6">
      <PageHeading eyebrow={user.shop.name} title={`Welcome, ${user.name}`} />

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Your account">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-muted">Company code</dt>
            <dd className="font-mono text-ink uppercase">{user.shop.code}</dd>
            <dt className="text-ink-muted">Username</dt>
            <dd className="font-mono text-ink">{user.username}</dd>
            <dt className="text-ink-muted">Role</dt>
            <dd>
              <Badge tone="glow">{ROLE_LABELS[user.role]}</Badge>
            </dd>
          </dl>
          <p className="mt-4 text-sm leading-6 text-ink-muted">{ROLE_SUMMARIES[user.role]}</p>
        </Card>

        <Card title="Password" description="Change it any time. Other devices are signed out.">
          <ChangePasswordForm />
        </Card>
      </div>

      <Card title="Coming next">
        <ul className="space-y-2 text-sm leading-6 text-ink-muted">
          <li>Repair orders: write-up, follow-up questions and the shop board.</li>
          <li>The diagnostic workspace: codes, photos, video and tiered causes.</li>
          <li>PIN switching for shared bay tablets.</li>
        </ul>
      </Card>
    </div>
  );
}
