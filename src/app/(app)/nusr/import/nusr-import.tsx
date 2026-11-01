"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { Badge, Notice } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { readSpreadsheet } from "@/lib/customer-import-rules";
import {
  MAX_NUSR_IMPORT_FOUND,
  NOTE_KINDS,
  NOTE_KIND_LABELS,
  importNotesCsv,
  nusrImportBatches,
  planNusrImport,
  readNusrWorkbook,
  refSheet,
  type NoteKind,
  type NusrImportEntry,
  type NusrImportNote,
  type NusrImportOutcome,
  type NusrImportPlan,
  type NusrWorkbook,
} from "@/lib/nusr-import-rules";
import { UNIT_TYPE_LABELS, formatMoney, saleFigures, unitLabel } from "@/lib/nusr-rules";

import { importSalesAction } from "./actions";

// The import, in the manager's browser: the workbook is read here (nothing
// is sent until Import is pressed), its NUSR sheets are listed to choose
// from, and the preview shows what will be added, what's on another sheet
// too and what was read another way, by sheet and row. Import sends the
// sales in batches (src/lib/nusr-import-rules.ts), one after another, and
// the report at the end says what happened to each.

type Loaded = { fileName: string; workbook: NusrWorkbook; others: string[] };

type Run =
  | { state: "running"; sent: number; total: number; outcomes: NusrImportOutcome[] }
  | { state: "done"; total: number; outcomes: NusrImportOutcome[] }
  | { state: "stopped"; sent: number; total: number; outcomes: NusrImportOutcome[]; error: string };

// An import under way: its batches, the next one to send, and what's come
// back (with the sales on file it has found, which go with each batch), so
// a stopped one carries on where it stopped.
type Job = {
  importId: string;
  fileName: string;
  batches: NusrImportEntry[][];
  next: number;
  sent: number;
  total: number;
  outcomes: NusrImportOutcome[];
  found: Set<string>;
};

const smallButtonClass =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// Today in the browser's own time zone, for noting dates in the future.
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// A file to save, made in the browser.
function download(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// What the server said about a sale, as a note on its sheet and row.
function outcomeNotes(outcomes: readonly NusrImportOutcome[]): NusrImportNote[] {
  return outcomes.flatMap((outcome): NusrImportNote[] => {
    if (outcome.result === "added" || !outcome.reason) return [];
    const row = Number(outcome.ref.slice(outcome.ref.lastIndexOf("!") + 1)) || 0;
    const sheet = refSheet(outcome.ref) ?? "";
    return outcome.result === "failed"
      ? [{ sheet, row, kind: "skipped", message: `Not saved: ${outcome.reason}`, skipped: true }]
      : [{ sheet, row, kind: "onFile", message: `${outcome.reason.replace(/\.$/, "")}: left out.`, skipped: false }];
  });
}

export function NusrImport() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const job = useRef<Job | null>(null);
  const fileId = useId();

  // Planning again as sheets are ticked: the boxes answer at once and the
  // preview follows.
  const plannedChosen = useDeferredValue(chosen);
  const planning = plannedChosen !== chosen;
  const plan = useMemo(() => (loaded ? planNusrImport(loaded.workbook, plannedChosen) : null), [loaded, plannedChosen]);
  const running = run?.state === "running";

  // Closing the tab mid-import loses the batches not yet sent.
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  async function choose(file: File | undefined) {
    if (!file || running) return;
    setReading(true);
    setReadError(null);
    setRun(null);
    try {
      // Hidden sheets too, so a year hidden in Excel is listed, not missed.
      const result = await readSpreadsheet(file.name, new Uint8Array(await file.arrayBuffer()), { hidden: true });
      if ("error" in result) {
        setLoaded(null);
        setReadError(result.error);
        return;
      }
      const workbook = readNusrWorkbook(result.sheets, { today: localToday() });
      if (workbook.sheets.length === 0) {
        setLoaded(null);
        setReadError("That file has no NUSR sheets: none has the NUSR's headings (Date, Salesman, Customer Name, VIN, Sales Price and the rest) in its first rows.");
        return;
      }
      const nusr = new Set(workbook.sheets.map((sheet) => sheet.index));
      const others = result.sheets.flatMap((sheet, index) => (nusr.has(index) ? [] : [sheet.hidden ? `${sheet.name} (hidden)` : sheet.name]));
      setLoaded({ fileName: file.name, workbook, others });
      setChosen(workbook.sheets.filter((sheet) => sheet.chosen).map((sheet) => sheet.index));
    } catch (error) {
      console.error("Couldn't read the NUSR workbook", error);
      setLoaded(null);
      setReadError("That file couldn't be read. Check it opens in Excel, then try again.");
    } finally {
      setReading(false);
      if (input.current) input.current.value = "";
    }
  }

  // Sends the job's batches from where it stopped, one after another.
  async function send() {
    const current = job.current;
    if (!current) return;
    setRun({ state: "running", sent: current.sent, total: current.total, outcomes: [...current.outcomes] });
    while (current.next < current.batches.length) {
      const batch = current.batches[current.next];
      const found = [...current.found].slice(-MAX_NUSR_IMPORT_FOUND);
      const result = await importSalesAction({ importId: current.importId, fileName: current.fileName, sales: batch, found }).catch(() => ({
        error: "The connection dropped.",
      }));
      if ("error" in result) {
        setRun({ state: "stopped", sent: current.sent, total: current.total, outcomes: [...current.outcomes], error: result.error });
        return;
      }
      current.outcomes.push(...result.outcomes);
      for (const id of result.found) current.found.add(id);
      current.sent += batch.length;
      current.next++;
      setRun({ state: "running", sent: current.sent, total: current.total, outcomes: [...current.outcomes] });
    }
    job.current = null;
    setRun({ state: "done", total: current.total, outcomes: current.outcomes });
  }

  function start() {
    if (!plan || !loaded || running || planning || plan.sales.length === 0) return;
    job.current = {
      importId: crypto.randomUUID(),
      fileName: loaded.fileName,
      batches: nusrImportBatches(plan.sales),
      next: 0,
      sent: 0,
      total: plan.sales.length,
      outcomes: [],
      found: new Set(),
    };
    void send();
  }

  function reset() {
    job.current = null;
    setLoaded(null);
    setRun(null);
    setReadError(null);
    setChosen([]);
  }

  // Every note: the plan's, then the server's.
  const notes = useMemo(() => [...(plan?.notes ?? []), ...outcomeNotes(run?.outcomes ?? [])], [plan, run]);

  if (run && run.state !== "running") {
    return (
      <Finished
        run={run}
        notes={notes}
        fileName={loaded?.fileName ?? "NUSR"}
        onAgain={reset}
        onCarryOn={run.state === "stopped" ? () => void send() : null}
      />
    );
  }

  const counts = new Map((plan?.sheets ?? []).map((sheet) => [sheet.index, sheet]));
  const repeats = loaded?.workbook.sheets.filter((sheet) => sheet.repeats) ?? [];
  const hidden = loaded?.workbook.sheets.filter((sheet) => sheet.hidden) ?? [];

  return (
    <div className="space-y-6">
      <Section title="1. Choose the workbook">
        <label
          htmlFor={fileId}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void choose(event.dataTransfer.files[0]);
          }}
          className={`flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
            dragging ? "border-glow/60 bg-glow/10" : "border-white/20 hover:border-white/30"
          }`}
        >
          <span className="text-sm font-medium text-ink">
            {reading ? "Reading…" : loaded ? `${loaded.fileName}: choose another` : "Choose the NUSR workbook, or drop it here"}
          </span>
          <span className="text-xs text-ink-muted">An Excel workbook (.xlsx), up to 20 MB, with a sheet a year (2015, 2016…) and Trailers, New and Used.</span>
          <input
            ref={input}
            id={fileId}
            type="file"
            accept=".xlsx,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            disabled={reading || running}
            onChange={(event) => void choose(event.target.files?.[0])}
            className="sr-only"
            data-nusr-import-file
          />
        </label>
        {readError && (
          <div className="mt-3">
            <Notice tone="trail">{readError}</Notice>
          </div>
        )}
      </Section>

      {loaded && (
        <Section title="2. Choose the sheets">
          <ul className="divide-y divide-white/10 rounded-lg border border-white/10" data-nusr-import-sheets>
            {loaded.workbook.sheets.map((sheet) => {
              const count = chosen.includes(sheet.index) ? counts.get(sheet.index) : undefined;
              const parts = [
                ...(count
                  ? [
                      `${plural(count.toAdd, "to add", "to add")}`,
                      ...(count.duplicates ? [`${plural(count.duplicates, "on another sheet too", "on another sheet too")}`] : []),
                      ...(count.skipped ? [`${plural(count.skipped, "left out", "left out")}`] : []),
                      // The sheet's TOTAL, AVG and comparison rows: the NUSR tab works them out.
                      ...(count.totalsFrom ? [`TOTAL rows from row ${count.totalsFrom} left out`] : []),
                    ]
                  : sheet.repeats
                    ? ["repeats the year sheets"]
                    : []),
                ...(sheet.hidden ? ["hidden in the workbook"] : []),
              ];
              return (
                <li key={sheet.index}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 px-4 py-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={chosen.includes(sheet.index)}
                      disabled={running}
                      onChange={(event) =>
                        setChosen((old) => (event.target.checked ? [...old, sheet.index] : old.filter((index) => index !== sheet.index)))
                      }
                      className="size-5 shrink-0 accent-glow"
                    />
                    <span className="min-w-20 font-medium text-ink">{sheet.name}</span>
                    <span className="min-w-0 text-ink-muted">
                      {plural(sheet.sales, "sale", "sales")}
                      {parts.length > 0 && <span className={planning && count ? "opacity-60" : ""}>: {parts.join(" · ")}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {repeats.length > 0 && (
            <p className="mt-3 text-sm leading-6 text-ink-muted">
              {repeats.map((sheet) => sheet.name).join(" and ")} {repeats.length === 1 ? "repeats" : "repeat"} the year sheets: every unit on{" "}
              {repeats.length === 1 ? "it" : "them"} is on its year&apos;s sheet too. Ticked, a row is left out when a year sheet has its sale
              {repeats.some((sheet) => /^\s*new\s*$/i.test(sheet.name))
                ? ", a sale to the same customer that day, or (on New) its VIN sold new"
                : " or a sale to the same customer that day"}
              ; each sale {repeats.length === 1 ? "it still adds" : "they still add"} is noted, to check against the year sheets.
            </p>
          )}
          {hidden.length > 0 && (
            <p className="mt-3 text-sm leading-6 text-ink-muted">
              {hidden.map((sheet) => sheet.name).join(", ")} {hidden.length === 1 ? "is" : "are"} hidden in the workbook, so{" "}
              {hidden.length === 1 ? "it's" : "they're"} left unticked (a hidden sheet is often an old copy); tick {hidden.length === 1 ? "it" : "one"} to
              import it all the same.
            </p>
          )}
          {loaded.others.length > 0 && (
            <p className="mt-3 text-sm leading-6 text-ink-muted">
              Not read (no NUSR headings): {loaded.others.join(", ")}.
            </p>
          )}
        </Section>
      )}

      {loaded && plan && (
        <Section title="3. Import">
          <div aria-busy={planning} className={`transition-opacity ${planning ? "opacity-60" : ""}`}>
            <Preview plan={plan} notes={notes} fileName={loaded.fileName} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <button
              type="button"
              onClick={start}
              disabled={running || planning || plan.sales.length === 0}
              className={primaryLinkClass}
              data-nusr-import-start
            >
              {running ? "Importing…" : planning ? "Updating…" : `Import ${plural(plan.sales.length, "sale", "sales")}`}
            </button>
            {run?.state === "running" && (
              <div className="min-w-56 flex-1" role="status">
                <div
                  role="progressbar"
                  aria-label="Sales saved"
                  aria-valuemin={0}
                  aria-valuemax={run.total}
                  aria-valuenow={run.sent}
                  className="h-2 overflow-hidden rounded-full bg-white/10"
                >
                  <div className="h-full bg-glow transition-[width]" style={{ width: `${run.total ? (run.sent / run.total) * 100 : 0}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-ink-muted">
                  Saved {run.sent.toLocaleString("en-US")} of {plural(run.total, "sale", "sales")}. Keep this tab open.
                </p>
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

const PREVIEW_ROWS = 8;

function Preview({ plan, notes, fileName }: { plan: NusrImportPlan; notes: NusrImportNote[]; fileName: string }) {
  const total = (key: "toAdd" | "duplicates" | "skipped") => plan.sheets.reduce((sum, sheet) => sum + sheet[key], 0);
  const shown = plan.sales.slice(0, PREVIEW_ROWS);
  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-2" data-nusr-import-totals>
        <li>
          <Badge tone="glow">{plural(total("toAdd"), "sale to add", "sales to add")}</Badge>
        </li>
        <li>
          <Badge>{plural(total("duplicates"), "on another sheet too", "on another sheet too")}</Badge>
        </li>
        <li>
          <Badge tone={total("skipped") > 0 ? "trail" : "neutral"}>{plural(total("skipped"), "left out", "left out")}</Badge>
        </li>
      </ul>
      <p className="text-sm leading-6 text-ink-muted">
        The figures (unit profit, holdback, total profit and the bonuses) are worked out from each sale&apos;s amounts, at the holdback and bonus rates
        the sheet used. Sales already in the NUSR, from an earlier import or typed in, are found as they&apos;re saved and left out, and so is a sale
        an earlier import brought in that was removed from the NUSR since. A sale is tied to a customer on file when the name and phone number both
        match.
      </p>
      {shown.length > 0 && (
        <div className="-mx-5 overflow-x-auto sm:-mx-6">
          <table className="w-full min-w-[44rem] text-sm" data-nusr-import-preview>
            <caption className="sr-only">The first sales to be imported</caption>
            <thead>
              <tr className="border-y border-white/10 text-left text-xs text-ink-muted">
                <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                  Date
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Customer
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Unit
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Sales Price
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium sm:px-6">
                  Total profit
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {shown.map(({ ref, sheet, row, sale }) => (
                <tr key={ref} className="align-top">
                  <td className="px-5 py-2 whitespace-nowrap text-ink sm:px-6">
                    {sale.soldOn}
                    <span className="block text-xs text-ink-muted">
                      {sheet} row {row}
                    </span>
                  </td>
                  <th scope="row" className="px-3 py-2 text-left font-medium break-words text-ink">
                    {sale.customerName}
                    <span className="block text-xs font-normal text-ink-muted">{sale.salesperson ?? "—"}</span>
                  </th>
                  <td className="px-3 py-2 break-words text-ink">
                    {unitLabel(sale)}
                    <span className="block text-xs text-ink-muted">
                      {sale.condition === "new" ? "New" : "Used"} · {UNIT_TYPE_LABELS[sale.unitType]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-ink">{formatMoney(sale.salesPrice) || "—"}</td>
                  <td className="px-5 py-2 text-right whitespace-nowrap text-ink sm:px-6">{formatMoney(saleFigures(sale).totalProfit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.sales.length > shown.length && (
            <p className="mt-2 px-5 text-xs text-ink-muted sm:px-6">…and {plural(plan.sales.length - shown.length, "more", "more")}.</p>
          )}
        </div>
      )}
      <Notes notes={notes} fileName={fileName} />
    </div>
  );
}

const NOTES_SHOWN = 30;
// Notes that only say a sale is somewhere else already: nothing to look at.
const QUIET: NoteKind[] = ["duplicate", "onFile"];

// What was, or will be, left out or read another way, by what it's about,
// each by sheet and row.
function Notes({ notes, fileName }: { notes: NusrImportNote[]; fileName: string }) {
  if (notes.length === 0) return null;
  const groups = NOTE_KINDS.map((kind) => ({ kind, notes: notes.filter((note) => note.kind === kind) })).filter((group) => group.notes.length > 0);
  return (
    <div className="space-y-2" data-nusr-import-notes>
      {groups.map(({ kind, notes: group }) => {
        const quiet = QUIET.includes(kind);
        return (
          <details
            key={kind}
            className={`rounded-lg border px-4 py-3 text-sm ${quiet ? "border-white/10 bg-white/5" : "border-trail/30 bg-trail/5"}`}
            data-nusr-import-note-kind={kind}
          >
            <summary className={`cursor-pointer font-medium ${quiet ? "text-ink" : "text-trail"}`}>
              {NOTE_KIND_LABELS[kind]}: {plural(new Set(group.map((note) => `${note.sheet}!${note.row}`)).size, "row", "rows")}
            </summary>
            <ul className="mt-2 space-y-1 text-ink">
              {group.slice(0, NOTES_SHOWN).map((note, index) => (
                <li key={index} className="flex gap-3">
                  <span className="w-24 shrink-0 font-mono text-xs leading-5 text-ink-muted">
                    {note.sheet} · {note.row}
                  </span>
                  <span className="min-w-0 break-words">{note.message}</span>
                </li>
              ))}
            </ul>
            {group.length > NOTES_SHOWN && (
              <p className="mt-2 text-xs text-ink-muted">…and {plural(group.length - NOTES_SHOWN, "more", "more")}: the download has them all.</p>
            )}
          </details>
        );
      })}
      <button
        type="button"
        onClick={() => download(`${fileName.replace(/\.[^.]+$/, "")} - import notes.csv`, importNotesCsv(notes))}
        className="text-sm text-glow/90 hover:text-glow hover:underline"
      >
        Download all {plural(notes.length, "note", "notes")} (CSV)
      </button>
    </div>
  );
}

function Finished({
  run,
  notes,
  fileName,
  onAgain,
  onCarryOn,
}: {
  run: Extract<Run, { state: "done" | "stopped" }>;
  notes: NusrImportNote[];
  fileName: string;
  onAgain: () => void;
  // Sends the rest of a stopped import, with the same file and sheets.
  onCarryOn: (() => void) | null;
}) {
  // Focus moves to the result, which screen readers then read out.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [run.state]);
  const count = (result: NusrImportOutcome["result"]) => run.outcomes.filter((outcome) => outcome.result === result).length;
  return (
    <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-nusr-import-finished={run.state}>
      <h2 ref={heading} tabIndex={-1} className="text-base font-semibold text-ink focus:outline-none">
        {run.state === "done" ? "Import finished" : "Import stopped"}
      </h2>
      {run.state === "stopped" && (
        <Notice tone="trail">
          Stopped after {run.sent.toLocaleString("en-US")} of {plural(run.total, "sale", "sales")}: {run.error} Carry on sends the rest, with the
          sheets as you chose them; nothing already saved is added twice.
        </Notice>
      )}
      <ul className="flex flex-wrap gap-2" data-nusr-import-result>
        <li>
          <Badge tone="glow">{plural(count("added"), "sale added", "sales added")}</Badge>
        </li>
        <li>
          <Badge>{plural(count("already"), "already in the NUSR", "already in the NUSR")}</Badge>
        </li>
        {count("failed") > 0 && (
          <li>
            <Badge tone="trail">{plural(count("failed"), "left out", "left out")}</Badge>
          </li>
        )}
      </ul>
      <Notes notes={notes} fileName={fileName} />
      <div className="flex flex-wrap gap-3">
        {onCarryOn ? (
          <button type="button" onClick={onCarryOn} className={primaryLinkClass} data-nusr-import-carry-on>
            Carry on
          </button>
        ) : (
          <Link href="/nusr" className={primaryLinkClass}>
            View the NUSR
          </Link>
        )}
        <button type="button" onClick={onAgain} className={smallButtonClass}>
          Import another file
        </button>
      </div>
    </section>
  );
}
