import type { ReactNode } from "react";

import { TopoScene } from "@/components/topo/topo-scene";
import { Wordmark } from "@/components/wordmark";

// Shared pieces of the Topo HUD screens (sign-in, setup, signed-in home).

const hudText = "font-mono text-[11px] tracking-[0.2em] uppercase";

export const inputBaseClass =
  "block h-12 w-full rounded-lg border border-white/10 bg-forest-950/70 px-3.5 text-base text-ink outline-none transition placeholder:text-ink-muted/50 focus:border-glow/60 focus:ring-2 focus:ring-glow/25";

export const inputClass = `mt-1.5 ${inputBaseClass}`;

export const labelClass = "text-sm font-medium text-ink/90";

const primaryButtonBase =
  "h-12 rounded-lg bg-trail text-base font-semibold text-charcoal-900 shadow-lg shadow-trail/15 transition hover:bg-trail-bright focus-visible:ring-2 focus-visible:ring-trail/60 focus-visible:ring-offset-2 focus-visible:ring-offset-charcoal-900 focus-visible:outline-none disabled:opacity-60";

export const primaryButtonClass = `w-full ${primaryButtonBase}`;

// For a primary action that sits beside other content instead of filling the row.
export const primaryLinkClass = `inline-flex items-center justify-center px-5 ${primaryButtonBase}`;

export const secondaryButtonClass =
  "flex h-12 w-full items-center justify-center gap-2.5 rounded-lg border border-glow/30 text-base font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

export function HudShell({ children }: { children: ReactNode }) {
  return (
    <>
      <TopoScene />
      <div className="relative flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 px-4 py-5 sm:px-8">
          <Wordmark className="text-xl sm:text-2xl" />
          <p className={`flex items-center gap-2 text-glow ${hudText}`}>
            <span className="hud-pulse size-2 rounded-full bg-glow shadow-[0_0_10px] shadow-glow" />
            System online
          </p>
        </header>

        <main className="flex flex-1 items-center justify-center px-4 py-8">{children}</main>

        <footer
          aria-hidden
          className={`flex items-end justify-between gap-4 px-4 pb-5 text-glow/70 sm:px-8 ${hudText}`}
        >
          <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1">
            <dt className="text-glow/45">Lat</dt>
            <dd>N 44°58.402′</dd>
            <dt className="text-glow/45">Lon</dt>
            <dd>W 110°41.317′</dd>
            <dt className="text-glow/45">Elev</dt>
            <dd>2,214 m</dd>
          </dl>
          <div className="hidden flex-col items-end gap-2 sm:flex">
            <span className="flex h-2 w-28 border-x border-b border-glow/50" />
            <span>Contour interval 20 m</span>
          </div>
        </footer>
      </div>
    </>
  );
}

const corners = [
  "-left-px -top-px rounded-tl-2xl border-l border-t",
  "-right-px -top-px rounded-tr-2xl border-r border-t",
  "-bottom-px -left-px rounded-bl-2xl border-b border-l",
  "-bottom-px -right-px rounded-br-2xl border-b border-r",
];

export function HudCard({
  eyebrow,
  title,
  titleId,
  className = "max-w-sm",
  children,
}: {
  eyebrow: string;
  title: string;
  titleId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={titleId}
      className={`relative w-full rounded-2xl border border-glow/15 bg-charcoal-900/75 p-6 shadow-2xl shadow-black/60 backdrop-blur-md sm:p-8 ${className}`}
    >
      {corners.map((corner) => (
        <span
          key={corner}
          aria-hidden
          className={`pointer-events-none absolute size-6 border-glow/70 ${corner}`}
        />
      ))}
      <p className="font-mono text-[11px] tracking-[0.2em] text-glow/80 uppercase">
        {eyebrow}
      </p>
      <h1 id={titleId} className="mt-2 text-2xl font-semibold tracking-tight text-ink">
        {title}
      </h1>
      {children}
    </section>
  );
}
