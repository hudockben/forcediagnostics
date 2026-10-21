import type { Metadata } from "next";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, PageHeading } from "@/components/app/ui";
import { ChangePasswordForm } from "@/components/change-password-form";
import { PinButtonForm, SetPinForm } from "@/components/pin-forms";
import { ROLE_LABELS, ROLE_SUMMARIES } from "@/lib/permissions";
import { getPinStatus, isLocked } from "@/lib/pins";
import { getCurrentUser } from "@/lib/session";

import { removeOwnPin, setOwnPin } from "./actions";

export const metadata: Metadata = { title: "Home" };

export default function HomePage() {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const user = await getCurrentUser();
  const pin = await getPinStatus(user.shop.id, user.id);

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

        {user.bay ? (
          <Card title="Password and PIN">
            <p className="text-sm leading-6 text-ink-muted">
              You switched in with your PIN on {user.bay.deviceName}. To change your password or PIN,
              sign in on a computer or your phone.
            </p>
          </Card>
        ) : (
          <Card title="Password" description="Change it any time. Other devices are signed out.">
            <ChangePasswordForm />
          </Card>
        )}
      </div>

      {!user.bay && (
        <Card
          title="PIN for bay tablets"
          description="A 4–6 digit PIN lets you switch in on the shared bay tablets without typing your password."
        >
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            {pin.hasPin ? (
              <>
                <Badge tone="glow">PIN set</Badge>
                {pin.setAt && (
                  <span>
                    on <LocalTime value={pin.setAt.toISOString()} />
                  </span>
                )}
                {isLocked(pin) && <Badge tone="trail">Locked</Badge>}
              </>
            ) : (
              <Badge>No PIN yet</Badge>
            )}
          </div>
          {isLocked(pin) && (
            <p className="mb-4 text-sm leading-6 text-trail">
              Your PIN locked after too many wrong tries. Setting a new one unlocks it. If those tries
              weren&apos;t yours, tell your manager.
            </p>
          )}
          <div className="grid gap-6 md:grid-cols-[3fr_2fr]">
            <SetPinForm action={setOwnPin} withPassword submitLabel={pin.hasPin ? "Change PIN" : "Set PIN"} />
            {pin.hasPin && (
              <div className="self-end">
                <PinButtonForm action={removeOwnPin} withPassword label="Remove PIN" pendingLabel="Removing…" />
              </div>
            )}
          </div>
        </Card>
      )}

      <Card title="Coming next">
        <ul className="space-y-2 text-sm leading-6 text-ink-muted">
          <li>Repair orders: write-up, follow-up questions and the shop board.</li>
          <li>The diagnostic workspace: codes, photos, video and tiered causes.</li>
        </ul>
      </Card>
    </div>
  );
}
