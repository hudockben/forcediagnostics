"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import { Badge, Notice } from "@/components/app/ui";
import { inputBaseClass, labelClass, primaryLinkClass, secondaryButtonClass } from "@/components/hud";
import { parseCsv } from "@/lib/csv";
import { pastedDelimiter, readSpreadsheet, reportCsv, type Sheet } from "@/lib/customer-import-rules";
import {
  MAX_STICKER_IMPORT_BATCH,
  REQUIRED_STICKER_FIELDS,
  STICKER_IMPORT_FIELDS,
  STICKER_IMPORT_LABELS,
  findStickerHeader,
  planStickerImport,
  stickerColumns,
  type StickerImportField,
  type StickerImportOutcome,
  type StickerImportRow,
} from "@/lib/sticker-import-rules";
import { PLATE_CLASSES, PLATE_CLASS_LABELS, type PlateClass } from "@/lib/sticker-log-rules";

import { importStickersAction } from "../actions";

// Importing a sticker log, in the browser: a CSV or Excel file, or rows
// pasted from a spreadsheet. Each column is matched to a field by its
// heading (and can be changed), the preview shows what will be logged and
// what's left out, and Import sends the stickers in batches. A sticker
// already in the log is left as it is, so importing the file again adds
// nothing new.

type Loaded = { name: string; sheets: Sheet[] };
type Run =
  | { state: "running"; sent: number; total: number; outcomes: StickerImportOutcome[] }
  | { state: "done" | "stopped"; sent: number; total: number; outcomes: StickerImportOutcome[]; error?: string };

const selectClass = `${inputBaseClass} h-11 appearance-none pr-9 text-sm`;
const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const columnLetter = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

function Chevron() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 fill-none stroke-ink-muted" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 8 5 5 5-5" />
    </svg>
  );
}

function download(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StickerImport() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pasted, setPasted] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<(StickerImportField | null)[]>([]);
  // The class for rows that don't have one: every row, for a list without
  // a Plate Classification column (stickers on one list, plates on another).
  const [plateClass, setPlateClass] = useState<PlateClass | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const job = useRef<{ importId: string; name: string; batches: StickerImportRow[][]; next: number; sent: number; outcomes: StickerImportOutcome[] } | null>(null);
  const fileId = useId();
  const finished = useRef<HTMLHeadingElement>(null);

  const rows = useMemo(() => loaded?.sheets[sheetIndex]?.rows ?? [], [loaded, sheetIndex]);
  const plannedMapping = useDeferredValue(mapping);
  const plannedHeader = useDeferredValue(headerRow);
  const planning = plannedMapping !== mapping || plannedHeader !== headerRow;
  const plan = useMemo(
    () => (loaded ? planStickerImport(rows, plannedHeader, plannedMapping, { plateClass }) : null),
    [loaded, rows, plannedHeader, plannedMapping, plateClass],
  );
  const running = run?.state === "running";
  const hasRequired = REQUIRED_STICKER_FIELDS.every((field) => mapping.includes(field));
  const hasPhone = mapping.includes("phone");
  const hasClassColumn = mapping.includes("plateClass");
  const classReady = hasClassColumn || plateClass !== null;

  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);
  useEffect(() => {
    if (run && run.state !== "running") finished.current?.focus();
  }, [run]);

  function show(next: Loaded, index: number) {
    const sheetRows = next.sheets[index]?.rows ?? [];
    const at = Math.max(0, findStickerHeader(sheetRows));
    setLoaded(next);
    setSheetIndex(index);
    setHeaderRow(at);
    setMapping(stickerColumns(sheetRows[at] ?? []));
    // Each list's class is picked for it: a list of plates after a list of
    // stickers doesn't take the stickers' class.
    setPlateClass(null);
    setRun(null);
    setReadError(null);
  }

  async function choose(file: File | undefined) {
    if (!file || running) return;
    setReading(true);
    try {
      const result = await readSpreadsheet(file.name, new Uint8Array(await file.arrayBuffer()));
      if ("error" in result) {
        setLoaded(null);
        setReadError(result.error);
        return;
      }
      const first = Math.max(0, result.sheets.findIndex((sheet) => sheet.rows.some((row) => row.some((cell) => cell.trim()))));
      show({ name: file.name, sheets: result.sheets }, first);
    } catch (error) {
      console.error("Couldn't read the sticker file", error);
      setReadError("That file couldn't be read. Check it opens in Excel, then try again.");
    } finally {
      setReading(false);
    }
  }

  function readPasted() {
    const text = pasted.replace(/\r\n?/g, "\n");
    if (!text.trim()) return;
    try {
      show({ name: "pasted rows", sheets: [{ name: "Pasted", rows: parseCsv(text, pastedDelimiter(text)) }] }, 0);
    } catch {
      setReadError("Those rows couldn't be read. Copy them from the spreadsheet again, headings and all.");
    }
  }

  async function send() {
    const current = job.current;
    if (!current) return;
    const total = current.batches.reduce((sum, batch) => sum + batch.length, 0);
    setRun({ state: "running", sent: current.sent, total, outcomes: [...current.outcomes] });
    while (current.next < current.batches.length) {
      const batch = current.batches[current.next];
      const result = await importStickersAction({ importId: current.importId, fileName: current.name, stickers: batch }).catch(() => ({ error: "The connection dropped." }));
      if ("error" in result) {
        setRun({ state: "stopped", sent: current.sent, total, outcomes: [...current.outcomes], error: result.error });
        return;
      }
      current.outcomes.push(...result.outcomes);
      current.sent += batch.length;
      current.next++;
      setRun({ state: "running", sent: current.sent, total, outcomes: [...current.outcomes] });
    }
    job.current = null;
    setRun({ state: "done", sent: total, total, outcomes: current.outcomes });
  }

  function start() {
    if (!plan || !loaded || running || planning || plan.stickers.length === 0) return;
    const batches: StickerImportRow[][] = [];
    for (let at = 0; at < plan.stickers.length; at += MAX_STICKER_IMPORT_BATCH) batches.push(plan.stickers.slice(at, at + MAX_STICKER_IMPORT_BATCH));
    job.current = { importId: crypto.randomUUID(), name: loaded.name, batches, next: 0, sent: 0, outcomes: [] };
    void send();
  }

  // Each column's heading and two examples; the first column with a field
  // is the one read.
  const columns = useMemo(() => {
    const width = Math.max(rows[headerRow]?.length ?? 0, ...rows.slice(headerRow + 1, headerRow + 21).map((row) => row.length));
    return Array.from({ length: width }, (_, column) => {
      const examples: string[] = [];
      for (let index = headerRow + 1; index < rows.length && examples.length < 2; index++) {
        const value = rows[index][column]?.trim();
        if (value) examples.push(value.length > 40 ? `${value.slice(0, 40)}…` : value);
      }
      return { label: rows[headerRow]?.[column]?.trim() || `Column ${columnLetter(column)}`, examples };
    });
  }, [rows, headerRow]);
  const firstColumn = useMemo(() => {
    const first = new Map<StickerImportField, number>();
    mapping.forEach((field, column) => {
      if (field && !first.has(field)) first.set(field, column);
    });
    return first;
  }, [mapping]);

  // The plan's notes, then what the server said: a row it left out, or a
  // sticker the log has for someone else.
  const notes = useMemo(() => {
    const all = (plan?.notes ?? []).map((note) => ({ ...note, skipped: false }));
    for (const outcome of run?.outcomes ?? []) {
      if (outcome.result === "failed") all.push({ row: outcome.row, message: `Left out: ${outcome.message}`, skipped: true });
      else if (outcome.message) all.push({ row: outcome.row, message: outcome.message, skipped: true });
    }
    return all;
  }, [plan, run]);

  if (run && run.state !== "running") {
    const count = (result: StickerImportOutcome["result"]) => run.outcomes.filter((outcome) => outcome.result === result).length;
    const customersAdded = run.outcomes.filter((outcome) => outcome.customer === "added").length;
    return (
      <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-sticker-import-finished={run.state}>
        <h2 ref={finished} tabIndex={-1} className="text-base font-semibold text-ink focus:outline-none">
          {run.state === "done" ? "Import finished" : "Import stopped"}
        </h2>
        {run.state === "stopped" && (
          <Notice tone="trail">
            Stopped after {run.sent.toLocaleString("en-US")} of {plural(run.total, "sticker", "stickers")}: {run.error} Carry on sends the rest;
            nothing already saved is logged twice.
          </Notice>
        )}
        <ul className="flex flex-wrap gap-2" data-sticker-import-result>
          <li>
            <Badge tone="glow">{plural(count("logged"), "sticker logged", "stickers logged")}</Badge>
          </li>
          <li>
            <Badge>{plural(count("already"), "already in the log", "already in the log")}</Badge>
          </li>
          {customersAdded > 0 && (
            <li>
              <Badge>{plural(customersAdded, "customer added to Customers", "customers added to Customers")}</Badge>
            </li>
          )}
          {count("failed") > 0 && (
            <li>
              <Badge tone="trail">{plural(count("failed"), "left out", "left out")}</Badge>
            </li>
          )}
        </ul>
        <Notes notes={notes} />
        <div className="flex flex-wrap gap-3">
          {run.state === "stopped" ? (
            <button type="button" onClick={() => void send()} className={primaryLinkClass}>
              Carry on
            </button>
          ) : (
            <Link href="/sticker-plate-log" className={primaryLinkClass}>
              View the log
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              job.current = null;
              setRun(null);
              setLoaded(null);
              setPasted("");
            }}
            className="inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            Import another file
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
        <h2 className="text-base font-semibold text-ink">1. The log</h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <label
            htmlFor={fileId}
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/20 px-4 py-6 text-center transition hover:border-white/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40"
          >
            <span className="text-sm font-medium text-ink">{reading ? "Reading…" : loaded && loaded.name !== "pasted rows" ? `${loaded.name}: choose another` : "Choose a CSV or Excel file"}</span>
            <span className="text-xs text-ink-muted">With a headings row: Sticker # and Customer Name, and Plate Classification and Phone if you have them.</span>
            <input
              id={fileId}
              type="file"
              accept=".csv,.txt,.tsv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={reading || running}
              onChange={(event) => {
                void choose(event.target.files?.[0]);
                event.target.value = "";
              }}
              className="sr-only"
              data-sticker-file
            />
          </label>
          <div>
            <label htmlFor="sticker-paste" className={labelClass}>
              Or paste the rows from Excel, headings and all
            </label>
            <textarea
              id="sticker-paste"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
              spellCheck={false}
              className={`mt-1.5 ${inputBaseClass} h-auto py-3 font-mono text-sm`}
              data-sticker-paste
            />
            <button type="button" onClick={readPasted} disabled={!pasted.trim() || running} className={`${secondaryButtonClass} mt-2`}>
              Use these rows
            </button>
          </div>
        </div>
        {readError && (
          <div className="mt-3">
            <Notice tone="trail">{readError}</Notice>
          </div>
        )}
      </section>

      {loaded && (
        <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
          <h2 className="text-base font-semibold text-ink">2. Check the columns</h2>
          <div className="mt-4 flex flex-wrap gap-4">
            {loaded.sheets.length > 1 && (
              <div className="min-w-48">
                <label htmlFor="sticker-sheet" className={labelClass}>
                  Sheet
                </label>
                <div className="relative mt-1.5">
                  <select id="sticker-sheet" value={sheetIndex} disabled={running} onChange={(event) => show(loaded, Number(event.target.value))} className={selectClass}>
                    {loaded.sheets.map((sheet, index) => (
                      <option key={`${sheet.name}-${index}`} value={index}>
                        {sheet.name}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </div>
            )}
            <div className="min-w-40">
              <label htmlFor="sticker-header" className={labelClass}>
                Headings are on
              </label>
              <div className="relative mt-1.5">
                <select
                  id="sticker-header"
                  value={headerRow}
                  disabled={running}
                  onChange={(event) => {
                    const at = Number(event.target.value);
                    setHeaderRow(at);
                    setMapping(stickerColumns(rows[at] ?? []));
                  }}
                  className={selectClass}
                >
                  {Array.from({ length: Math.min(10, Math.max(1, rows.length)) }, (_, index) => (
                    <option key={index} value={index}>
                      Row {index + 1}
                    </option>
                  ))}
                </select>
                <Chevron />
              </div>
            </div>
            <div className="min-w-56">
              <label htmlFor="sticker-class" className={labelClass}>
                {hasClassColumn ? "Rows with no Plate Classification" : "Plate Classification for these rows"}
              </label>
              <div className="relative mt-1.5">
                <select
                  id="sticker-class"
                  value={plateClass ?? ""}
                  disabled={running}
                  onChange={(event) => setPlateClass(event.target.value ? (Number(event.target.value) as PlateClass) : null)}
                  className={`${selectClass} ${classReady ? "text-ink" : "border-trail/50 text-ink-muted"}`}
                  data-sticker-class
                >
                  <option value="">{hasClassColumn ? "Leave them out" : "Pick one"}</option>
                  {PLATE_CLASSES.map((option) => (
                    <option key={option} value={option}>
                      {PLATE_CLASS_LABELS[option]}
                    </option>
                  ))}
                </select>
                <Chevron />
              </div>
            </div>
          </div>
          <div className="-mx-5 mt-4 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[32rem] text-sm" data-sticker-columns>
              <thead>
                <tr className="border-y border-white/10 text-left text-xs text-ink-muted">
                  <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                    Column
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    For example
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                    Goes to
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {columns.map(({ label, examples }, column) => {
                  const field = mapping[column] ?? null;
                  const first = field ? (firstColumn.get(field) ?? column) : column;
                  return (
                    <tr key={column}>
                      <th scope="row" className="px-5 py-2 text-left font-medium break-words text-ink sm:px-6">
                        {label}
                      </th>
                      <td className="max-w-56 px-3 py-2 text-xs break-words text-ink-muted">{examples.join(" · ") || "—"}</td>
                      <td className="px-5 py-2 sm:px-6">
                        <div className="relative min-w-48">
                          <select
                            aria-label={`Where ${label} goes`}
                            value={field ?? ""}
                            disabled={running}
                            onChange={(event) => {
                              const next = (event.target.value || null) as StickerImportField | null;
                              setMapping((old) => {
                                const copy = [...old];
                                while (copy.length <= column) copy.push(null);
                                copy[column] = next;
                                return copy;
                              });
                            }}
                            className={`${selectClass} ${field ? "border-glow/40 text-ink" : "text-ink-muted"}`}
                          >
                            <option value="">Leave out</option>
                            {STICKER_IMPORT_FIELDS.map((option) => (
                              <option key={option} value={option}>
                                {STICKER_IMPORT_LABELS[option]}
                              </option>
                            ))}
                          </select>
                          <Chevron />
                        </div>
                        {first !== column && (
                          <p className="mt-1 text-xs text-trail">{columns[first]?.label ?? "Another column"} has this too: only that column is read.</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!hasRequired ? (
            <div className="mt-4">
              <Notice tone="trail">Pick the columns with the Sticker # and the Customer Name to import.</Notice>
            </div>
          ) : (
            !classReady && (
              <div className="mt-4">
                <Notice tone="trail">
                  This list has no Plate Classification column: pick the class for its rows above. A list of stickers and a list of plates can
                  each be imported with its own.
                </Notice>
              </div>
            )
          )}
        </section>
      )}

      {loaded && plan && hasRequired && classReady && (
        <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
          <h2 className="text-base font-semibold text-ink">3. Import</h2>
          <div aria-busy={planning} className={`mt-4 space-y-4 ${planning ? "opacity-60" : ""}`}>
            <p className="text-sm leading-6 text-ink" data-sticker-import-summary>
              {plural(plan.rowsRead, "row", "rows")} read: {plural(plan.stickers.length, "sticker", "stickers")}. A sticker already in the log is left
              as it is. Each customer is found on Customers by name{hasPhone ? " and phone number" : ""}; anyone who isn&apos;t there is added.
              {plateClass && (hasClassColumn ? ` Rows with no class are logged as ${PLATE_CLASS_LABELS[plateClass]}.` : ` Every row is logged as ${PLATE_CLASS_LABELS[plateClass]}.`)}
            </p>
            {plan.stickers.length > 0 && (
              <div className="-mx-5 overflow-x-auto sm:-mx-6">
                <table className="w-full min-w-[32rem] text-sm" data-sticker-preview>
                  <caption className="sr-only">The first stickers to be imported</caption>
                  <thead>
                    <tr className="border-y border-white/10 text-left text-xs text-ink-muted">
                      {STICKER_IMPORT_FIELDS.filter((field) => field !== "phone" || hasPhone).map((field) => (
                        <th key={field} scope="col" className="px-3 py-2 font-medium first:pl-5 sm:first:pl-6">
                          {STICKER_IMPORT_LABELS[field]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {plan.stickers.slice(0, 8).map((sticker) => (
                      <tr key={sticker.row}>
                        <td className="px-3 py-2 pl-5 font-mono break-words text-ink sm:pl-6">{sticker.stickerNumber}</td>
                        <td className="px-3 py-2 break-words text-ink">{sticker.customerName}</td>
                        {hasPhone && <td className="px-3 py-2 break-words text-ink">{sticker.phone ?? <span className="text-ink-muted">—</span>}</td>}
                        <td className="px-3 py-2 text-ink">{sticker.plateClass}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plan.stickers.length > 8 && <p className="mt-2 px-5 text-xs text-ink-muted sm:px-6">…and {plural(plan.stickers.length - 8, "more", "more")}.</p>}
              </div>
            )}
            <Notes notes={notes} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <button type="button" onClick={start} disabled={running || planning || plan.stickers.length === 0} className={primaryLinkClass} data-sticker-import-start>
              {running ? "Importing…" : planning ? "Updating…" : `Import ${plural(plan.stickers.length, "sticker", "stickers")}`}
            </button>
            {run?.state === "running" && (
              <div className="min-w-56 flex-1" role="status">
                <div role="progressbar" aria-label="Stickers saved" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.sent} className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-glow transition-[width]" style={{ width: `${run.total ? (run.sent / run.total) * 100 : 0}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-ink-muted">
                  Saved {run.sent.toLocaleString("en-US")} of {plural(run.total, "sticker", "stickers")}. Keep this tab open.
                </p>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Notes({ notes }: { notes: { row: number; message: string; skipped: boolean }[] }) {
  if (notes.length === 0) return null;
  const rows = new Set(notes.map((note) => note.row)).size;
  return (
    <details className="rounded-lg border border-trail/30 bg-trail/5 px-4 py-3 text-sm" data-sticker-import-notes>
      <summary className="cursor-pointer font-medium text-trail">{plural(rows, "row needs", "rows need")} a look</summary>
      <ul className="mt-2 space-y-1 text-ink">
        {[...notes]
          .sort((a, b) => a.row - b.row)
          .slice(0, 30)
          .map((note, index) => (
            <li key={index} className="flex gap-3">
              <span className="w-16 shrink-0 font-mono text-xs leading-5 text-ink-muted">Row {note.row}</span>
              <span className="min-w-0 break-words">{note.message}</span>
            </li>
          ))}
      </ul>
      <button type="button" onClick={() => download("sticker import notes.csv", reportCsv(notes))} className="mt-3 text-sm text-glow/90 hover:text-glow hover:underline">
        {notes.length > 30 ? `Download all ${notes.length.toLocaleString("en-US")} (CSV)` : "Download this list (CSV)"}
      </button>
    </details>
  );
}
