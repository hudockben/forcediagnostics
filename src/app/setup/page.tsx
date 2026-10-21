import type { Metadata } from "next";
import { count } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { HudCard, HudShell, primaryButtonClass } from "@/components/hud";
import { systemDb } from "@/db";
import { shops } from "@/db/schema";

import { SetupForm } from "./setup-form";

export const metadata: Metadata = {
  title: "Set up · forcediagnostics.ai",
  robots: { index: false },
};

export default function SetupPage() {
  return (
    <HudShell>
      <Suspense fallback={<p className="font-mono text-sm text-glow/70">Loading…</p>}>
        <Setup />
      </Suspense>
    </HudShell>
  );
}

async function Setup() {
  await connection();
  const [{ total }] = await systemDb.select({ total: count() }).from(shops);
  if (total === 0) return <SetupForm />;

  return (
    <HudCard eyebrow="First-run setup" title="Already set up" titleId="setup-heading">
      <p className="mt-4 text-sm leading-6 text-ink-muted">
        Your shop has been created. New staff accounts are added by an admin.
      </p>
      <Link href="/" className={`${primaryButtonClass} mt-6 flex items-center justify-center`}>
        Go to sign in
      </Link>
    </HudCard>
  );
}
