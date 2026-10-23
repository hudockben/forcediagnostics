"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import { primaryLinkClass, secondaryButtonClass } from "@/components/hud";
import { describePages, formatDuration, ocrWorkerCount, roughSeconds } from "@/lib/manual-ocr-rules";

import { ocrJob, type OcrSnapshot } from "./ocr-job";

// The Scanned pages card on System Admin > Manuals: how many pages have no
// text, and a button that reads them with OCR in this browser (see
// ocr-job.ts), with its progress, Pause and Resume, and any pages it
// couldn't read.

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const subscribeNever = () => () => {};

const smallButtonClass =
  "h-9 rounded-lg px-3 text-sm font-medium text-glow transition hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

function Progress({ snapshot }: { snapshot: OcrSnapshot }) {
  const { state, total, read, current, waiting } = snapshot;
  const rate = snapshot.pagesPerMinute;
  const left = total - read;
  const status = waiting
    ? "Waiting for the connection… It carries on by itself when it's back."
    : state === "starting"
      ? "Getting ready…"
      : state === "pausing"
        ? "Pausing after the pages being read…"
        : state === "paused"
          ? "Paused. The pages read so far are saved."
          : current
            ? `Reading ${current.title}: page ${current.pageNumber.toLocaleString("en-US")} (${current.position.toLocaleString("en-US")} of ${plural(current.count, "scanned page", "scanned pages")})`
            : "Reading…";
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm text-ink">
        {status}
      </p>
      <div
        role="progressbar"
        aria-label="Scanned pages read"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={read}
        className="h-2 overflow-hidden rounded-full bg-white/10"
      >
        <div
          className="h-full rounded-full bg-glow transition-[width]"
          style={{ width: `${total > 0 ? (read / total) * 100 : 0}%` }}
        />
      </div>
      <p className="text-xs text-ink-muted">
        {read.toLocaleString("en-US")} of {plural(total, "page", "pages")} read
        {snapshot.manuals > 1 && ` · manual ${Math.min(snapshot.manualsDone + 1, snapshot.manuals)} of ${snapshot.manuals}`}
        {state === "running" && rate !== null && (
          <>
            {" "}
            · {Math.round(rate).toLocaleString("en-US")} pages a minute · {formatDuration((left / rate) * 60)} left
          </>
        )}
      </p>
    </div>
  );
}

function Failures({ snapshot }: { snapshot: OcrSnapshot }) {
  const job = ocrJob();
  const { failures } = snapshot;
  if (failures.length === 0) return null;
  const pages = failures.reduce((total, failure) => total + failure.pages.length, 0);
  const running = ["starting", "running", "pausing", "paused"].includes(snapshot.state);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-trail">
          Couldn&apos;t read {plural(pages, "page", "pages")}. They&apos;re left as they were.
        </p>
        {!running && (
          <button
            type="button"
            onClick={() => job.retry(failures.map((failure) => failure.key))}
            className="h-10 rounded-lg border border-trail/40 px-4 text-sm font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none"
          >
            Retry all
          </button>
        )}
      </div>
      <ul aria-label="Pages OCR couldn't read" className="max-h-72 divide-y divide-white/10 overflow-y-auto rounded-lg border border-white/10">
        {failures.map((failure) => (
          <li key={failure.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
            <div className="min-w-0 text-sm">
              <p className="break-words text-ink">
                {failure.title}, {describePages(failure.pages)}
              </p>
              <p className="text-xs text-trail">{failure.message}</p>
            </div>
            <button
              type="button"
              onClick={() => job.retry([failure.key])}
              aria-label={`Retry ${failure.title}, ${describePages(failure.pages)}`}
              className={smallButtonClass}
            >
              Retry
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ScannedPages({ manuals, pages }: { manuals: number; pages: number }) {
  const router = useRouter();
  const job = ocrJob();
  const snapshot = useSyncExternalStore(job.subscribe, job.getSnapshot, job.getSnapshot);
  // Known only in the browser.
  const processors = useSyncExternalStore(
    subscribeNever,
    () => navigator.hardwareConcurrency || 0,
    () => null,
  );
  // This copy of the card refreshes the page as text is saved.
  useEffect(() => job.setRefresh(() => router.refresh()), [job, router]);

  const { state } = snapshot;
  const running = state === "starting" || state === "running" || state === "pausing" || state === "paused";
  const workers = ocrWorkerCount(processors ?? undefined);

  return (
    <div className="space-y-5">
      {!running && (
        <>
          {state === "finished" && snapshot.read > 0 && (
            <p role="status" className="text-sm text-glow">
              Read {plural(snapshot.read, "page", "pages")} in {plural(snapshot.manuals, "manual", "manuals")}:{" "}
              {plural(snapshot.withText, "page now has", "pages now have")} text search can find
              {snapshot.read > snapshot.withText &&
                `, and ${plural(snapshot.read - snapshot.withText, "page", "pages")} had no words on ${
                  snapshot.read - snapshot.withText === 1 ? "it" : "them"
                } (blank pages or pictures)`}
              .
            </p>
          )}
          {pages === 0 ? (
            <p className="text-sm text-ink-muted">
              {state === "finished" ? "Every scanned page has been read." : "No scanned pages left to read."}
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-ink-muted">Manuals with scanned pages</dt>
                <dd className="mt-1 text-lg font-semibold text-ink">{manuals.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">Pages to read</dt>
                <dd className="mt-1 text-lg font-semibold text-ink">{pages.toLocaleString("en-US")}</dd>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <dt className="text-xs text-ink-muted">Rough time on this computer</dt>
                <dd className="mt-1 text-sm text-ink">
                  {processors === null
                    ? "…"
                    : formatDuration(roughSeconds(pages, workers)).replace(/^./, (first) => first.toUpperCase())}
                </dd>
              </div>
            </dl>
          )}
          {state === "elsewhere" && (
            <p role="status" className="text-sm text-trail">
              Scanned pages are already being read in another tab or window. Carry on there, or close it and try
              again here.
            </p>
          )}
          {snapshot.problem && (
            <p role="alert" className="text-sm text-trail">
              {snapshot.problem}
            </p>
          )}
          {pages > 0 && (
            <div className="space-y-2">
              <button type="button" onClick={() => void job.start()} className={primaryLinkClass}>
                Read scanned pages
              </button>
              <p className="text-xs text-ink-muted">
                It reads in this tab, so leave the tab open while it works. It keeps the computer awake while this
                tab is in front; for a long run, leave it in front or set the computer not to sleep. You can pause
                it, or close the tab and press Read scanned pages again later: it carries on where it stopped.
              </p>
            </div>
          )}
        </>
      )}

      {running && (
        <>
          <Progress snapshot={snapshot} />
          <div className="flex max-w-xs flex-col gap-3 sm:flex-row">
            {state === "paused" || state === "pausing" ? (
              <button type="button" onClick={() => job.resume()} className={secondaryButtonClass}>
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={() => job.pause()}
                disabled={state === "starting"}
                className={secondaryButtonClass}
              >
                Pause
              </button>
            )}
          </div>
          <p className="text-xs text-ink-muted">
            Leave this tab open until it finishes ({plural(snapshot.workers, "page", "pages")} at a time). It keeps the
            computer awake while this tab is in front; for a long run, leave it in front or set the computer not to
            sleep. If the tab closes, press Read scanned pages again later: it carries on where it stopped.
          </p>
        </>
      )}

      <Failures snapshot={snapshot} />
    </div>
  );
}
