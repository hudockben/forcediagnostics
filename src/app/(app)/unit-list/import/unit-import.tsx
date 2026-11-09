"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import { Badge, Notice } from "@/components/app/ui";
import { inputBaseClass, labelClass, primaryLinkClass, secondaryButtonClass } from "@/components/hud";
import { parseCsv } from "@/lib/csv";
import { pastedDelimiter, readSpreadsheet, reportCsv, type Sheet } from "@/lib/customer-import-rules";
import { formatDay, formatMoney } from "@/lib/nusr-rules";
import {
  MAX_UNIT_IMPORT_BATCH,
  UNIT_IMPORT_FIELDS,
  UNIT_IMPORT_LABELS,
  findUnitHeader,
  planUnitImport,
  unitImportColumns,
  unitsInWords,
  type UnitImportField,
  type UnitImportOutcome,
  type UnitImportRow,
} from "@/lib/unit-import-rules";
import { isPartialVin, unitName, vinParts } from "@/lib/unit-list-rules";

import { importStockUnitsAction } from "../actions";

// Importing the Unit List from the shop's spreadsheet, in the browser: a
// CSV or Excel file, or the rows pasted from it (Google Sheets copies
// cells with tabs). Each column is matched to a field by its heading (and
// can be changed); the count column with no heading is found by its 1s.
// The preview shows what will be added and what's left out, and Import
// sends the units in batches. A unit already on the list is left as it is,
// so importing the sheet again adds nothing new.

type Loaded = { name: string; sheets: Sheet[] };
// entries: what was sent, in order, as the outcomes are.
type Run =
  | { state: "running"; sent: number; total: number; entries: UnitImportRow[]; outcomes: UnitImportOutcome[] }
  | { state: "done" | "stopped"; sent: number; total: number; entries: UnitImportRow[]; outcomes: UnitImportOutcome[]; error?: string };

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

export function UnitImport({ today }: { today: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pasted, setPasted] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<(UnitImportField | null)[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const job = useRef<{ importId: string; name: string; batches: UnitImportRow[][]; next: number; sent: number; outcomes: UnitImportOutcome[] } | null>(null);
  const fileId = useId();
  const finished = useRef<HTMLHeadingElement>(null);

  const rows = useMemo(() => loaded?.sheets[sheetIndex]?.rows ?? [], [loaded, sheetIndex]);
  const plannedMapping = useDeferredValue(mapping);
  const plannedHeader = useDeferredValue(headerRow);
  const planning = plannedMapping !== mapping || plannedHeader !== headerRow;
  const plan = useMemo(() => (loaded ? planUnitImport(rows, plannedHeader, plannedMapping, { today }) : null), [loaded, rows, plannedHeader, plannedMapping, today]);
  const running = run?.state === "running";
  const hasVin = mapping.includes("vin");
  const hasModel = mapping.includes("model");
  const ready = hasVin && hasModel;

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
    const at = Math.max(0, findUnitHeader(sheetRows));
    setLoaded(next);
    setSheetIndex(index);
    setHeaderRow(at);
    setMapping(unitImportColumns(sheetRows, at));
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
      // The sheet with the headings on it, else the first with anything.
      const withHeadings = result.sheets.findIndex((sheet) => findUnitHeader(sheet.rows) >= 0);
      const first = withHeadings >= 0 ? withHeadings : Math.max(0, result.sheets.findIndex((sheet) => sheet.rows.some((row) => row.some((cell) => cell.trim()))));
      show({ name: file.name, sheets: result.sheets }, first);
    } catch (error) {
      console.error("Couldn't read the unit list file", error);
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
    const entries = current.batches.flat();
    setRun({ state: "running", sent: current.sent, total, entries, outcomes: [...current.outcomes] });
    while (current.next < current.batches.length) {
      const batch = current.batches[current.next];
      const units = batch.map((entry) => ({ row: entry.row, ...entry.fields }));
      const result = await importStockUnitsAction({ importId: current.importId, fileName: current.name, units }).catch(() => ({ error: "The connection dropped." }));
      if ("error" in result) {
        setRun({ state: "stopped", sent: current.sent, total, entries, outcomes: [...current.outcomes], error: result.error });
        return;
      }
      current.outcomes.push(...result.outcomes);
      current.sent += batch.length;
      current.next++;
      setRun({ state: "running", sent: current.sent, total, entries, outcomes: [...current.outcomes] });
    }
    job.current = null;
    setRun({ state: "done", sent: total, total, entries, outcomes: current.outcomes });
  }

  function start() {
    if (!plan || !loaded || running || planning || plan.units.length === 0) return;
    const batches: UnitImportRow[][] = [];
    for (let at = 0; at < plan.units.length; at += MAX_UNIT_IMPORT_BATCH) batches.push(plan.units.slice(at, at + MAX_UNIT_IMPORT_BATCH));
    job.current = { importId: crypto.randomUUID(), name: loaded.name, batches, next: 0, sent: 0, outcomes: [] };
    void send();
  }

  // Each column's heading and two examples.
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

  // The plan's notes, then what the server said about a unit it left out or
  // found on the list under another VIN.
  const notes = useMemo(() => {
    const all = (plan?.notes ?? []).map((note) => ({ ...note }));
    for (const outcome of run?.outcomes ?? []) {
      if (outcome.result === "failed") all.push({ row: outcome.row, message: `Left out: ${outcome.message}` });
      else if (outcome.message) all.push({ row: outcome.row, message: outcome.message });
    }
    return all;
  }, [plan, run]);

  if (run && run.state !== "running") {
    const count = (result: UnitImportOutcome["result"]) => run.outcomes.filter((outcome) => outcome.result === result).length;
    const added = run.outcomes.flatMap((outcome, index) => (outcome.result === "added" && run.entries[index] ? [run.entries[index]] : []));
    return (
      <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-unit-import-finished={run.state}>
        <h2 ref={finished} tabIndex={-1} className="text-base font-semibold text-ink focus:outline-none">
          {run.state === "done" ? "Import finished" : "Import stopped"}
        </h2>
        {run.state === "stopped" && (
          <Notice tone="trail">
            Stopped after {run.sent.toLocaleString("en-US")} of {run.total.toLocaleString("en-US")}: {run.error} Carry on sends the rest; nothing already saved is added twice.
          </Notice>
        )}
        <ul className="flex flex-wrap gap-2" data-unit-import-result>
          <li>
            <Badge tone="glow">{added.length > 0 ? `${plural(added.length, "unit", "units")} added` : "Nothing new added"}</Badge>
          </li>
          <li>
            <Badge>{plural(count("already"), "already on the list", "already on the list")}</Badge>
          </li>
          {count("failed") > 0 && (
            <li>
              <Badge tone="trail">{plural(count("failed"), "left out", "left out")}</Badge>
            </li>
          )}
        </ul>
        {added.some((entry) => isPartialVin(entry.unit.vin)) && (
          <p className="text-sm leading-6 text-ink-muted">
            The units with only the end of their VIN are matched by it: a sale of the whole VIN in the NUSR marks one sold, and dropping its whole goods invoice on the Unit List
            fills in the rest of its VIN.
          </p>
        )}
        <Notes notes={notes} />
        <div className="flex flex-wrap gap-3">
          {run.state === "stopped" ? (
            <button type="button" onClick={() => void send()} className={primaryLinkClass}>
              Carry on
            </button>
          ) : (
            <Link href="/unit-list" className={primaryLinkClass} data-unit-import-view>
              View the Unit List
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
        <h2 className="text-base font-semibold text-ink">1. The spreadsheet</h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <label
            htmlFor={fileId}
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/20 px-4 py-6 text-center transition hover:border-white/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40"
          >
            <span className="text-sm font-medium text-ink">{reading ? "Reading…" : loaded && loaded.name !== "pasted rows" ? `${loaded.name}: choose another` : "Choose a CSV or Excel file"}</span>
            <span className="text-xs text-ink-muted">
              With a headings row: Model, VIN, Received, Cost, List. From Google Sheets: File &gt; Download &gt; Microsoft Excel (.xlsx) or Comma-separated values (.csv).
            </span>
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
              data-unit-import-file
            />
          </label>
          <div>
            <label htmlFor="unit-import-paste" className={labelClass}>
              Or paste the rows from the sheet, headings and all
            </label>
            <textarea
              id="unit-import-paste"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
              spellCheck={false}
              className={`mt-1.5 ${inputBaseClass} h-auto py-3 font-mono text-sm`}
              data-unit-import-paste
            />
            <button type="button" onClick={readPasted} disabled={!pasted.trim() || running} className={`${secondaryButtonClass} mt-2`} data-unit-import-use-pasted>
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
                <label htmlFor="unit-import-sheet" className={labelClass}>
                  Sheet
                </label>
                <div className="relative mt-1.5">
                  <select id="unit-import-sheet" value={sheetIndex} disabled={running} onChange={(event) => show(loaded, Number(event.target.value))} className={selectClass}>
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
              <label htmlFor="unit-import-header" className={labelClass}>
                Headings are on
              </label>
              <div className="relative mt-1.5">
                <select
                  id="unit-import-header"
                  value={headerRow}
                  disabled={running}
                  onChange={(event) => {
                    const at = Number(event.target.value);
                    setHeaderRow(at);
                    setMapping(unitImportColumns(rows, at));
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
          </div>
          <div className="-mx-5 mt-4 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[32rem] text-sm" data-unit-import-columns>
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
                  const taken = field ? mapping.findIndex((other) => other === field) : -1;
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
                              const next = (event.target.value || null) as UnitImportField | null;
                              setMapping((old) => {
                                const copy = [...old];
                                while (copy.length <= column) copy.push(null);
                                // A field goes in one column: picking it here
                                // takes it from another.
                                for (let at = 0; at < copy.length; at++) if (next && copy[at] === next) copy[at] = null;
                                copy[column] = next;
                                return copy;
                              });
                            }}
                            className={`${selectClass} ${field ? "border-glow/40 text-ink" : "text-ink-muted"}`}
                            data-unit-import-column={label}
                          >
                            <option value="">Leave out</option>
                            {UNIT_IMPORT_FIELDS.map((option) => (
                              <option key={option} value={option}>
                                {UNIT_IMPORT_LABELS[option]}
                              </option>
                            ))}
                          </select>
                          <Chevron />
                        </div>
                        {field === "count" && taken === column && <p className="mt-1 text-xs text-ink-muted">A row with 0 here isn&apos;t counted on the sheet, and is left out.</p>}
                        {field === "model" && !mapping.includes("unitYear") && <p className="mt-1 text-xs text-ink-muted">The year at its front (2027 Rngr…) is the model year.</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!hasVin ? (
            <div className="mt-4">
              <Notice tone="trail">Pick the VIN column: the units are known by it (the last 7 of the VIN is enough).</Notice>
            </div>
          ) : (
            !hasModel && (
              <div className="mt-4">
                <Notice tone="trail">Pick the Model column.</Notice>
              </div>
            )
          )}
        </section>
      )}

      {loaded && plan && ready && (
        <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
          <h2 className="text-base font-semibold text-ink">3. Import</h2>
          <div aria-busy={planning} className={`mt-4 space-y-4 ${planning ? "opacity-60" : ""}`}>
            <p className="text-sm leading-6 text-ink" data-unit-import-summary>
              {plural(plan.rowsRead, "row", "rows")} read: {plan.units.length > 0 ? `${unitsInWords(plan.units)} to add` : "no units to add"}. A unit already on the list is left as it is.
              {plan.units.some((entry) => isPartialVin(entry.unit.vin)) &&
                " A VIN's end is matched by the whole VIN: a sale in the NUSR marks the unit sold, and its invoice dropped on the Unit List fills in the rest."}
            </p>
            {plan.units.length > 0 && <Preview units={plan.units} />}
            <Notes notes={notes} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <button type="button" onClick={start} disabled={running || planning || plan.units.length === 0} className={primaryLinkClass} data-unit-import-start>
              {running ? "Importing…" : planning ? "Updating…" : `Import ${plural(plan.units.length, "unit", "units")}`}
            </button>
            {run?.state === "running" && (
              <div className="min-w-56 flex-1" role="status">
                <div role="progressbar" aria-label="Units saved" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.sent} className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-glow transition-[width]" style={{ width: `${run.total ? (run.sent / run.total) * 100 : 0}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-ink-muted">
                  Saved {run.sent.toLocaleString("en-US")} of {run.total.toLocaleString("en-US")}. Keep this tab open.
                </p>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// The first units to be imported, as the Unit List will show them.
function Preview({ units }: { units: UnitImportRow[] }) {
  const shown = units.slice(0, 8);
  return (
    <div className="-mx-5 overflow-x-auto sm:-mx-6">
      <table className="w-full min-w-[40rem] text-sm" data-unit-import-preview>
        <caption className="sr-only">The first units to be imported</caption>
        <thead>
          <tr className="border-y border-white/10 text-left text-xs text-ink-muted">
            <th scope="col" className="px-3 py-2 pl-5 font-medium sm:pl-6">
              Model
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              VIN
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Received
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Cost
            </th>
            <th scope="col" className="px-3 py-2 pr-5 text-right font-medium sm:pr-6">
              List
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {shown.map(({ row, unit }) => {
            const [head, tail] = vinParts(unit.vin);
            return (
              <tr key={row}>
                <td className="px-3 py-2 pl-5 break-words text-ink sm:pl-6">
                  {unitName(unit)}
                  {unit.soldOn && <span className="ml-2 text-xs text-ink-muted">sold {formatDay(unit.soldOn)}</span>}
                </td>
                <td className="px-3 py-2 font-mono whitespace-nowrap">
                  <span className="text-ink-muted">{isPartialVin(unit.vin) ? "…" : head}</span>
                  <span className="font-semibold text-ink">{tail}</span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-ink">{formatDay(unit.receivedOn)}</td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-ink">{unit.cost === null ? <span className="text-ink-muted">—</span> : formatMoney(unit.cost)}</td>
                <td className="px-3 py-2 pr-5 text-right font-mono whitespace-nowrap text-ink sm:pr-6">
                  {unit.listPrice === null ? <span className="text-ink-muted">—</span> : formatMoney(unit.listPrice)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {units.length > shown.length && <p className="mt-2 px-5 text-xs text-ink-muted sm:px-6">…and {plural(units.length - shown.length, "more", "more")}.</p>}
    </div>
  );
}

function Notes({ notes }: { notes: { row: number; message: string }[] }) {
  if (notes.length === 0) return null;
  const rows = new Set(notes.map((note) => note.row)).size;
  return (
    <details className="rounded-lg border border-trail/30 bg-trail/5 px-4 py-3 text-sm" data-unit-import-notes>
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
      <button type="button" onClick={() => download("unit list import notes.csv", reportCsv(notes.map((note) => ({ ...note, skipped: false }))))} className="mt-3 text-sm text-glow/90 hover:text-glow hover:underline">
        {notes.length > 30 ? `Download all ${notes.length.toLocaleString("en-US")} (CSV)` : "Download this list (CSV)"}
      </button>
    </details>
  );
}
