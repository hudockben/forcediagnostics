"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { Badge, Notice } from "@/components/app/ui";
import { inputBaseClass, labelClass, primaryLinkClass } from "@/components/hud";
import {
  CUSTOMER_IMPORT_FIELDS,
  HEADER_SEARCH_ROWS,
  IMPORT_FIELD_LABELS,
  MAX_UNITS_PER_ROW,
  TEMPLATE_CSV,
  VEHICLE_IMPORT_FIELDS,
  findHeaderRow,
  guessMapping,
  importBatches,
  isVehicleField,
  planImport,
  readSpreadsheet,
  reportCsv,
  targetKey,
  type ColumnTarget,
  type ImportField,
  type ImportNote,
  type ImportOutcome,
  type Sheet,
} from "@/lib/customer-import-rules";
import { RELATION_LABELS, VEHICLE_RELATIONS, addressLines, type VehicleRelation } from "@/lib/customer-rules";

import { importCustomersAction } from "../actions";

// The import, in the admin's browser: the file is read here (nothing is
// sent until Import is pressed), each column is matched to a field by its
// heading (and can be changed), and the preview shows what will be added
// and what will be left out, by row. Import sends the customers in batches
// (src/lib/customer-import-rules.ts), one after another, and the report at
// the end says what happened to every row that needs a look.

type Loaded = { fileName: string; sheets: Sheet[] };

type Run =
  | { state: "running"; sent: number; total: number; outcomes: ImportOutcome[] }
  | { state: "done"; total: number; outcomes: ImportOutcome[] }
  | { state: "stopped"; sent: number; total: number; outcomes: ImportOutcome[]; error: string };

const selectClass = `${inputBaseClass} h-11 appearance-none pr-9 text-sm`;
const smallButtonClass =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// "A", "B", … "AA", as a spreadsheet names its columns.
function columnLetter(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function Chevron() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 fill-none stroke-ink-muted"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 8 5 5 5-5" />
    </svg>
  );
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

export function CustomerImport() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<(ColumnTarget | null)[]>([]);
  const [defaultRelation, setDefaultRelation] = useState<VehicleRelation>("bought");
  const [run, setRun] = useState<Run | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const fileId = useId();

  const sheet = loaded?.sheets[sheetIndex] ?? null;
  const rows = useMemo(() => sheet?.rows ?? [], [sheet]);
  const plan = useMemo(
    () => (sheet ? planImport(rows, { headerRow, mapping, defaultRelation }) : null),
    [sheet, rows, headerRow, mapping, defaultRelation],
  );
  const hasName = mapping.some((target) => target && ["name", "firstName", "lastName"].includes(target.field));
  const mapsVehicles = mapping.some((target) => target && isVehicleField(target.field) && target.field !== "relation");
  const running = run?.state === "running";

  // Closing the tab mid-import loses the batches not yet sent.
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  // A sheet's headings and what each column goes to, worked out again.
  function showSheet(sheets: Sheet[], index: number, header?: number) {
    const sheetRows = sheets[index]?.rows ?? [];
    const at = header ?? findHeaderRow(sheetRows);
    setSheetIndex(index);
    setHeaderRow(at);
    setMapping(guessMapping(sheetRows[at] ?? []));
  }

  async function choose(file: File | undefined) {
    if (!file || running) return;
    setReading(true);
    setReadError(null);
    setRun(null);
    try {
      const result = await readSpreadsheet(file.name, new Uint8Array(await file.arrayBuffer()));
      if ("error" in result) {
        setLoaded(null);
        setReadError(result.error);
        return;
      }
      setLoaded({ fileName: file.name, sheets: result.sheets });
      // The first sheet with anything on it.
      const first = Math.max(0, result.sheets.findIndex((s) => s.rows.some((row) => row.some((cell) => cell.trim()))));
      showSheet(result.sheets, first);
    } catch (error) {
      console.error("Couldn't read the import file", error);
      setLoaded(null);
      setReadError("That file couldn't be read. Check it opens in Excel, then try again.");
    } finally {
      setReading(false);
      if (input.current) input.current.value = "";
    }
  }

  // A column's field (and unit); a field (or unit's field) can only come
  // from one column, so another column that had it is left out.
  function setColumn(column: number, target: ColumnTarget | null) {
    setMapping((old) => {
      const next = [...old];
      while (next.length <= column) next.push(null);
      return next.map((current, index) =>
        index === column ? target : target && current && targetKey(current) === targetKey(target) ? null : current,
      );
    });
  }

  async function start() {
    if (!plan || !loaded || running) return;
    const batches = importBatches(plan.customers);
    const importId = crypto.randomUUID();
    const total = plan.customers.length;
    let sent = 0;
    const outcomes: ImportOutcome[] = [];
    setRun({ state: "running", sent, total, outcomes });
    for (const batch of batches) {
      const result = await importCustomersAction({ importId, fileName: loaded.fileName, customers: batch }).catch(() => ({
        error: "The connection dropped.",
      }));
      if ("error" in result) {
        setRun({ state: "stopped", sent, total, outcomes, error: result.error });
        return;
      }
      outcomes.push(...result.outcomes);
      sent += batch.length;
      setRun({ state: "running", sent, total, outcomes: [...outcomes] });
    }
    setRun({ state: "done", total, outcomes });
  }

  function reset() {
    setLoaded(null);
    setRun(null);
    setReadError(null);
    setMapping([]);
  }

  // Each column's heading and two examples of what's in it, from the rows
  // under the headings (worked out once per sheet, not on every render).
  const columns = useMemo(() => {
    const width = Math.max(rows[headerRow]?.length ?? 0, ...rows.slice(headerRow + 1, headerRow + 21).map((row) => row.length));
    return Array.from({ length: width }, (_, column) => {
      const examples: string[] = [];
      for (let index = headerRow + 1; index < rows.length && examples.length < 2; index++) {
        const value = rows[index][column]?.trim();
        if (value) examples.push(value.length > 40 ? `${value.slice(0, 40)}…` : value);
      }
      const heading = rows[headerRow]?.[column]?.trim() ?? "";
      return { label: heading || `Column ${columnLetter(column)}`, examples };
    });
  }, [rows, headerRow]);

  // Every row's notes: the plan's, then the server's.
  const notes: ImportNote[] = useMemo(() => {
    const all = [...(plan?.notes ?? [])];
    for (const outcome of run?.outcomes ?? []) {
      if (outcome.result === "failed") all.push({ row: outcome.rows[0] ?? 0, message: `Left out: ${outcome.error}`, skipped: true });
      if (outcome.note) all.push({ row: outcome.rows[0] ?? 0, message: outcome.note, skipped: false });
    }
    return all;
  }, [plan, run]);

  if (run && run.state !== "running") {
    return <Finished run={run} notes={notes} fileName={loaded?.fileName ?? "import"} onAgain={reset} />;
  }


  return (
    <div className="space-y-6">
      <Section
        title="1. Choose the file"
        aside={
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`}
            download="customers-template.csv"
            className="text-sm text-glow/90 hover:text-glow hover:underline"
          >
            Download a template
          </a>
        }
      >
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
            {reading ? "Reading…" : loaded ? `${loaded.fileName}: choose another` : "Choose a CSV or Excel file, or drop it here"}
          </span>
          <span className="text-xs text-ink-muted">.csv or .xlsx, up to 20 MB. The first row of headings names the columns.</span>
          <input
            ref={input}
            id={fileId}
            type="file"
            accept=".csv,.txt,.tsv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={reading || running}
            onChange={(event) => void choose(event.target.files?.[0])}
            className="sr-only"
            data-import-file
          />
        </label>
        {readError && (
          <div className="mt-3">
            <Notice tone="trail">{readError}</Notice>
          </div>
        )}
      </Section>

      {loaded && sheet && (
        <Section title="2. Check the columns">
          <div className="flex flex-wrap gap-4">
            {loaded.sheets.length > 1 && (
              <div className="min-w-48">
                <label htmlFor="import-sheet" className={labelClass}>
                  Sheet
                </label>
                <div className="relative mt-1.5">
                  <select
                    id="import-sheet"
                    value={sheetIndex}
                    disabled={running}
                    onChange={(event) => showSheet(loaded.sheets, Number(event.target.value))}
                    className={selectClass}
                  >
                    {loaded.sheets.map((s, index) => (
                      <option key={`${s.name}-${index}`} value={index}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </div>
            )}
            <div className="min-w-40">
              <label htmlFor="import-header" className={labelClass}>
                Headings are on
              </label>
              <div className="relative mt-1.5">
                <select
                  id="import-header"
                  value={headerRow}
                  disabled={running}
                  onChange={(event) => showSheet(loaded.sheets, sheetIndex, Number(event.target.value))}
                  className={selectClass}
                >
                  {Array.from({ length: Math.min(HEADER_SEARCH_ROWS, Math.max(1, rows.length)) }, (_, index) => (
                    <option key={index} value={index}>
                      Row {index + 1}
                    </option>
                  ))}
                </select>
                <Chevron />
              </div>
            </div>
            {mapsVehicles && (
              <div className="min-w-56">
                <label htmlFor="import-relation" className={labelClass}>
                  Vehicles with no deal type are
                </label>
                <div className="relative mt-1.5">
                  <select
                    id="import-relation"
                    value={defaultRelation}
                    disabled={running}
                    onChange={(event) => setDefaultRelation(event.target.value as VehicleRelation)}
                    className={selectClass}
                  >
                    {VEHICLE_RELATIONS.map((relation) => (
                      <option key={relation} value={relation}>
                        {RELATION_LABELS[relation]}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </div>
            )}
          </div>

          <p className="mt-4 text-sm leading-6 text-ink-muted">
            Each column of your file, with what&apos;s in it, and where it goes. Columns left out aren&apos;t imported.
          </p>
          <div className="-mx-5 mt-3 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[36rem] text-sm" data-import-columns>
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
                  return (
                    <tr key={column}>
                      <th scope="row" className="px-5 py-2 text-left font-medium break-words text-ink sm:px-6">
                        {label}
                      </th>
                      <td className="max-w-56 px-3 py-2 text-xs break-words text-ink-muted">{examples.join(" · ") || "—"}</td>
                      <td className="px-5 py-2 sm:px-6">
                        <div className="flex gap-2">
                          <div className="relative min-w-52 flex-1">
                            <select
                              aria-label={`Where ${label} goes`}
                              value={mapping[column]?.field ?? ""}
                              disabled={running}
                              onChange={(event) => {
                                const field = (event.target.value || null) as ImportField | null;
                                setColumn(column, field && { field, unit: mapping[column]?.unit ?? 1 });
                              }}
                              className={`${selectClass} ${mapping[column] ? "border-glow/40 text-ink" : "text-ink-muted"}`}
                            >
                              <option value="">Leave out</option>
                              <optgroup label="Customer">
                                {CUSTOMER_IMPORT_FIELDS.map((field) => (
                                  <option key={field} value={field}>
                                    {IMPORT_FIELD_LABELS[field]}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="Vehicle">
                                {VEHICLE_IMPORT_FIELDS.map((field) => (
                                  <option key={field} value={field}>
                                    {IMPORT_FIELD_LABELS[field]}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                            <Chevron />
                          </div>
                          {/* A customer's units can sit side by side in a row. */}
                          {mapping[column] && isVehicleField(mapping[column].field) && (
                            <div className="relative w-28 shrink-0">
                              <select
                                aria-label={`Which of the customer's units ${label} is for`}
                                value={mapping[column].unit}
                                disabled={running}
                                onChange={(event) => setColumn(column, { field: mapping[column]!.field, unit: Number(event.target.value) })}
                                className={`${selectClass} border-glow/40 text-ink`}
                                data-import-unit
                              >
                                {Array.from({ length: MAX_UNITS_PER_ROW }, (_, index) => (
                                  <option key={index} value={index + 1}>
                                    Unit {index + 1}
                                  </option>
                                ))}
                              </select>
                              <Chevron />
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!hasName && (
            <div className="mt-4">
              <Notice tone="trail">Pick the column with the customer&apos;s name (or their first and last names) to import.</Notice>
            </div>
          )}
        </Section>
      )}

      {loaded && plan && hasName && (
        <Section title="3. Import">
          <Preview plan={plan} notes={notes} fileName={loaded.fileName} />
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <button
              type="button"
              onClick={() => void start()}
              disabled={running || plan.customers.length === 0}
              className={primaryLinkClass}
              data-import-start
            >
              {running ? "Importing…" : `Import ${plural(plan.customers.length, "customer", "customers")}`}
            </button>
            {run?.state === "running" && (
              <div className="min-w-56 flex-1" role="status">
                <div
                  role="progressbar"
                  aria-label="Customers saved"
                  aria-valuemin={0}
                  aria-valuemax={run.total}
                  aria-valuenow={run.sent}
                  className="h-2 overflow-hidden rounded-full bg-white/10"
                >
                  <div className="h-full bg-glow transition-[width]" style={{ width: `${run.total ? (run.sent / run.total) * 100 : 0}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-ink-muted">
                  Saved {run.sent.toLocaleString("en-US")} of {plural(run.total, "customer", "customers")}. Keep this tab open.
                </p>
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

function Preview({ plan, notes, fileName }: { plan: NonNullable<ReturnType<typeof planImport>>; notes: ImportNote[]; fileName: string }) {
  const shown = plan.customers.slice(0, 8);
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-ink" data-import-summary>
        {plural(plan.rowsRead, "row", "rows")} read: {plural(plan.customers.length, "customer", "customers")} with{" "}
        {plural(plan.vehicles, "vehicle", "vehicles")}
        {plan.rowsSkipped > 0 ? `, ${plural(plan.rowsSkipped, "row", "rows")} left out` : ""}. Customers already on file are recognised by
        name, and by phone number or email where the file has them: their blank details are filled in, nothing they have is changed, and
        units they already have aren&apos;t added again.
      </p>
      {shown.length > 0 && (
        <div className="-mx-5 overflow-x-auto sm:-mx-6">
          <table className="w-full min-w-[36rem] text-sm" data-import-preview>
            <caption className="sr-only">The first customers to be imported</caption>
            <thead>
              <tr className="border-y border-white/10 text-left text-xs text-ink-muted">
                <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                  Name
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Contact
                </th>
                <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                  Vehicles
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {shown.map((entry) => (
                <tr key={entry.rows.join(",")} className="align-top">
                  <th scope="row" className="px-5 py-2 text-left font-medium break-words text-ink sm:px-6">
                    {entry.customer.name}
                    <span className="block text-xs font-normal text-ink-muted">
                      {entry.rows.length === 1 ? `Row ${entry.rows[0]}` : `Rows ${entry.rows.join(", ")}`}
                    </span>
                  </th>
                  <td className="px-3 py-2 text-xs break-words text-ink-muted">
                    {[entry.customer.phone, entry.customer.email, ...addressLines(entry.customer)].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="px-5 py-2 text-xs text-ink-muted sm:px-6">
                    {entry.vehicles.length === 0
                      ? "—"
                      : entry.vehicles.map((vehicle, index) => (
                          <span key={index} className="block">
                            {[vehicle.year, vehicle.make, vehicle.model ?? vehicle.modelNumber].filter(Boolean).join(" ") || vehicle.vin}{" "}
                            <span className="text-ink-muted/70">({RELATION_LABELS[vehicle.relation]})</span>
                          </span>
                        ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.customers.length > shown.length && (
            <p className="mt-2 px-5 text-xs text-ink-muted sm:px-6">…and {plural(plan.customers.length - shown.length, "more", "more")}.</p>
          )}
        </div>
      )}
      <Notes notes={notes} fileName={fileName} />
    </div>
  );
}

const NOTES_SHOWN = 30;

// What will be, or was, left out or read another way, by row.
function Notes({ notes, fileName }: { notes: ImportNote[]; fileName: string }) {
  if (notes.length === 0) return null;
  const sorted = [...notes].sort((a, b) => a.row - b.row);
  const skipped = notes.filter((note) => note.skipped).length;
  return (
    <details className="rounded-lg border border-trail/30 bg-trail/5 px-4 py-3 text-sm" data-import-notes>
      <summary className="cursor-pointer font-medium text-trail">
        {plural(notes.length, "row needs", "rows need")} a look
        {skipped > 0 ? ` (${plural(skipped, "left out", "left out")})` : ""}
      </summary>
      <ul className="mt-2 space-y-1 text-ink">
        {sorted.slice(0, NOTES_SHOWN).map((note, index) => (
          <li key={index} className="flex gap-3">
            <span className="w-16 shrink-0 font-mono text-xs leading-5 text-ink-muted">Row {note.row}</span>
            <span className="min-w-0 break-words">{note.message}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => download(`${fileName.replace(/\.[^.]+$/, "")} - import notes.csv`, reportCsv(notes))}
        className="mt-3 text-sm text-glow/90 hover:text-glow hover:underline"
      >
        {notes.length > NOTES_SHOWN ? `Download all ${notes.length.toLocaleString("en-US")} (CSV)` : "Download this list (CSV)"}
      </button>
    </details>
  );
}

function Finished({
  run,
  notes,
  fileName,
  onAgain,
}: {
  run: Extract<Run, { state: "done" | "stopped" }>;
  notes: ImportNote[];
  fileName: string;
  onAgain: () => void;
}) {
  const count = (result: ImportOutcome["result"]) => run.outcomes.filter((outcome) => outcome.result === result).length;
  const created = count("created");
  const matched = count("matched");
  const failed = count("failed");
  const filled = run.outcomes.filter((outcome) => outcome.filled.length > 0).length;
  const vehiclesAdded = run.outcomes.reduce((sum, outcome) => sum + outcome.vehiclesAdded, 0);
  const vehiclesOnFile = run.outcomes.reduce((sum, outcome) => sum + outcome.vehiclesOnFile, 0);
  return (
    <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-import-finished={run.state}>
      <h2 className="text-base font-semibold text-ink">{run.state === "done" ? "Import finished" : "Import stopped"}</h2>
      {run.state === "stopped" && (
        <Notice tone="trail">
          Stopped after {run.sent.toLocaleString("en-US")} of {plural(run.total, "customer", "customers")}: {run.error} Choose the file
          again to carry on: customers already imported are recognised, and nothing is added twice.
        </Notice>
      )}
      <ul className="flex flex-wrap gap-2" data-import-result>
        <li>
          <Badge tone="glow">{plural(created, "new customer", "new customers")}</Badge>
        </li>
        <li>
          <Badge>
            {plural(matched, "already on file", "already on file")}
            {filled > 0 ? `, ${filled.toLocaleString("en-US")} filled in` : ""}
          </Badge>
        </li>
        <li>
          <Badge tone="glow">{plural(vehiclesAdded, "vehicle added", "vehicles added")}</Badge>
        </li>
        {vehiclesOnFile > 0 && (
          <li>
            <Badge>{plural(vehiclesOnFile, "vehicle already on record", "vehicles already on record")}</Badge>
          </li>
        )}
        {failed > 0 && (
          <li>
            <Badge tone="trail">{plural(failed, "customer left out", "customers left out")}</Badge>
          </li>
        )}
      </ul>
      <Notes notes={notes} fileName={fileName} />
      <div className="flex flex-wrap gap-3">
        <Link href="/admin/customers" className={primaryLinkClass}>
          View customers
        </Link>
        <button type="button" onClick={onAgain} className={smallButtonClass}>
          Import another file
        </button>
      </div>
    </section>
  );
}
