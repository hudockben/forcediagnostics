import type { Metadata } from "next";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { ROLES } from "@/lib/roles";
import { CAPABILITIES, ROLE_LABELS, ROLE_SUMMARIES } from "@/lib/permissions";
import { requireCapability } from "@/lib/session";

export const metadata: Metadata = { title: "Permissions" };

export default function PermissionsPage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Permissions />
    </Suspense>
  );
}

function Check({ allowed }: { allowed: boolean }) {
  return allowed ? (
    <span className="text-glow">
      <span aria-hidden>✓</span>
      <span className="sr-only">Yes</span>
    </span>
  ) : (
    <span className="text-ink-muted/40">
      <span aria-hidden>—</span>
      <span className="sr-only">No</span>
    </span>
  );
}

async function Permissions() {
  await requireCapability("accounts.manage");
  return (
    <div className="space-y-6">
      <PageHeading
        title="Permissions"
        description="What each role can do. Roles are set per person on the Accounts page. Some of these areas are still being built."
      />

      <Card className="overflow-x-auto p-0 sm:p-0">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left">
              <th scope="col" className="px-5 py-3 font-medium text-ink-muted sm:px-6">
                Area
              </th>
              {ROLES.map((role) => (
                <th key={role} scope="col" className="px-3 py-3 text-center font-medium text-ink">
                  {ROLE_LABELS[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {CAPABILITIES.map((capability) => (
              <tr key={capability.key}>
                <th scope="row" className="px-5 py-3 text-left font-normal sm:px-6">
                  <span className="block text-ink">{capability.label}</span>
                  <span className="block text-xs text-ink-muted">{capability.detail}</span>
                </th>
                {ROLES.map((role) => (
                  <td key={role} className="px-3 py-3 text-center text-base">
                    <Check allowed={(capability.roles as readonly string[]).includes(role)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {ROLES.map((role) => (
          <Card key={role} title={ROLE_LABELS[role]}>
            <p className="text-sm leading-6 text-ink-muted">{ROLE_SUMMARIES[role]}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
