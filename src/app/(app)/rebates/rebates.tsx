"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Badge, Notice } from "@/components/app/ui";
import { inputBaseClass, primaryLinkClass } from "@/components/hud";
import { formatDay, formatMoney, parseMoney, type Cents } from "@/lib/nusr-rules";
import type { RebateSaleSummary } from "@/lib/rebates";
import {
  REBATE_COLUMNS,
  REBATE_COLUMN_LABELS,
  guessRebateColumn,
  saleNotes,
  type Invoice,
  type InvoiceLine,
  type MatchHow,
  type RebateColumn,
} from "@/lib/rebate-rules";

import { findRebateSalesAction, searchRebateSalesAction } from "./actions";
import { readInvoiceFile, type ReadProgress } from "./reader";

// The Rebates tab, in the manager's browser: invoices dropped here are read
// here (reader.ts), their units found in the NUSR (actions.ts), and every
// line shown to check: the amount (which can be corrected) and the sale it
// was found as (which can be changed, or searched for). Download Excel
// sends what's on the page to /rebates/export, which writes the workbook.

type Line = InvoiceLine & {
  // The amount as shown and corrected.
  amountText: string;
  edited: boolean;
  saleId: string | null;
  how: MatchHow;
  candidates: string[];
  // Other lines of the invoice found as the same sale.
  sharedWith: number[];
};

type Loaded = {
  id: string;
  // What says it's the same invoice dropped again: its number, or the file.
  sameAs: string;
  fileName: string;
  invoice: Omit<Invoice, "lines">;
  scanned: boolean;
  column: RebateColumn;
  lines: Line[];
  lookup: { state: "looking" } | { state: "done" } | { state: "failed"; error: string };
};

type Reading = { fileName: string; progress: ReadProgress; queued: number };

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const selectClass = `${inputBaseClass} h-10 appearance-none pr-9 text-sm`;
const smallButtonClass =
  "inline-flex min-h-10 items-center rounded-lg border border-glow/30 px-3 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";
const linkButtonClass = "text-sm text-glow/90 hover:text-glow hover:underline focus-visible:underline focus-visible:outline-none";

// "1,494.97": an amount as its box shows it.
const amountText = (cents: Cents | null) => (cents === null ? "" : formatMoney(cents).replace("$", ""));
// What a line's box holds, read; null when it isn't an amount.
const lineCents = (line: Pick<Line, "amountText">): Cents | null => {
  const read = parseMoney(line.amountText);
  return "error" in read ? null : read.cents;
};

// "8/21/2026": a sale's date, as the NUSR writes it.
const saleDay = (iso: string) => formatDay(iso);

function progressText({ step, done, pages }: ReadProgress) {
  if (step === "opening") return "Opening…";
  if (step === "checking") return `Reading the amounts it wasn't sure of again: ${done} of ${pages}…`;
  return pages ? `Reading page ${Math.min(done + 1, pages)} of ${pages}…` : "Reading…";
}

// The file name the server gave the download.
function downloadName(header: string | null) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header ?? "")?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall through to the plain name.
    }
  }
  return /filename="([^"]+)"/i.exec(header ?? "")?.[1] ?? "Rebates.xlsx";
}

export function Rebates() {
  const [invoices, setInvoices] = useState<Loaded[]>([]);
  const [sales, setSales] = useState<Record<string, RebateSaleSummary>>({});
  const [reading, setReading] = useState<Reading | null>(null);
  const [problems, setProblems] = useState<{ fileName: string; error: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const known = useRef(new Set<string>());
  const stop = useRef<AbortController | null>(null);
  const fileId = useId();

  // Reading stops when the page goes.
  useEffect(() => {
    const controller = new AbortController();
    stop.current = controller;
    return () => controller.abort();
  }, []);

  const addSales = (list: readonly RebateSaleSummary[]) => setSales((old) => ({ ...old, ...Object.fromEntries(list.map((sale) => [sale.id, sale])) }));
  const updateInvoice = (id: string, change: (invoice: Loaded) => Loaded) => setInvoices((list) => list.map((invoice) => (invoice.id === id ? change(invoice) : invoice)));

  // An invoice's units found in the NUSR.
  async function lookUp(loaded: Loaded) {
    updateInvoice(loaded.id, (invoice) => ({ ...invoice, lookup: { state: "looking" } }));
    const items = loaded.lines.map((line) => ({ key: String(line.line), vinRead: line.vinRead, names: line.names, purchased: line.purchased }));
    const result = await findRebateSalesAction(items).catch(() => ({ error: "The connection dropped. Check it, then look the units up again." }));
    if ("error" in result) {
      updateInvoice(loaded.id, (invoice) => ({ ...invoice, lookup: { state: "failed", error: result.error } }));
      return;
    }
    addSales(result.sales);
    const byKey = new Map(result.matches.map((match) => [match.key, match]));
    updateInvoice(loaded.id, (invoice) => ({
      ...invoice,
      lookup: { state: "done" },
      lines: invoice.lines.map((line) => {
        const match = byKey.get(String(line.line));
        if (!match) return line;
        return { ...line, saleId: match.saleId, how: match.how, candidates: match.candidates, sharedWith: match.sharedWith.map(Number) };
      }),
    }));
  }

  // Each file dropped, read one after another.
  async function readFiles(files: File[]) {
    const controller = stop.current;
    if (files.length === 0 || reading || !controller) return;
    for (const [index, file] of files.entries()) {
      const queued = files.length - index - 1;
      setReading({ fileName: file.name, progress: { step: "opening", done: 0, pages: 0 }, queued });
      const result = await readInvoiceFile(file, (progress) => setReading({ fileName: file.name, progress, queued }), controller.signal);
      if (controller.signal.aborted) return;
      if ("error" in result) {
        setProblems((list) => [...list, { fileName: file.name, error: result.error }]);
        continue;
      }
      const { invoice, scanned } = result;
      const sameAs = invoice.number ? `number:${invoice.number}` : `file:${file.name}:${file.size}`;
      if (known.current.has(sameAs)) {
        setProblems((list) => [...list, { fileName: file.name, error: `${invoice.number ? `Invoice ${invoice.number}` : "This invoice"} is here already.` }]);
        continue;
      }
      known.current.add(sameAs);
      const { lines, ...details } = invoice;
      const loaded: Loaded = {
        id: crypto.randomUUID(),
        sameAs,
        fileName: file.name,
        invoice: details,
        scanned,
        column: guessRebateColumn(lines.flatMap((line) => line.programs)),
        lines: lines.map((line) => ({ ...line, amountText: amountText(line.amount.cents), edited: false, saleId: null, how: null, candidates: [], sharedWith: [] })),
        lookup: { state: "looking" },
      };
      setInvoices((list) => [...list, loaded]);
      void lookUp(loaded);
    }
    setReading(null);
    if (input.current) input.current.value = "";
  }

  function remove(id: string) {
    setInvoices((list) => {
      const gone = list.find((invoice) => invoice.id === id);
      if (gone) known.current.delete(gone.sameAs);
      return list.filter((invoice) => invoice.id !== id);
    });
  }

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    const body = {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      invoices: invoices.map((loaded) => ({
        fileName: loaded.fileName,
        number: loaded.invoice.number,
        type: loaded.invoice.type,
        date: loaded.invoice.date,
        total: loaded.invoice.total?.cents ?? null,
        column: loaded.column,
        lines: loaded.lines.map((line) => ({
          line: line.line,
          part: line.part,
          vinRead: line.vinRead,
          modelCode: line.modelCode,
          programs: line.programs,
          dates: line.dates,
          names: line.names,
          unitPrice: line.unitPrice.cents,
          amount: lineCents(line),
          saleId: line.saleId,
        })),
      })),
    };
    try {
      const response = await fetch("/rebates/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        setDownloadError((await response.text().catch(() => "")) || "Couldn't make the workbook. Try again.");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName(response.headers.get("content-disposition"));
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setDownloadError("The connection dropped. Check it, then try again.");
    } finally {
      setDownloading(false);
    }
  }

  const allLines = invoices.flatMap((invoice) => invoice.lines);
  const found = allLines.filter((line) => line.saleId).length;
  const looking = invoices.some((invoice) => invoice.lookup.state === "looking");
  const badAmounts = allLines.filter((line) => lineCents(line) === null && line.amountText.trim() !== "").length;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6">
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
            void readFiles([...event.dataTransfer.files]);
          }}
          className={`flex min-h-32 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
            dragging ? "border-glow/60 bg-glow/10" : "border-white/20 hover:border-white/30"
          }`}
          data-rebates-drop
        >
          <span className="text-sm font-medium text-ink">{reading ? `Reading ${reading.fileName}…` : "Drop a rebate invoice here, or choose one"}</span>
          <span className="text-xs text-ink-muted">
            A PDF from the dealer portal (Invoice Print), or a scan or photo of the printout. Several at once is fine.
          </span>
          <input
            ref={input}
            id={fileId}
            type="file"
            multiple
            accept=".pdf,application/pdf,image/*"
            disabled={reading !== null}
            onChange={(event) => void readFiles([...(event.target.files ?? [])])}
            className="sr-only"
            data-rebates-file
          />
        </label>
        {reading && (
          <div className="mt-4" role="status" data-rebates-reading>
            <p className="text-sm text-ink">
              {progressText(reading.progress)}
              {reading.queued > 0 && ` Then ${plural(reading.queued, "more file", "more files")}.`}
            </p>
            {reading.progress.pages > 0 && (
              <div
                role="progressbar"
                aria-label={reading.progress.step === "checking" ? "Amounts read again" : "Pages read"}
                aria-valuemin={0}
                aria-valuemax={reading.progress.pages}
                aria-valuenow={reading.progress.done}
                className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"
              >
                <div className="h-full bg-glow transition-[width]" style={{ width: `${(reading.progress.done / reading.progress.pages) * 100}%` }} />
              </div>
            )}
            <p className="mt-2 text-xs text-ink-muted">A scan takes a few seconds a page the first time: the browser fetches what it reads scans with, then keeps it.</p>
          </div>
        )}
        {problems.length > 0 && (
          <ul className="mt-4 space-y-2">
            {problems.map((problem, index) => (
              <li key={index}>
                <Notice tone="trail">
                  {problem.fileName}: {problem.error}
                </Notice>
              </li>
            ))}
          </ul>
        )}
      </section>

      {invoices.map((loaded) => (
        <InvoiceCard
          key={loaded.id}
          loaded={loaded}
          sales={sales}
          onChange={(change) => updateInvoice(loaded.id, change)}
          onLookUp={() => void lookUp(loaded)}
          onRemove={() => remove(loaded.id)}
          onFound={addSales}
        />
      ))}

      {invoices.length > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-rebates-download>
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-ink">
              {plural(allLines.length, "unit", "units")} on {plural(invoices.length, "invoice", "invoices")}: {found.toLocaleString("en-US")} found in the NUSR
              {allLines.length > found && `, ${(allLines.length - found).toLocaleString("en-US")} not`}.
            </p>
            <p className="text-xs leading-5 text-ink-muted">
              The workbook has the NUSR sheet for the years they were sold in, with the rebates in AO (Holdback), AP (Retail Rwds) and AQ (Add&apos;l Hlbk)
              and their totals, and a Rebates sheet with every line as read beside its sale, by salesman and by category.
            </p>
            {badAmounts > 0 && <p className="text-sm text-trail">{plural(badAmounts, "amount isn't", "amounts aren't")} an amount: fix it first.</p>}
            {downloadError && (
              <p role="alert" className="text-sm text-trail">
                {downloadError}
              </p>
            )}
          </div>
          <button type="button" onClick={() => void download()} disabled={downloading || looking || reading !== null || badAmounts > 0} className={primaryLinkClass} data-rebates-download-button>
            {downloading ? "Making the workbook…" : "Download Excel"}
          </button>
        </section>
      )}
    </div>
  );
}

// --- An invoice -----------------------------------------------------------------

function InvoiceCard({
  loaded,
  sales,
  onChange,
  onLookUp,
  onRemove,
  onFound,
}: {
  loaded: Loaded;
  sales: Record<string, RebateSaleSummary>;
  onChange: (change: (invoice: Loaded) => Loaded) => void;
  onLookUp: () => void;
  onRemove: () => void;
  onFound: (list: readonly RebateSaleSummary[]) => void;
}) {
  const { invoice, lines, lookup } = loaded;
  const columnName = useId();
  const sum = lines.reduce((all, line) => all + (lineCents(line) ?? 0), 0);
  const total = invoice.total?.cents === null || invoice.total?.cents === undefined ? null : Math.abs(invoice.total.cents);
  const found = lines.filter((line) => line.saleId).length;
  const toCheck = lines.filter((line) => {
    const sale = line.saleId ? sales[line.saleId] : undefined;
    return sale && saleNotes(line, sale, loaded.column).some((note) => note.check);
  }).length;
  const setLine = (number: number, change: Partial<Line>) =>
    onChange((old) => ({ ...old, lines: old.lines.map((line) => (line.line === number ? { ...line, ...change } : line)) }));

  // What the lines found come to by category, as the shop notes on the
  // invoice (ATV, RZR, UTV).
  const byCategory = new Map<string, Cents>();
  for (const line of lines) {
    const category = line.saleId ? (sales[line.saleId]?.category ?? "No category") : "Not found";
    byCategory.set(category, (byCategory.get(category) ?? 0) + (lineCents(line) ?? 0));
  }

  return (
    <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-rebates-invoice={invoice.number ?? loaded.fileName}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">
            {invoice.number ? `Invoice ${invoice.number}` : loaded.fileName}
            {invoice.type && <span className="font-normal text-ink-muted"> · {invoice.type}</span>}
            {invoice.date && <span className="font-normal text-ink-muted"> · {saleDay(invoice.date)}</span>}
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {loaded.fileName} · {plural(invoice.pages, "page", "pages")}
            {loaded.scanned ? ", read from a scan" : ""}
          </p>
        </div>
        <button type="button" onClick={onRemove} className={linkButtonClass}>
          Remove
        </button>
      </div>

      <ul className="flex flex-wrap gap-2" data-rebates-counts>
        <li>
          <Badge tone="glow">{plural(lines.length, "unit", "units")}</Badge>
        </li>
        {lookup.state === "done" && (
          <>
            <li>
              <Badge>{found.toLocaleString("en-US")} found in the NUSR</Badge>
            </li>
            {lines.length > found && (
              <li>
                <Badge tone="trail">{(lines.length - found).toLocaleString("en-US")} not found</Badge>
              </li>
            )}
            {toCheck > 0 && (
              <li>
                <Badge tone="trail">{toCheck.toLocaleString("en-US")} to check</Badge>
              </li>
            )}
          </>
        )}
        {lookup.state === "looking" && (
          <li>
            <Badge>Looking them up in the NUSR…</Badge>
          </li>
        )}
      </ul>
      {lookup.state === "failed" && (
        <div className="flex flex-wrap items-center gap-3">
          <Notice tone="trail">{lookup.error}</Notice>
          <button type="button" onClick={onLookUp} className={smallButtonClass}>
            Look them up again
          </button>
        </div>
      )}

      <div data-rebates-total>
        {total === null ? (
          <Notice tone="trail" live={false}>
            No total was read from the invoice to check the amounts against: check them against the printout.
          </Notice>
        ) : sum === total ? (
          <Notice live={false}>The amounts add up to {formatMoney(total)}, the invoice&apos;s total.</Notice>
        ) : (
          <Notice tone="trail" live={false}>
            The amounts add up to {formatMoney(sum)}; the invoice&apos;s total is {formatMoney(total)}, {formatMoney(Math.abs(total - sum))}{" "}
            {sum < total ? "more" : "less"}. Check the amounts marked against the printout.
          </Notice>
        )}
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-ink">Its amounts go in</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {REBATE_COLUMNS.map((column) => (
            <label key={column} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name={columnName}
                checked={loaded.column === column}
                onChange={() => onChange((old) => ({ ...old, column }))}
                className="size-4 accent-glow"
              />
              {REBATE_COLUMN_LABELS[column]}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          {loaded.column === "addlHoldback"
            ? "The NUSR's own holdback on each unit (MSRP x its rate) goes in AO beside it, as on the shop's sheet."
            : loaded.column === "retailRewards"
              ? "AO is left as it is for these: only the retail rewards go in."
              : "These amounts are the holdback paid, in AO in place of the NUSR's."}
        </p>
      </fieldset>

      {byCategory.size > 0 && lookup.state === "done" && (
        <p className="text-sm text-ink-muted" data-rebates-categories>
          By category:{" "}
          {[...byCategory.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([category, cents]) => `${category} ${formatMoney(cents)}`)
            .join(" · ")}
        </p>
      )}

      <div className="-mx-5 overflow-x-auto sm:-mx-6">
        <table className="w-full min-w-[56rem] text-sm" data-rebates-lines>
          <caption className="sr-only">The invoice&apos;s units and the sales they were found as</caption>
          <thead>
            <tr className="border-y border-white/10 text-left text-xs text-ink-muted">
              <th scope="col" className="w-10 px-5 py-2 font-medium sm:px-6">
                #
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                On the invoice
              </th>
              <th scope="col" className="w-40 px-3 py-2 font-medium">
                Amount
              </th>
              <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                In the NUSR
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {lines.map((line) => (
              <LineRow
                key={line.line}
                line={line}
                sales={sales}
                column={loaded.column}
                looking={lookup.state === "looking"}
                onChange={(change) => setLine(line.line, change)}
                onFound={onFound}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- A line ---------------------------------------------------------------------

function LineRow({
  line,
  sales,
  column,
  looking,
  onChange,
  onFound,
}: {
  line: Line;
  sales: Record<string, RebateSaleSummary>;
  column: RebateColumn;
  looking: boolean;
  onChange: (change: Partial<Line>) => void;
  onFound: (list: readonly RebateSaleSummary[]) => void;
}) {
  const cents = lineCents(line);
  const unsure = !line.edited && !line.amount.sure;
  const wrong = cents === null && line.amountText.trim() !== "";
  return (
    <tr className="align-top" data-rebates-line={line.line}>
      <td className="px-5 py-3 text-ink-muted sm:px-6" title={`Page ${line.page}`}>
        {line.line}
      </td>
      <td className="px-3 py-3">
        <p className="font-mono text-sm break-all text-ink">
          {line.vinRead}
          {line.modelCode && <span className="text-ink-muted">/{line.modelCode}</span>}
        </p>
        <p className="mt-0.5 text-xs leading-5 break-words text-ink-muted">
          {[line.names.join(", "), line.dates[0], line.programs[0], ...line.other].filter(Boolean).join(" · ") || "Nothing printed under it"}
        </p>
      </td>
      <td className="px-3 py-3">
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-ink-muted">$</span>
          <input
            type="text"
            inputMode="decimal"
            value={line.amountText}
            onChange={(event) => onChange({ amountText: event.target.value, edited: true })}
            aria-label={`Amount for line ${line.line}`}
            aria-invalid={wrong || undefined}
            className={`${inputBaseClass} h-10 pl-6 text-right text-sm tabular-nums ${unsure || wrong ? "border-trail/60" : ""}`}
            data-rebates-amount
          />
        </div>
        {wrong ? (
          <p className="mt-1 text-xs text-trail">Not an amount.</p>
        ) : unsure ? (
          <p className="mt-1 text-xs text-trail">Check it: read as “{line.amount.text || "nothing"}”.</p>
        ) : null}
        {line.unitPrice.cents ? <p className="mt-1 text-xs text-ink-muted">Unit Price {formatMoney(line.unitPrice.cents)}</p> : null}
      </td>
      <td className="px-5 py-3 sm:px-6">
        <SaleCell line={line} sales={sales} column={column} looking={looking} onChange={onChange} onFound={onFound} />
      </td>
    </tr>
  );
}

function SaleCell({
  line,
  sales,
  column,
  looking,
  onChange,
  onFound,
}: {
  line: Line;
  sales: Record<string, RebateSaleSummary>;
  column: RebateColumn;
  looking: boolean;
  onChange: (change: Partial<Line>) => void;
  onFound: (list: readonly RebateSaleSummary[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchProblem, setSearchProblem] = useState<string | null>(null);
  const sale = line.saleId ? sales[line.saleId] : undefined;
  const open = editing || (!looking && !line.saleId);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    setSearchProblem(null);
    const result = await searchRebateSalesAction(query).catch(() => ({ error: "The connection dropped. Try again." }));
    setSearching(false);
    if ("error" in result) {
      setSearchProblem(result.error);
      return;
    }
    if (result.sales.length === 0) {
      setSearchProblem("Nothing in the NUSR has all of that.");
      return;
    }
    onFound(result.sales);
    const ids = result.sales.map((found) => found.id);
    // One sale found for a line with none is taken; several are offered.
    onChange({ candidates: [...new Set([...ids, ...line.candidates])], ...(line.saleId || ids.length !== 1 ? {} : { saleId: ids[0], how: null }) });
  }

  if (looking) return <p className="text-ink-muted">Looking…</p>;

  return (
    <div className="space-y-2">
      {sale ? (
        <div>
          <p className="text-ink">
            <Link href={`/nusr/${sale.id}`} target="_blank" className="font-medium hover:text-glow hover:underline">
              {sale.customerName}
            </Link>{" "}
            <span className="text-ink-muted">
              · {saleDay(sale.soldOn)} · {sale.unit}
            </span>
          </p>
          <p className="text-xs text-ink-muted">
            {[sale.salesperson, sale.category, sale.condition === "used" ? "Used" : null].filter(Boolean).join(" · ")}
            {column === "addlHoldback" && sale.holdback > 0 && ` · Holdback ${formatMoney(sale.holdback)}`}
          </p>
          <SaleNotes line={line} sale={sale} column={column} />
        </div>
      ) : (
        <p className="font-medium text-trail">{line.candidates.length ? "Not found by its VIN: pick the sale" : "Not found in the NUSR"}</p>
      )}

      {open ? (
        <div className="space-y-2">
          {line.candidates.length > 0 && (
            <select
              value={line.saleId ?? ""}
              onChange={(event) => onChange({ saleId: event.target.value || null, how: null })}
              aria-label={`Sale for line ${line.line}`}
              className={selectClass}
            >
              <option value="">Leave it out of the NUSR sheet</option>
              {line.candidates.map((id) => {
                const option = sales[id];
                return option ? (
                  <option key={id} value={id}>
                    {option.customerName} · {saleDay(option.soldOn)} · {option.unit}
                    {option.vin ? ` · ${option.vin}` : ""}
                  </option>
                ) : null;
              })}
            </select>
          )}
          <form onSubmit={(event) => void search(event)} className="flex gap-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find the sale: name, VIN, model…"
              aria-label={`Find the sale for line ${line.line} in the NUSR`}
              className={`${inputBaseClass} h-10 text-sm`}
            />
            <button type="submit" disabled={searching} className={smallButtonClass}>
              {searching ? "Finding…" : "Find"}
            </button>
          </form>
          {searchProblem && <p className="text-xs text-trail">{searchProblem}</p>}
          {editing && (
            <button type="button" onClick={() => setEditing(false)} className={linkButtonClass}>
              Done
            </button>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setEditing(true)} className={linkButtonClass}>
          Change
        </button>
      )}
    </div>
  );
}

// What's worth a look about the sale a line was found as (saleNotes), with
// a link to correct the sale where that's what it needs.
function SaleNotes({ line, sale, column }: { line: Line; sale: RebateSaleSummary; column: RebateColumn }) {
  const notes = saleNotes(line, sale, column);
  if (notes.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs leading-5">
      {notes.map((note, index) => (
        <li key={index} className={note.check ? "text-trail" : "text-ink-muted"}>
          {note.text}
          {note.correct && (
            <>
              {" "}
              <Link href={`/nusr/${sale.id}`} target="_blank" className="underline">
                Correct the sale
              </Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
