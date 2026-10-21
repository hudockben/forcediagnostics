"use client";

import { Card } from "@/components/app/ui";
import { secondaryButtonClass } from "@/components/hud";

// Shown in place of a signed-in page when something fails unexpectedly, for
// example the connection dropping. The header and tabs stay put.
export default function AppError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Card title="Something went wrong" className="max-w-xl">
      <p className="text-sm leading-6 text-ink-muted">
        This page couldn&apos;t load or save. Check the connection, then try again. If you were
        saving something, check whether it went through before redoing it.
      </p>
      <button type="button" onClick={() => retry()} className={`${secondaryButtonClass} mt-4`}>
        Try again
      </button>
    </Card>
  );
}
