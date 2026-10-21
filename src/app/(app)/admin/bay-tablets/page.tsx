import type { Metadata } from "next";
import { Suspense } from "react";

import { LocalTime } from "@/components/app/local-time";
import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { listDeviceActivity, listDevices, type DeviceActivity } from "@/lib/bay";
import { listLockedPins } from "@/lib/pins";
import { ROLE_LABELS } from "@/lib/permissions";
import { requireCapability } from "@/lib/session";

import { AddTabletForm, TabletActions, UnlockPinForm } from "./forms";

export const metadata: Metadata = { title: "Bay tablets" };

export default function BayTabletsPage(props: PageProps<"/admin/bay-tablets">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <BayTablets searchParams={props.searchParams} />
    </Suspense>
  );
}

function describe(entry: DeviceActivity) {
  const name = String(entry.details.name ?? "a tablet");
  switch (entry.action) {
    case "device.pairing_code":
      return `${entry.actorName ?? "Someone"} made a pairing code for ${name}`;
    case "device.paired":
      return `${name} was paired`;
    case "device.removed":
      return `${entry.actorName ?? "Someone"} removed ${name}`;
    default:
      return `${entry.action} on ${name}`;
  }
}

async function BayTablets({
  searchParams,
}: {
  searchParams: PageProps<"/admin/bay-tablets">["searchParams"];
}) {
  const actor = await requireCapability("bay_tablets.manage");
  const [devices, locked, activity, { removed }] = await Promise.all([
    listDevices(actor.shop.id),
    listLockedPins(actor.shop.id),
    listDeviceActivity(actor.shop.id),
    searchParams,
  ]);

  return (
    <div className="space-y-6">
      <PageHeading
        title="Bay tablets"
        description="Shared tablets in the bays. Staff switch on them with a PIN instead of a password, and they lock themselves after 5 idle minutes."
      />

      {typeof removed === "string" && (
        <Notice>Removed {removed}. Anyone signed in on it was signed out.</Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <Card
          title="Add a tablet"
          description="Name it, then type the code on the tablet. Do this from your own computer or phone, so no password is typed on the tablet."
        >
          <AddTabletForm />
        </Card>

        <Card title="Tablets" className="p-0 sm:p-0">
          {devices.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-ink-muted sm:px-6 sm:pb-6">No tablets yet.</p>
          ) : (
            <ul className="divide-y divide-white/10">
              {devices.map((device) => (
                <li key={device.id} className="space-y-3 px-5 py-4 sm:px-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-ink">{device.name}</p>
                    {device.pairedAt ? (
                      <Badge tone="glow">Paired</Badge>
                    ) : (
                      <Badge tone="trail">Waiting for its code</Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-muted">
                    Added by {device.createdByName ?? "someone"} ·{" "}
                    {device.lastUsedAt ? (
                      <>
                        last PIN sign-in <LocalTime value={device.lastUsedAt.toISOString()} />
                      </>
                    ) : (
                      "not used yet"
                    )}
                  </p>
                  <TabletActions id={device.id} name={device.name} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Locked PINs"
        description="Five wrong PINs in a row lock a PIN for 15 minutes; ten in a day lock it until someone unlocks it. Signing in with the password also unlocks it."
      >
        {locked.length === 0 ? (
          <p className="text-sm text-ink-muted">No locked PINs.</p>
        ) : (
          <ul className="divide-y divide-white/10">
            {locked.map((person) => (
              <li
                key={person.userId}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div>
                  <p className="font-medium text-ink">{person.name}</p>
                  <p className="text-xs text-ink-muted">
                    {ROLE_LABELS[person.role]} ·{" "}
                    {person.status.hardLocked ? (
                      "locked until unlocked"
                    ) : (
                      <>
                        locked until <LocalTime value={person.status.lockedUntil!.toISOString()} />
                      </>
                    )}
                  </p>
                </div>
                <UnlockPinForm
                  userId={person.userId}
                  name={person.name}
                  allowed={person.role !== "admin" || actor.role === "admin"}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Recent tablet activity">
        {activity.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {activity.map((entry) => (
              <li key={entry.id} className="flex flex-wrap justify-between gap-x-4">
                <span className="text-ink">{describe(entry)}</span>
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
