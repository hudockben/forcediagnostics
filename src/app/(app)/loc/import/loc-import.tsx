"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import { Badge, Notice } from "@/components/app/ui";
import { inputBaseClass, labelClass, primaryLinkClass, secondaryButtonClass } from "@/components/hud";
import { parseCsv } from "@/lib/csv";
import { pastedDelimiter, readSpreadsheet, reportCsv, type Sheet } from "@/lib/customer-import-rules";
import {
  LOC_IMPORT_FIELDS,
  LOC_IMPORT_LABELS,
  MAX_LOC_IMPORT_BATCH,
  findLocHeader,
  importedLabel,
  locColumns,
  planLocImport,
  type LocImportField,
  type LocImportNote,
  type LocImportOutcome,
  type LocImportRow,
} from "@/lib/loc-import-rules";
import { LOC_SECTION_LABELS, type LocSection } from "@/lib/loc-rules";
import { formatDay, formatMoney } from "@/lib/nusr-rules";

import { importLocUnitsAction } from "../actions";

// Importing units onto the LOC, in the browser: the shop's LOC sheet (or
// the tab's own download, or the lender's list of units on the line) as a
// file, or rows pasted from one. Each column is matched to a field by its
// heading (and can be changed); the sheet's WE OWN and "we owe on LOC"
// marks put each unit in its section. The preview shows what will be added
// and what's noted, and Import sends them in batches. A unit whose stock #
// is on the LOC already is left as it is, so the same file again, or the
// lender's next list, adds only what's new.

type Loaded = { name: string; sheets: Sheet[] };
type Run = {
  state: "running" | "done" | "stopped";
  sent: number;
  total: number;
  units: LocImportRow[];
  outcomes: LocImportOutcome[];
  error?: string;
};

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

function Notes({ notes }: { notes: LocImportNote[] }) {
  if (notes.length === 0) return null;
  const sorted = [...notes].sort((a, b) => a.row - b.row);
  return (
    <div className="space-y-2" data-loc-import-notes>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{plural(notes.length, "row to look at", "rows to look at")}</h3>
        <button type="button" onClick={() => download("LOC import notes.csv", reportCsv(sorted))} className="min-h-11 text-sm font-medium text-glow/90 hover:text-glow hover:underline">
          Download as CSV
        </button>
      </div>
      <ul className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-forest-950/40 p-3 text-sm">
        {sorted.slice(0, 200).map((note, index) => (
          <li key={`${note.row}-${index}`} className={note.skipped ? "text-trail" : "text-ink"}>
            <span className="font-mono text-xs text-ink-muted">Row {note.row}:</span> {note.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LocImport() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pasted, setPasted] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<(LocImportField | null)[]>([]);
  // Where units go before the sheet marks a section: all of a lender's
  // list is on the LOC.
  const [section, setSection] = useState<LocSection>("loc");
  const [run, setRun] = useState<Run | null>(null);
  const job = useRef<{ importId: string; name: string; batches: LocImportRow[][]; next: number; sent: number; outcomes: LocImportOutcome[] } | null>(null);
  const fileId = useId();
  const finished = useRef<HTMLHeadingElement>(null);

  const rows = useMemo(() => loaded?.sheets[sheetIndex]?.rows ?? [], [loaded, sheetIndex]);
  const plannedMapping = useDeferredValue(mapping);
  const plan = useMemo(() => (loaded ? planLocImport(rows, headerRow, plannedMapping, { section }) : null), [loaded, rows, headerRow, plannedMapping, section]);
  const running = run?.state === "running";
  const ready = mapping.includes("model") && mapping.includes("cost");

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
    const at = Math.max(0, findLocHeader(sheetRows));
    setLoaded(next);
    setSheetIndex(index);
    setHeaderRow(at);
    setMapping(locColumns(sheetRows[at] ?? []));
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
      // The sheet with the LOC's headings, or the first with anything on it.
      const withHeadings = result.sheets.findIndex((sheet) => findLocHeader(sheet.rows) >= 0);
      const first = withHeadings >= 0 ? withHeadings : Math.max(0, result.sheets.findIndex((sheet) => sheet.rows.some((row) => row.some((cell) => cell.trim()))));
      show({ name: file.name, sheets: result.sheets }, first);
    } catch (error) {
      console.error("Couldn't read the LOC file", error);
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
    const units = current.batches.flat();
    const total = units.length;
    setRun({ state: "running", sent: current.sent, total, units, outcomes: [...current.outcomes] });
    while (current.next < current.batches.length) {
      const batch = current.batches[current.next];
      const result = await importLocUnitsAction({ importId: current.importId, fileName: current.name, units: batch }).catch(() => ({ error: "The connection dropped." }));
      if ("error" in result) {
        setRun({ state: "stopped", sent: current.sent, total, units, outcomes: [...current.outcomes], error: result.error });
        return;
      }
      current.outcomes.push(...result.outcomes);
      current.sent += batch.length;
      current.next++;
      setRun({ state: "running", sent: current.sent, total, units, outcomes: [...current.outcomes] });
    }
    job.current = null;
    setRun({ state: "done", sent: total, total, units, outcomes: current.outcomes });
  }

  function start() {
    if (!plan || !loaded || running || plan.units.length === 0) return;
    const batches: LocImportRow[][] = [];
    for (let at = 0; at < plan.units.length; at += MAX_LOC_IMPORT_BATCH) batches.push(plan.units.slice(at, at + MAX_LOC_IMPORT_BATCH));
    job.current = { importId: crypto.randomUUID(), name: loaded.name, batches, next: 0, sent: 0, outcomes: [] };
    void send();
  }

  // Each column's heading and two examples.
  const columns = useMemo(() => {
    const width = Math.max(rows[headerRow]?.length ?? 0, ...rows.slice(headerRow + 1, headerRow + 31).map((row) => row.length));
    return Array.from({ length: width }, (_, column) => {
      const examples: string[] = [];
      for (let index = headerRow + 1; index < rows.length && examples.length < 2; index++) {
        const value = rows[index][column]?.trim();
        if (value) examples.push(value.length > 36 ? `${value.slice(0, 36)}…` : value);
      }
      return { label: rows[headerRow]?.[column]?.trim() || `Column ${columnLetter(column)}`, examples };
    });
  }, [rows, headerRow]);

  // The plan's notes, then what the server left out.
  const notes = useMemo(() => {
    const all = [...(plan?.notes ?? [])];
    run?.outcomes.forEach((outcome) => {
      if (outcome.result === "failed") all.push({ row: outcome.row, message: `Left out: ${outcome.error ?? "it couldn't be saved"}`, skipped: true });
    });
    return all;
  }, [plan, run]);

  if (run && run.state !== "running") {
    const count = (result: LocImportOutcome["result"]) => run.outcomes.filter((outcome) => outcome.result === result).length;
    const added = count("added");
    return (
      <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-loc-import-finished={run.state}>
        <h2 ref={finished} tabIndex={-1} className="text-base font-semibold text-ink focus:outline-none">
          {run.state === "done" ? "Import finished" : "Import stopped"}
        </h2>
        {run.state === "stopped" && (
          <Notice tone="trail">
            Stopped after {run.sent.toLocaleString("en-US")} of {run.total.toLocaleString("en-US")}: {run.error} Carry on sends the rest; nothing already saved is added twice.
          </Notice>
        )}
        <ul className="flex flex-wrap gap-2" data-loc-import-result>
          <li>
            <Badge tone="glow">{added > 0 ? `${plural(added, "unit", "units")} added` : "Nothing new added"}</Badge>
          </li>
          <li>
            <Badge>{plural(count("already"), "already on the LOC", "already on the LOC")}</Badge>
          </li>
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
            <Link href={`/loc?imported=${added}`} className={primaryLinkClass}>
              View the LOC
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
        <h2 className="text-base font-semibold text-ink">1. The sheet</h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <label
            htmlFor={fileId}
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/20 px-4 py-6 text-center transition hover:border-white/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40"
          >
            <span className="text-sm font-medium text-ink">{reading ? "Reading…" : loaded && loaded.name !== "pasted rows" ? `${loaded.name}: choose another` : "Choose the LOC workbook (or a CSV)"}</span>
            <span className="text-xs text-ink-muted">With a headings row: Model, Stock #, Free Floor Ends and Cost, as the LOC sheet has them; a VIN, Date in or Notes column comes in too.</span>
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
              data-loc-file
            />
          </label>
          <div>
            <label htmlFor="loc-paste" className={labelClass}>
              Or paste the rows from Excel, headings and all
            </label>
            <textarea
              id="loc-paste"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
              spellCheck={false}
              className={`mt-1.5 ${inputBaseClass} h-auto py-3 font-mono text-sm`}
              data-loc-paste
            />
            <button type="button" onClick={readPasted} disabled={!pasted.trim() || running} className={`${secondaryButtonClass} mt-2`}>
              Read the pasted rows
            </button>
          </div>
        </div>
        {readError && (
          <div className="mt-4">
            <Notice tone="trail">{readError}</Notice>
          </div>
        )}
      </section>

      {loaded && plan && (
        <>
          <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-loc-import-columns>
            <h2 className="text-base font-semibold text-ink">2. The columns</h2>
            <div className="mt-4 flex flex-wrap gap-4">
              {loaded.sheets.length > 1 && (
                <div className="min-w-48">
                  <label htmlFor="loc-sheet" className={labelClass}>
                    Sheet
                  </label>
                  <div className="relative mt-1.5">
                    <select id="loc-sheet" value={sheetIndex} onChange={(event) => show(loaded, Number(event.target.value))} className={selectClass}>
                      {loaded.sheets.map((sheet, index) => (
                        <option key={`${sheet.name}-${index}`} value={index}>
                          {sheet.name}
                          {sheet.hidden ? " (hidden)" : ""}
                        </option>
                      ))}
                    </select>
                    <Chevron />
                  </div>
                </div>
              )}
              <div className="min-w-48">
                <label htmlFor="loc-header" className={labelClass}>
                  Headings row
                </label>
                <div className="relative mt-1.5">
                  <select
                    id="loc-header"
                    value={headerRow}
                    onChange={(event) => {
                      const at = Number(event.target.value);
                      setHeaderRow(at);
                      setMapping(locColumns(rows[at] ?? []));
                    }}
                    className={selectClass}
                  >
                    {rows.slice(0, 10).map((row, index) => (
                      <option key={index} value={index}>
                        Row {index + 1}: {row.filter(Boolean).slice(0, 4).join(", ").slice(0, 60) || "(blank)"}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </div>
              <div className="min-w-56">
                <label htmlFor="loc-section" className={labelClass}>
                  Units above any WE OWN or LOC mark
                </label>
                <div className="relative mt-1.5">
                  <select id="loc-section" value={section} onChange={(event) => setSection(event.target.value === "owned" ? "owned" : "loc")} className={selectClass} data-loc-import-section>
                    <option value="loc">Go on the LOC (a lender&apos;s list is all on it)</option>
                    <option value="owned">Are ours</option>
                  </select>
                  <Chevron />
                </div>
              </div>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {columns.map((column, index) => (
                <div key={index} className="rounded-lg border border-white/10 p-3">
                  <label htmlFor={`loc-column-${index}`} className="block text-sm font-medium text-ink">
                    {column.label}
                  </label>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">{column.examples.join(" · ") || "Nothing under it"}</p>
                  <div className="relative mt-2">
                    <select
                      id={`loc-column-${index}`}
                      value={mapping[index] ?? ""}
                      onChange={(event) => {
                        const value = event.target.value as LocImportField | "";
                        setMapping((old) => {
                          const next = [...old];
                          while (next.length <= index) next.push(null);
                          next[index] = value || null;
                          return next;
                        });
                      }}
                      className={selectClass}
                      data-loc-column={index}
                    >
                      <option value="">Leave out</option>
                      {LOC_IMPORT_FIELDS.map((field) => (
                        <option key={field} value={field}>
                          {LOC_IMPORT_LABELS[field]}
                        </option>
                      ))}
                    </select>
                    <Chevron />
                  </div>
                  {mapping[index] && mapping.indexOf(mapping[index]) !== index && <p className="mt-1 text-xs text-trail">Another column has this already: only the first is read.</p>}
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-loc-import-preview>
            <h2 className="text-base font-semibold text-ink">3. What comes in</h2>
            {!ready ? (
              <Notice tone="trail">Pick the Model and Cost columns: a unit needs both.</Notice>
            ) : (
              <>
                <dl className="grid gap-4 sm:grid-cols-3">
                  {(["owned", "loc"] as const).map((each) => (
                    <div key={each}>
                      <dt className="text-xs text-ink-muted">{LOC_SECTION_LABELS[each]}</dt>
                      <dd className="mt-1 font-mono text-lg text-ink tabular-nums" data-loc-import-total={each}>
                        {formatMoney(plan.sections[each].cost)}
                      </dd>
                      <dd className="text-xs text-ink-muted">{plural(plan.sections[each].units, "unit", "units")}</dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-xs text-ink-muted">Grand total</dt>
                    <dd className="mt-1 font-mono text-lg text-ink tabular-nums">{formatMoney(plan.sections.owned.cost + plan.sections.loc.cost)}</dd>
                    <dd className="text-xs text-ink-muted">{plural(plan.units.length, "unit", "units")}</dd>
                  </div>
                </dl>
                {plan.units.length > 0 && (
                  <div className="-mx-5 overflow-x-auto border-y border-white/10 sm:-mx-6">
                    <table className="w-full min-w-[40rem] text-sm">
                      <thead>
                        <tr className="border-b border-white/10 text-left text-xs text-ink-muted">
                          <th scope="col" className="py-2 pr-3 pl-5 font-medium sm:pl-6">
                            Row
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Unit
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            Free Floor Ends
                          </th>
                          <th scope="col" className="px-3 py-2 text-right font-medium">
                            Cost
                          </th>
                          <th scope="col" className="py-2 pr-5 pl-3 font-medium sm:pr-6">
                            Goes
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/10">
                        {plan.units.slice(0, 12).map((unit) => (
                          <tr key={unit.row}>
                            <td className="py-2 pr-3 pl-5 font-mono text-xs text-ink-muted sm:pl-6">{unit.row}</td>
                            <td className="px-3 py-2 text-ink">{importedLabel(unit)}</td>
                            <td className="px-3 py-2 text-ink">{formatDay(unit.freeFloorEnds)}</td>
                            <td className="px-3 py-2 text-right font-mono text-ink tabular-nums">{formatMoney(unit.cost)}</td>
                            <td className="py-2 pr-5 pl-3 text-ink-muted sm:pr-6">{unit.onLoc ? LOC_SECTION_LABELS.loc : LOC_SECTION_LABELS.owned}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {plan.units.length > 12 && <p className="text-xs text-ink-muted">And {plural(plan.units.length - 12, "more unit", "more units")}.</p>}
                <Notes notes={notes} />
                <p className="text-sm text-ink-muted">A unit whose stock # (or VIN) is on the LOC already is left as it is: importing the same sheet again adds nothing.</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={start} disabled={running || plan.units.length === 0} className={`${primaryLinkClass} disabled:opacity-60`} data-loc-import-start>
                    {running && run ? `Importing… ${run.sent.toLocaleString("en-US")} of ${run.total.toLocaleString("en-US")}` : `Import ${plural(plan.units.length, "unit", "units")}`}
                  </button>
                  {running && run && <progress value={run.sent} max={run.total} className="h-2 w-48 accent-glow" aria-label="Import progress" />}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
