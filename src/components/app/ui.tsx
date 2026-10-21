import type { ReactNode } from "react";

// Building blocks for the signed-in screens.

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="font-mono text-[11px] tracking-[0.2em] text-glow/80 uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({
  title,
  description,
  children,
  className = "",
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6 ${className}`}>
      {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
      {description && <p className="mt-1 text-sm leading-6 text-ink-muted">{description}</p>}
      <div className={title || description ? "mt-4" : ""}>{children}</div>
    </section>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "glow" | "trail" }) {
  const tones = {
    neutral: "bg-white/5 text-ink-muted",
    glow: "bg-glow/15 text-glow",
    trail: "bg-trail/15 text-trail",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

// Set live={false} when the notice sits inside a live region already.
export function Notice({
  children,
  tone = "glow",
  live = true,
}: {
  children: ReactNode;
  tone?: "glow" | "trail";
  live?: boolean;
}) {
  return (
    <p
      role={live ? "status" : undefined}
      className={`rounded-lg border px-4 py-3 text-sm ${
        tone === "glow" ? "border-glow/30 bg-glow/10 text-glow" : "border-trail/30 bg-trail/10 text-trail"
      }`}
    >
      {children}
    </p>
  );
}

export function LoadingLine() {
  return <p className="font-mono text-sm text-glow/70">Loading…</p>;
}
