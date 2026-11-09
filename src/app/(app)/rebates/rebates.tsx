"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from "react";

import { Badge, Notice } from "@/components/app/ui";
import { inputBaseClass, primaryLinkClass } from "@/components/hud";
import { formatDay, formatMoney, parseMoney, type Cents } from "@/lib/nusr-rules";
import type { OpenedInvoice, RebateSaleSummary } from "@/lib/rebates";
import {
  REBATE_COLUMNS,
  REBATE_COLUMN_HEADINGS,
  REBATE_COLUMN_LABELS,
  REBATE_COLUMN_LETTERS,
  invoicePrograms,
  saleNotes,
  type Invoice,
  type InvoiceLine,
  type InvoicePrograms,
  type MatchHow,
  type RebateColumn,
} from "@/lib/rebate-rules";

import { findRebateSalesAction, saveRebateInvoiceAction, searchRebateSalesAction } from "./actions";
import { readInvoiceFile, type ReadProgress } from "./reader";

// The Rebates tab, in the manager's browser: invoices dropped anywhere on
// the page (or chosen) are read here (reader.ts), their units found in the
// NUSR (actions.ts), and each one shown on its own under New invoices, at
// the top of the page, every line to check: the amount (which can be
// corrected) and the sale it was found as (which can be changed, or
// searched for). With several on the page, New invoices lists them, each
// with where it stands and a way to it. Save keeps an invoice as checked
// (Saved rebates, below, lists what's saved; Open there brings one back up
// here to change and save again). Download Excel sends what's on the page
// to /rebates/export, which writes the workbook.

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
  // Where its amounts go: what its programs say, until it's changed; null
  // until it's picked when they don't say.
  column: RebateColumn | null;
  programs: InvoicePrograms;
  lines: Line[];
  lookup: { state: "looking" } | { state: "done" } | { state: "failed"; error: string };
  // The saved invoice it is, once saved or opened from Saved rebates;
  // whether what's shown is saved; and how often it's been changed (a save
  // sent before a change doesn't save the change).
  savedId: string | null;
  save: SaveState;
  edits: number;
};

type SaveState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; how: "saved" | "replaced" | "opened" }
  // Its number is saved already: to save this in its place, or not.
  | { state: "exists"; savedAt: string; savedBy: string | null; lines: number }
  | { state: "failed"; error: string };

// Saved rebates' Remove says which saved invoice went, so a card of it on
// the page is no longer marked saved.
export const REMOVED_EVENT = "rebates:removed";

// The page's one file box, which Choose invoices (at the top of the page)
// opens too.
const FILE_INPUT = "rebates-file";

// Choose invoices, at the top of the page: the file box under New invoices,
// which reads what's chosen.
export function ChooseInvoicesButton() {
  return (
    <button type="button" onClick={() => document.getElementById(FILE_INPUT)?.click()} className={primaryLinkClass} data-rebates-choose>
      Choose invoices
    </button>
  );
}

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
// "11/6/2026": the day something was saved, in this browser's time zone.
const savedDay = (iso: string) => new Date(iso).toLocaleDateString("en-US");

// An invoice as the server takes it, to save or download: what was read,
// as checked here.
function payloadOf(loaded: Loaded) {
  return {
    fileName: loaded.fileName,
    number: loaded.invoice.number,
    type: loaded.invoice.type,
    date: loaded.invoice.date,
    total: loaded.invoice.total?.cents ?? null,
    column: loaded.column,
    pages: loaded.invoice.pages,
    lines: loaded.lines.map((line) => ({
      line: line.line,
      page: line.page,
      part: line.part,
      vinRead: line.vinRead,
      modelCode: line.modelCode,
      programs: line.programs,
      dates: line.dates,
      purchased: line.purchased,
      names: line.names,
      other: line.other,
      unitPrice: line.unitPrice.cents,
      amount: lineCents(line),
      amountText: line.amount.text,
      amountSure: line.edited || line.amount.sure,
      saleId: line.saleId,
      how: line.how,
    })),
  };
}

// A saved invoice, opened from Saved rebates, as the page shows one read
// from a file: each line with the sale it was saved with.
function loadedFromSaved(opened: OpenedInvoice): Loaded {
  const lines: Line[] = opened.lines.map((line) => ({
    line: line.line,
    page: line.page,
    part: line.part,
    vinRead: line.vinRead,
    modelCode: line.modelCode,
    unitPrice: { text: "", cents: line.unitPrice, sure: true, others: [] },
    amount: { text: line.amountText, cents: line.amount, sure: line.amountSure, others: [] },
    amountBox: { left: 0, top: 0, right: 0, bottom: 0 },
    programs: line.programs,
    dates: line.dates,
    purchased: line.purchased,
    names: line.names,
    other: line.other,
    amountText: amountText(line.amount),
    edited: false,
    saleId: line.saleId,
    how: line.how,
    candidates: line.saleId ? [line.saleId] : [],
    sharedWith: [],
  }));
  for (const line of lines) line.sharedWith = lines.filter((other) => other !== line && other.saleId !== null && other.saleId === line.saleId).map((other) => other.line);
  const { number, type, date, total, column, fileName, pages } = opened.invoice;
  return {
    id: opened.id,
    sameAs: number ? `number:${number}` : `saved:${opened.id}`,
    fileName,
    invoice: { number, type, date, total: total === null ? null : { text: "", cents: total, sure: true, others: [] }, pages },
    scanned: false,
    column,
    programs: invoicePrograms(lines),
    lines,
    lookup: { state: "done" },
    savedId: opened.id,
    save: { state: "saved", how: "opened" },
    edits: 0,
  };
}

// What an invoice's lines come to and what's left on it to check: for its
// card, and for the list of the invoices on the page.
type Check = { sum: Cents; total: Cents | null; found: number; toCheck: number; badAmounts: number };

function checkOf(loaded: Loaded, sales: Record<string, RebateSaleSummary>): Check {
  const { lines } = loaded;
  const total = loaded.invoice.total?.cents ?? null;
  return {
    sum: lines.reduce((all, line) => all + (lineCents(line) ?? 0), 0),
    total: total === null ? null : Math.abs(total),
    found: lines.filter((line) => line.saleId).length,
    toCheck: lines.filter((line) => {
      const sale = line.saleId ? sales[line.saleId] : undefined;
      return sale && saleNotes(line, sale, loaded.column).some((note) => note.check);
    }).length,
    badAmounts: lines.filter((line) => lineCents(line) === null && line.amountText.trim() !== "").length,
  };
}

// Where an invoice on the page stands, in a word or two.
function standing(loaded: Loaded, check: Check): { text: string; tone: "neutral" | "glow" | "trail" } {
  const { lookup, save } = loaded;
  if (lookup.state === "looking") return { text: "Looking up…", tone: "neutral" };
  if (lookup.state === "failed") return { text: "Not looked up", tone: "trail" };
  if (save.state === "saving") return { text: "Saving…", tone: "neutral" };
  if (save.state === "saved") return { text: save.how === "opened" ? "Opened from saved" : "Saved", tone: "glow" };
  if (save.state === "exists") return { text: "Saved already", tone: "trail" };
  if (save.state === "failed") return { text: "Didn't save", tone: "trail" };
  if (loaded.column === null) return { text: "Pick a column", tone: "trail" };
  if (check.badAmounts > 0) return { text: "Fix an amount", tone: "trail" };
  if (loaded.savedId) return { text: "Changed since saved", tone: "trail" };
  return { text: "Not saved yet", tone: "neutral" };
}

// Brings an invoice's card into view, with the focus on it.
function goToCard(loaded: Loaded) {
  const card = document.querySelector<HTMLElement>(`[data-rebates-card="${loaded.savedId ?? loaded.id}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "start" });
  card?.focus({ preventScroll: true });
}

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

export function Rebates({ opened }: { opened: OpenedInvoice | null }) {
  const router = useRouter();
  const [invoices, setInvoices] = useState<Loaded[]>([]);
  const [sales, setSales] = useState<Record<string, RebateSaleSummary>>({});
  // A saved invoice opened from Saved rebates (?open=) joins the page's
  // invoices: once while the address has it, however often the page is
  // shown again (a save refreshes it), so closing it keeps it closed.
  const openedId = opened?.id ?? null;
  const [shownOpened, setShownOpened] = useState<string | null>(null);
  if (openedId !== shownOpened) {
    setShownOpened(openedId);
    if (opened) {
      setInvoices((list) => (list.some((invoice) => invoice.savedId === opened.id) ? list : [...list, loadedFromSaved(opened)]));
      setSales((old) => ({ ...old, ...Object.fromEntries(opened.sales.map((sale) => [sale.id, sale])) }));
    }
  }
  const [reading, setReading] = useState<Reading | null>(null);
  const [problems, setProblems] = useState<{ fileName: string; error: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const known = useRef(new Set<string>());
  const stop = useRef<AbortController | null>(null);
  const newInvoices = useRef<HTMLElement>(null);

  // Reading stops when the page goes.
  useEffect(() => {
    const controller = new AbortController();
    stop.current = controller;
    return () => controller.abort();
  }, []);

  // An opened invoice counts as on the page for a file dropped after it,
  // and is scrolled to.
  const openedNumber = opened?.invoice.number ?? null;
  useEffect(() => {
    if (!openedId) return;
    known.current.add(openedNumber ? `number:${openedNumber}` : `saved:${openedId}`);
    document.querySelector(`[data-rebates-card="${openedId}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openedId, openedNumber]);

  // A file can be dropped anywhere on the page (Saved rebates, further down,
  // too): while one is dragged over, the page says to drop it.
  const dropped = useEffectEvent((files: File[]) => void readFiles(files));
  useEffect(() => {
    let over = 0;
    const withFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const enter = (event: DragEvent) => {
      if (!withFiles(event)) return;
      over += 1;
      setDragging(true);
    };
    const move = (event: DragEvent) => {
      if (!withFiles(event)) return;
      // Dropping is allowed, and never opens the file in place of the page.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!withFiles(event)) return;
      over = Math.max(0, over - 1);
      if (over === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!withFiles(event)) return;
      event.preventDefault();
      over = 0;
      setDragging(false);
      dropped([...(event.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", move);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", move);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // A saved invoice removed in Saved rebates isn't saved any more: a card of
  // it on the page can be saved again.
  useEffect(() => {
    const removed = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      setInvoices((list) => list.map((invoice) => (invoice.savedId === id ? { ...invoice, savedId: null, save: { state: "idle" } } : invoice)));
    };
    window.addEventListener(REMOVED_EVENT, removed);
    return () => window.removeEventListener(REMOVED_EVENT, removed);
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
    if (files.length === 0 || !controller) return;
    if (reading) {
      setProblems((list) => [...list, ...files.map((file) => ({ fileName: file.name, error: "Another invoice was being read: drop this one again once it's done." }))]);
      return;
    }
    // New invoices, where it's read, is at the top: brought back into view
    // when it was dropped further down (on Saved rebates, say).
    const box = newInvoices.current?.getBoundingClientRect();
    if (box && (box.top < 0 || box.top > window.innerHeight - 160)) newInvoices.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      const programs = invoicePrograms(lines);
      const loaded: Loaded = {
        id: crypto.randomUUID(),
        sameAs,
        fileName: file.name,
        invoice: details,
        scanned,
        column: programs.column,
        programs,
        lines: lines.map((line) => ({ ...line, amountText: amountText(line.amount.cents), edited: false, saleId: null, how: null, candidates: [], sharedWith: [] })),
        lookup: { state: "looking" },
        savedId: null,
        save: { state: "idle" },
        edits: 0,
      };
      setInvoices((list) => [...list, loaded]);
      void lookUp(loaded);
    }
    setReading(null);
    if (input.current) input.current.value = "";
  }

  // Takes an invoice off the page (a saved one stays saved). The one the
  // address opened goes from the address too, so Open brings it back.
  function close(loaded: Loaded) {
    known.current.delete(loaded.sameAs);
    setInvoices((list) => list.filter((invoice) => invoice.id !== loaded.id));
    if (openedId && loaded.savedId === openedId) {
      const params = new URLSearchParams(window.location.search);
      params.delete("open");
      router.replace(`/rebates${params.size ? `?${params}` : ""}`, { scroll: false });
    }
  }

  // A change on the card: what's shown is no longer what's saved (once a
  // save on its way comes back).
  const change = (id: string, edit: (invoice: Loaded) => Loaded) =>
    updateInvoice(id, (invoice) => ({ ...edit(invoice), edits: invoice.edits + 1, save: invoice.save.state === "saving" ? invoice.save : { state: "idle" } }));

  // Saves an invoice as checked here: in place of the saved one when it's
  // one opened from Saved rebates or `replace` says so. Saved rebates, under
  // the invoices on the page, shows it once it's saved.
  async function save(loaded: Loaded, replace: boolean) {
    const edits = loaded.edits;
    updateInvoice(loaded.id, (invoice) => ({ ...invoice, save: { state: "saving" } }));
    const result = await saveRebateInvoiceAction({ invoice: payloadOf(loaded), savedId: loaded.savedId, replace: replace || loaded.savedId !== null }).catch(() => ({
      error: "The connection dropped. Check it, then save again.",
    }));
    if ("error" in result) {
      updateInvoice(loaded.id, (invoice) => ({ ...invoice, save: { state: "failed", error: result.error } }));
      return;
    }
    if ("exists" in result) {
      updateInvoice(loaded.id, (invoice) => ({ ...invoice, save: { state: "exists", savedAt: result.exists.savedAt, savedBy: result.exists.savedBy, lines: result.exists.lines } }));
      return;
    }
    const { id, replaced } = result.saved;
    updateInvoice(loaded.id, (invoice) => ({
      ...invoice,
      savedId: id,
      save: invoice.edits === edits ? { state: "saved", how: replaced ? "replaced" : "saved" } : { state: "idle" },
    }));
    router.refresh();
  }

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    const body = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, invoices: invoices.map(payloadOf) };
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
  const unpicked = invoices.filter((invoice) => invoice.column === null);

  return (
    <div className="space-y-6">
      {dragging && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-forest-950/70 p-6 backdrop-blur-sm" data-rebates-dragging>
          <p className="rounded-xl border-2 border-dashed border-glow/60 bg-charcoal-900/90 px-8 py-6 text-center text-base font-medium text-glow">
            Drop the invoice to read it
          </p>
        </div>
      )}
      <section
        ref={newInvoices}
        className="scroll-mt-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6"
        aria-labelledby="new-invoices"
        data-rebates-new
      >
        <h2 id="new-invoices" className="text-base font-semibold text-ink">
          New invoices
        </h2>
        <label
          htmlFor={FILE_INPUT}
          className={`mt-4 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
            dragging ? "border-glow/60 bg-glow/10" : "border-white/20 hover:border-white/30"
          }`}
          data-rebates-drop
        >
          <span className="text-sm font-medium text-ink">{reading ? `Reading ${reading.fileName}…` : "Drop a rebate invoice here, or choose one"}</span>
          <span className="text-xs text-ink-muted">
            A PDF from the dealer portal (Invoice Print), or a scan or photo of the printout. Several at once is fine (each is checked on its own), and anywhere on the page will do.
          </span>
          <input
            ref={input}
            id={FILE_INPUT}
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
        {invoices.length > 1 && <OnThePage invoices={invoices} sales={sales} />}
      </section>

      {invoices.map((loaded) => (
        <InvoiceCard
          key={loaded.id}
          loaded={loaded}
          sales={sales}
          onChange={(edit) => change(loaded.id, edit)}
          onLookUp={() => void lookUp(loaded)}
          onClose={() => close(loaded)}
          onSave={(replace) => void save(loaded, replace)}
          onKeepSaved={() => updateInvoice(loaded.id, (invoice) => ({ ...invoice, save: { state: "idle" } }))}
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
            {unpicked.length > 0 && (
              <p className="text-sm text-trail">
                Pick which column {unpicked.map((invoice) => (invoice.invoice.number ? `invoice ${invoice.invoice.number}` : invoice.fileName)).join(" and ")}
                &apos;s amounts go in first.
              </p>
            )}
            {downloadError && (
              <p role="alert" className="text-sm text-trail">
                {downloadError}
              </p>
            )}
          </div>
          <button type="button" onClick={() => void download()} disabled={downloading || looking || reading !== null || badAmounts > 0 || unpicked.length > 0} className={primaryLinkClass} data-rebates-download-button>
            {downloading ? "Making the workbook…" : "Download Excel"}
          </button>
        </section>
      )}
    </div>
  );
}

// --- The invoices on the page ---------------------------------------------------

// With several invoices on the page, each on its own line: what it has,
// whether its amounts add up to its total, where it stands, and Check,
// which goes to its card below.
function OnThePage({ invoices, sales }: { invoices: Loaded[]; sales: Record<string, RebateSaleSummary> }) {
  return (
    <div className="mt-5" data-rebates-on-page>
      <h3 className="text-sm font-semibold text-ink">{plural(invoices.length, "invoice", "invoices")} on the page</h3>
      <p className="mt-0.5 text-xs text-ink-muted">Each file is read, checked and saved on its own, below. Check goes to one.</p>
      <div className="relative -mx-5 mt-3 overflow-x-auto border-y border-white/10 sm:-mx-6">
        <table className="w-full min-w-[48rem] text-sm">
          <caption className="sr-only">The invoices on the page and where each stands</caption>
          <thead>
            <tr className="border-b border-white/10 text-left text-xs text-ink-muted">
              <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                Invoice
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Units
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Amount
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Where it stands
              </th>
              <th scope="col" className="px-5 py-2 sm:px-6">
                <span className="sr-only">Go to it</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {invoices.map((loaded) => {
              const check = checkOf(loaded, sales);
              const { invoice, lines, lookup } = loaded;
              const status = standing(loaded, check);
              const name = invoice.number ? `Invoice ${invoice.number}` : loaded.fileName;
              const notFound = lines.length - check.found;
              return (
                <tr key={loaded.id} className="align-top" data-rebates-on-page-invoice={invoice.number ?? loaded.fileName}>
                  <td className="px-5 py-3 sm:px-6">
                    <p className="font-medium text-ink">
                      {name}
                      {invoice.date && <span className="font-normal text-ink-muted"> · {saleDay(invoice.date)}</span>}
                    </p>
                    <p className="text-xs break-all text-ink-muted">
                      {[invoice.number ? loaded.fileName : null, invoice.type, loaded.column ? REBATE_COLUMN_LETTERS[loaded.column] : null].filter(Boolean).join(" · ")}
                    </p>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <p className="text-ink tabular-nums">{plural(lines.length, "unit", "units")}</p>
                    {lookup.state === "done" && (
                      <p className={`text-xs ${notFound > 0 || check.toCheck > 0 ? "text-trail" : "text-ink-muted"}`}>
                        {notFound === 0 ? "All found" : `${notFound.toLocaleString("en-US")} not found`}
                        {check.toCheck > 0 && ` · ${check.toCheck.toLocaleString("en-US")} to check`}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <p className="text-ink tabular-nums">{formatMoney(check.sum)}</p>
                    <p className={`text-xs ${check.total !== null && check.sum === check.total ? "text-ink-muted" : "text-trail"}`}>
                      {check.total === null
                        ? "No total read"
                        : check.sum === check.total
                          ? "Adds up to its total"
                          : `${formatMoney(Math.abs(check.total - check.sum))} ${check.sum < check.total ? "under" : "over"} its total`}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={status.tone}>{status.text}</Badge>
                  </td>
                  <td className="px-5 py-3 text-right sm:px-6">
                    <button type="button" onClick={() => goToCard(loaded)} className={linkButtonClass} data-rebates-go-to>
                      Check<span className="sr-only"> {name}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- An invoice -----------------------------------------------------------------

function InvoiceCard({
  loaded,
  sales,
  onChange,
  onLookUp,
  onClose,
  onSave,
  onKeepSaved,
  onFound,
}: {
  loaded: Loaded;
  sales: Record<string, RebateSaleSummary>;
  onChange: (change: (invoice: Loaded) => Loaded) => void;
  onLookUp: () => void;
  onClose: () => void;
  // Saves it; in place of the one saved with its number, when `replace`.
  onSave: (replace: boolean) => void;
  onKeepSaved: () => void;
  onFound: (list: readonly RebateSaleSummary[]) => void;
}) {
  const { invoice, lines, lookup, save } = loaded;
  const columnName = useId();
  const { sum, total, found, toCheck, badAmounts } = checkOf(loaded, sales);
  const setLine = (number: number, change: Partial<Line>) =>
    onChange((old) => ({ ...old, lines: old.lines.map((line) => (line.line === number ? { ...line, ...change } : line)) }));
  const saveable = lookup.state === "done" && loaded.column !== null && badAmounts === 0;
  const name = invoice.number ? `Invoice ${invoice.number}` : "This invoice";

  // What the lines found come to by category, as the shop notes on the
  // invoice (ATV, RZR, UTV).
  const byCategory = new Map<string, Cents>();
  for (const line of lines) {
    const category = line.saleId ? (sales[line.saleId]?.category ?? "No category") : "Not found";
    byCategory.set(category, (byCategory.get(category) ?? 0) + (lineCents(line) ?? 0));
  }

  return (
    <section
      tabIndex={-1}
      aria-label={invoice.number ? `Invoice ${invoice.number}` : loaded.fileName}
      className="scroll-mt-4 space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 focus:outline-none sm:p-6"
      data-rebates-invoice={invoice.number ?? loaded.fileName}
      data-rebates-card={loaded.savedId ?? loaded.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">
            {invoice.number ? `Invoice ${invoice.number}` : loaded.fileName}
            {invoice.type && <span className="font-normal text-ink-muted"> · {invoice.type}</span>}
            {invoice.date && <span className="font-normal text-ink-muted"> · {saleDay(invoice.date)}</span>}
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {loaded.fileName}
            {invoice.pages > 0 && ` · ${plural(invoice.pages, "page", "pages")}`}
            {loaded.scanned ? ", read from a scan" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => onSave(false)}
            disabled={!saveable || save.state === "saving" || save.state === "saved" || save.state === "exists"}
            className={smallButtonClass}
            data-rebates-save
          >
            {save.state === "saving" ? "Saving…" : save.state === "saved" ? "Saved" : loaded.savedId ? "Save changes" : "Save"}
          </button>
          <button type="button" onClick={onClose} className={linkButtonClass} data-rebates-close>
            Close
          </button>
        </div>
      </div>

      <div data-rebates-save-state={save.state}>
        {save.state === "saved" ? (
          <Notice>
            {save.how === "opened"
              ? "Opened from Saved rebates. Change anything, then Save changes to keep it."
              : save.how === "replaced"
                ? "Saved in place of the one saved before. Saved rebates, below, has it."
                : "Saved. Saved rebates, below, has it."}
          </Notice>
        ) : save.state === "exists" ? (
          <div className="space-y-3 rounded-lg border border-trail/40 bg-trail/5 p-4" role="alert">
            <p className="text-sm text-ink">
              {name} is saved already: {plural(save.lines, "line", "lines")}, saved {save.savedBy ? `by ${save.savedBy} ` : ""}on {savedDay(save.savedAt)}. Save this in
              its place? Its lines are replaced with these.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => onSave(true)} className={smallButtonClass} data-rebates-replace>
                Save in its place
              </button>
              <button type="button" onClick={onKeepSaved} className={linkButtonClass}>
                Keep the saved one
              </button>
            </div>
          </div>
        ) : save.state === "failed" ? (
          <Notice tone="trail">{save.error}</Notice>
        ) : save.state === "idle" && lookup.state === "done" && loaded.column === null ? (
          <p className="text-xs text-ink-muted">Pick which column its amounts go in, below, to save it.</p>
        ) : save.state === "idle" && lookup.state === "done" && badAmounts > 0 ? (
          <p className="text-xs text-trail">{plural(badAmounts, "amount isn't", "amounts aren't")} an amount: fix it to save the invoice.</p>
        ) : save.state === "idle" && loaded.savedId ? (
          <p className="text-xs text-trail">Changed since it was saved: Save changes to keep them.</p>
        ) : null}
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

      <fieldset data-rebates-column>
        <legend className="text-sm font-medium text-ink">Its amounts go in</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {REBATE_COLUMNS.map((column) => (
            <label key={column} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name={columnName}
                value={column}
                checked={loaded.column === column}
                onChange={() => onChange((old) => ({ ...old, column }))}
                className="size-4 accent-glow"
              />
              {REBATE_COLUMN_LABELS[column]}
            </label>
          ))}
        </div>
        <ProgramsSaid programs={loaded.programs} column={loaded.column} />
        {loaded.column && (
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {loaded.column === "addlHoldback"
              ? "The NUSR's own holdback on each unit (MSRP x its rate) goes in AO beside it, as on the shop's sheet."
              : loaded.column === "retailRewards"
                ? "AO is left as it is for these: only the retail rewards go in. Drop the NSR invoice with it to fill AQ (and AO) in the same workbook."
                : "These amounts are the holdback paid, in AO in place of the NUSR's."}
          </p>
        )}
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
  column: RebateColumn | null;
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
  column: RebateColumn | null;
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
function SaleNotes({ line, sale, column }: { line: Line; sale: RebateSaleSummary; column: RebateColumn | null }) {
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

// What the invoice's programs said about where its amounts go: which of
// them it went by, that they don't say (pick one), or that its lines say
// more than one thing.
function ProgramsSaid({ programs, column }: { programs: InvoicePrograms; column: RebateColumn | null }) {
  const [first, second, ...rest] = programs.programs;
  const named = !second ? (first ?? "") : rest.length === 0 ? `${first} and ${second}` : `${first}, ${second} and ${rest.length} more`;
  const said = (Object.entries(programs.lines) as [RebateColumn, number][]).sort((a, b) => b[1] - a[1]);
  if (!programs.column) {
    return (
      <p role="status" className="mt-2 text-sm text-trail">
        {programs.programs.length === 0
          ? "No program was read from this invoice"
          : said.length > 1
            ? `Its lines' programs (${named}) say ${said.map(([kind, count]) => `${REBATE_COLUMN_HEADINGS[kind]} on ${plural(count, "line", "lines")}`).join(" and ")}`
            : `Its programs (${named}) don't say which column`}
        {column ? "." : ": pick which column its amounts go in."}
      </p>
    );
  }
  return (
    <>
      <p className="mt-2 text-xs leading-5 text-ink-muted">
        {column === programs.column ? "Picked" : `Its programs say ${REBATE_COLUMN_HEADINGS[programs.column]} (${REBATE_COLUMN_LETTERS[programs.column]})`} from its
        program{programs.programs.length === 1 ? "" : "s"}: {named}.
      </p>
      {said.length > 1 && (
        <p className="mt-1 text-sm text-trail">
          Its lines&apos; programs aren&apos;t all one kind ({said.map(([kind, count]) => `${REBATE_COLUMN_HEADINGS[kind]} on ${plural(count, "line", "lines")}`).join(", ")}): all its amounts go in the column picked.
        </p>
      )}
    </>
  );
}
