"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import { Badge, Notice } from "@/components/app/ui";
import { inputBaseClass, labelClass, primaryLinkClass, secondaryButtonClass } from "@/components/hud";
import { parseCsv } from "@/lib/csv";
import { detectDelimiter, readSpreadsheet, reportCsv, type Sheet } from "@/lib/customer-import-rules";
import {
  MAX_SUPPLIER_BATCH,
  SUPPLIER_FIELDS,
  SUPPLIER_FIELD_LABELS,
  findSupplierHeader,
  planSupplierImport,
  supplierColumns,
  type SupplierField,
  type SupplierImportOutcome,
  type SupplierImportRow,
} from "@/lib/supplier-rules";

import { importSuppliersAction } from "../actions";

// Importing a supplier list, in the admin's browser: a CSV or Excel file, or
// rows pasted from a spreadsheet. Each column is matched to a field by its
// heading (and can be changed), the preview shows what will be added and
// what's left out, and Import sends the suppliers in batches, matched on
// Supplier ID, so importing the list again only brings in what changed.

type Loaded = { name: string; sheets: Sheet[] };
type Run =
  | { state: "running"; sent: number; total: number; outcomes: SupplierImportOutcome[] }
  | { state: "done" | "stopped"; sent: number; total: number; outcomes: SupplierImportOutcome[]; error?: string };

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

export function SupplierImport() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pasted, setPasted] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<(SupplierField | null)[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const job = useRef<{ importId: string; name: string; batches: SupplierImportRow[][]; next: number; sent: number; outcomes: SupplierImportOutcome[] } | null>(null);
  const fileId = useId();
  const finished = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef<HTMLHeadingElement>(null);
  const startingOver = useRef(false);
  const done = useRef(false);

  const rows = useMemo(() => loaded?.sheets[sheetIndex]?.rows ?? [], [loaded, sheetIndex]);
  const plannedMapping = useDeferredValue(mapping);
  const plannedHeader = useDeferredValue(headerRow);
  const planning = plannedMapping !== mapping || plannedHeader !== headerRow;
  const plan = useMemo(() => (loaded ? planSupplierImport(rows, plannedHeader, plannedMapping) : null), [loaded, rows, plannedHeader, plannedMapping]);
  const running = run?.state === "running";
  const hasKey = mapping.includes("supplierId") && mapping.includes("supplierName");

  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);
  useEffect(() => {
    done.current = run?.state === "done";
    if (run && run.state !== "running") finished.current?.focus();
    else if (!run && startingOver.current) {
      startingOver.current = false;
      firstStep.current?.focus();
    }
  }, [run]);
  // Next keeps a visited page alive: coming back after an import finished
  // starts a new one. A stopped one stays, to carry on.
  useEffect(
    () => () => {
      if (done.current) startOver();
    },
    [],
  );

  function startOver() {
    job.current = null;
    setRun(null);
    setLoaded(null);
    setPasted("");
    setReadError(null);
  }

  function show(next: Loaded, index: number) {
    const sheetRows = next.sheets[index]?.rows ?? [];
    const at = Math.max(0, findSupplierHeader(sheetRows));
    setLoaded(next);
    setSheetIndex(index);
    setHeaderRow(at);
    setMapping(supplierColumns(sheetRows[at] ?? []));
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
      console.error("Couldn't read the supplier file", error);
      setReadError("That file couldn't be read. Check it opens in Excel, then try again.");
    } finally {
      setReading(false);
    }
  }

  function readPasted() {
    const text = pasted.replace(/\r\n?/g, "\n");
    if (!text.trim()) return;
    try {
      show({ name: "pasted rows", sheets: [{ name: "Pasted", rows: parseCsv(text, detectDelimiter(text)) }] }, 0);
    } catch {
      setLoaded(null);
      setRun(null);
      setReadError("Those rows couldn't be read. Copy them from the spreadsheet again, headings and all.");
    }
  }

  async function send() {
    const current = job.current;
    if (!current) return;
    setRun({ state: "running", sent: current.sent, total: plan?.suppliers.length ?? 0, outcomes: [...current.outcomes] });
    const total = current.batches.reduce((sum, batch) => sum + batch.length, 0);
    while (current.next < current.batches.length) {
      const batch = current.batches[current.next];
      const result = await importSuppliersAction({ importId: current.importId, fileName: current.name, suppliers: batch }).catch(() => ({ error: "The connection dropped." }));
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
    if (!plan || !loaded || running || planning || plan.suppliers.length === 0) return;
    const batches: SupplierImportRow[][] = [];
    for (let at = 0; at < plan.suppliers.length; at += MAX_SUPPLIER_BATCH) batches.push(plan.suppliers.slice(at, at + MAX_SUPPLIER_BATCH));
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
    const first = new Map<SupplierField, number>();
    mapping.forEach((field, column) => {
      if (field && !first.has(field)) first.set(field, column);
    });
    return first;
  }, [mapping]);

  const notes = useMemo(() => {
    const all = (plan?.notes ?? []).map((note) => ({ ...note, skipped: false }));
    for (const outcome of run?.outcomes ?? []) if (outcome.result === "failed") all.push({ row: outcome.row, message: `Left out: ${outcome.error}`, skipped: true });
    return all;
  }, [plan, run]);

  if (run && run.state !== "running") {
    const count = (result: SupplierImportOutcome["result"]) => run.outcomes.filter((outcome) => outcome.result === result).length;
    return (
      <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-supplier-import-finished={run.state}>
        <h2 ref={finished} tabIndex={-1} className="text-base font-semibold text-ink focus:outline-none">
          {run.state === "done" ? "Import finished" : "Import stopped"}
        </h2>
        {run.state === "stopped" && (
          <Notice tone="trail">
            Stopped after {run.sent.toLocaleString("en-US")} of {plural(run.total, "supplier", "suppliers")}: {run.error} Carry on sends the rest;
            nothing already saved is added twice.
          </Notice>
        )}
        <ul className="flex flex-wrap gap-2" data-supplier-import-result>
          <li>
            <Badge tone="glow">{plural(count("created"), "supplier added", "suppliers added")}</Badge>
          </li>
          <li>
            <Badge tone="glow">{plural(count("updated"), "updated", "updated")}</Badge>
          </li>
          <li>
            <Badge>{plural(count("unchanged"), "already as the file has it", "already as the file has them")}</Badge>
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
            <Link href="/admin/suppliers" className={primaryLinkClass}>
              View suppliers
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              startingOver.current = true;
              startOver();
            }}
            className="inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            Import another list
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
        <h2 ref={firstStep} tabIndex={-1} className="text-base font-semibold text-ink focus:outline-none">
          1. The list
        </h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <label
            htmlFor={fileId}
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/20 px-4 py-6 text-center transition hover:border-white/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40"
          >
            <span className="text-sm font-medium text-ink">{reading ? "Reading…" : loaded && loaded.name !== "pasted rows" ? `${loaded.name}: choose another` : "Choose a CSV or Excel file"}</span>
            <span className="text-xs text-ink-muted">With a headings row: {SUPPLIER_FIELDS.map((field) => SUPPLIER_FIELD_LABELS[field]).join(", ")}.</span>
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
              data-supplier-file
            />
          </label>
          <div>
            <label htmlFor="supplier-paste" className={labelClass}>
              Or paste the rows from Excel, headings and all
            </label>
            <textarea
              id="supplier-paste"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
              spellCheck={false}
              className={`mt-1.5 ${inputBaseClass} h-auto py-3 font-mono text-sm`}
              data-supplier-paste
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
                <label htmlFor="supplier-sheet" className={labelClass}>
                  Sheet
                </label>
                <div className="relative mt-1.5">
                  <select id="supplier-sheet" value={sheetIndex} disabled={running} onChange={(event) => show(loaded, Number(event.target.value))} className={selectClass}>
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
              <label htmlFor="supplier-header" className={labelClass}>
                Headings are on
              </label>
              <div className="relative mt-1.5">
                <select
                  id="supplier-header"
                  value={headerRow}
                  disabled={running}
                  onChange={(event) => {
                    const at = Number(event.target.value);
                    setHeaderRow(at);
                    setMapping(supplierColumns(rows[at] ?? []));
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
            <table className="w-full min-w-[32rem] text-sm" data-supplier-columns>
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
                              const next = (event.target.value || null) as SupplierField | null;
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
                            {SUPPLIER_FIELDS.map((option) => (
                              <option key={option} value={option}>
                                {SUPPLIER_FIELD_LABELS[option]}
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
          {!hasKey && (
            <div className="mt-4">
              <Notice tone="trail">Pick the columns with the Supplier ID and the Supplier Name to import.</Notice>
            </div>
          )}
        </section>
      )}

      {loaded && plan && hasKey && (
        <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
          <h2 className="text-base font-semibold text-ink">3. Import</h2>
          <div aria-busy={planning} className={`mt-4 space-y-4 ${planning ? "opacity-60" : ""}`}>
            <p className="text-sm leading-6 text-ink" data-supplier-import-summary>
              {plural(plan.rowsRead, "row", "rows")} read: {plural(plan.suppliers.length, "supplier", "suppliers")}. Suppliers already on file are
              found by Supplier ID and take the file&apos;s details; a blank cell leaves what&apos;s on file.
            </p>
            {plan.suppliers.length > 0 && (
              <div className="-mx-5 overflow-x-auto sm:-mx-6">
                <table className="w-full min-w-[36rem] text-sm" data-supplier-preview>
                  <caption className="sr-only">The first suppliers to be imported</caption>
                  <thead>
                    <tr className="border-y border-white/10 text-left text-xs text-ink-muted">
                      {SUPPLIER_FIELDS.map((field) => (
                        <th key={field} scope="col" className="px-3 py-2 font-medium first:pl-5 sm:first:pl-6">
                          {SUPPLIER_FIELD_LABELS[field]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {plan.suppliers.slice(0, 8).map((supplier) => (
                      <tr key={supplier.row}>
                        {SUPPLIER_FIELDS.map((field) => (
                          <td key={field} className="px-3 py-2 break-words text-ink first:pl-5 sm:first:pl-6">
                            {supplier[field] ?? <span className="text-ink-muted">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plan.suppliers.length > 8 && <p className="mt-2 px-5 text-xs text-ink-muted sm:px-6">…and {plural(plan.suppliers.length - 8, "more", "more")}.</p>}
              </div>
            )}
            <Notes notes={notes} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <button type="button" onClick={start} disabled={running || planning || plan.suppliers.length === 0} className={primaryLinkClass} data-supplier-import-start>
              {running ? "Importing…" : planning ? "Updating…" : `Import ${plural(plan.suppliers.length, "supplier", "suppliers")}`}
            </button>
            {run?.state === "running" && (
              <div className="min-w-56 flex-1" role="status">
                <div role="progressbar" aria-label="Suppliers saved" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.sent} className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-glow transition-[width]" style={{ width: `${run.total ? (run.sent / run.total) * 100 : 0}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-ink-muted">
                  Saved {run.sent.toLocaleString("en-US")} of {plural(run.total, "supplier", "suppliers")}. Keep this tab open.
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
    <details className="rounded-lg border border-trail/30 bg-trail/5 px-4 py-3 text-sm" data-supplier-import-notes>
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
      <button type="button" onClick={() => download("supplier import notes.csv", reportCsv(notes))} className="mt-3 text-sm text-glow/90 hover:text-glow hover:underline">
        {notes.length > 30 ? `Download all ${notes.length.toLocaleString("en-US")} (CSV)` : "Download this list (CSV)"}
      </button>
    </details>
  );
}
