"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Notice } from "@/components/app/ui";
import { inputBaseClass, primaryLinkClass } from "@/components/hud";
import { formatDay, formatMoney, parseMoney, type Cents } from "@/lib/nusr-rules";
import type { UnitLookup } from "@/lib/unit-list";
import { invoiceAddsUp, modelFromDescription, moneyBox, type InvoiceKind, type InvoiceUnit, type UnitFields, type UnitInvoice } from "@/lib/unit-list-rules";
import { checkVin } from "@/lib/vin";

import { readUnitInvoiceFile, type ReadProgress } from "../rebates/reader";
import { addStockUnitsAction, lookUpUnitsAction } from "./actions";

// New invoices, at the top of the Unit List, in the manager's browser:
// Polaris's whole goods invoices dropped anywhere on the page (or chosen)
// are read here (../rebates/reader.ts: a PDF's own text, or OCR on a scan,
// often several invoices in one file), and each file's units shown on a
// card of their own to check: the model (named as the shop named it before,
// when it has), the VIN (put right from the model number and the check
// digit, with what else it could be when that isn't sure), the day it was
// received, the cost (the invoice's Unit Price) and the list price to fill
// in. Add puts them on the list under it.

type Values = { unitYear: string; model: string; vin: string; receivedOn: string; cost: string; listPrice: string; notes: string };
type ModelFrom = "invoice" | "typed" | NonNullable<UnitLookup["model"]>["from"];

type Row = {
  key: string;
  unit: InvoiceUnit;
  invoiceDate: string | null;
  values: Values;
  modelFrom: ModelFrom;
  lookup: UnitLookup | null;
  // Ticked to add (a unit can be left off).
  take: boolean;
  added: { id: string } | null;
  problem: { error: string; field?: keyof UnitFields } | null;
};

type Card = {
  id: string;
  fileName: string;
  // What says it's the same file dropped again: its invoices, or the file.
  sameAs: string;
  scanned: boolean;
  invoices: UnitInvoice[];
  rows: Row[];
  lookup: { state: "looking" } | { state: "done" } | { state: "failed"; error: string };
  adding: boolean;
  error: string | null;
};

// The page's one file box, which Choose invoices (at the top of the page)
// opens too.
const FILE_INPUT = "unit-list-file";

export function ChooseInvoicesButton() {
  return (
    <button type="button" onClick={() => document.getElementById(FILE_INPUT)?.click()} className={primaryLinkClass} data-unit-list-choose>
      Choose invoices
    </button>
  );
}

type Reading = { fileName: string; progress: ReadProgress; queued: number };

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const inWords = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const smallButtonClass =
  "inline-flex min-h-10 items-center rounded-lg border border-glow/30 px-3 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";
const linkButtonClass = "text-left text-glow/90 hover:text-glow hover:underline focus-visible:underline focus-visible:outline-none";
const boxClass = `${inputBaseClass} mt-1 h-11 text-sm`;

function progressText({ step, done, pages }: ReadProgress) {
  if (step === "opening") return "Opening…";
  return pages ? `Reading page ${Math.min(done + 1, pages)} of ${pages}…` : "Reading…";
}

// What a box holds as an amount; null when blank or not an amount.
const centsOf = (text: string): Cents | null => {
  const read = parseMoney(text);
  return "error" in read ? null : read.cents;
};

const KIND_WORDS: Record<InvoiceKind, string> = { wholeGoods: "whole goods", parts: "parts (PG&A)", rebate: "rebate", other: "" };

// The units on a file's invoices, as rows to check: the model from
// Polaris's description until the shop's own name for it is found, the day
// it's dropped as the day it was received, the cost as read.
function rowsOf(cardId: string, invoices: readonly UnitInvoice[], today: string): Row[] {
  return invoices.flatMap((invoice) =>
    invoice.units.map(
      (unit): Row => ({
        key: `${cardId}-${unit.index}`,
        unit,
        invoiceDate: invoice.date,
        values: {
          unitYear: unit.year === null ? "" : String(unit.year),
          model: modelFromDescription(unit.description),
          vin: unit.vin?.vin ?? "",
          receivedOn: today,
          cost: unit.cost.cents === null ? "" : moneyBox(unit.cost.cents),
          listPrice: "",
          notes: "",
        },
        modelFrom: "invoice",
        lookup: null,
        take: true,
        added: null,
        problem: null,
      }),
    ),
  );
}

export function NewUnits({ today }: { today: string }) {
  const router = useRouter();
  const [cards, setCards] = useState<Card[]>([]);
  const [reading, setReading] = useState<Reading | null>(null);
  const [problems, setProblems] = useState<{ fileName: string; error: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const known = useRef(new Set<string>());
  const stop = useRef<AbortController | null>(null);
  const section = useRef<HTMLElement>(null);

  // Reading stops when the page goes.
  useEffect(() => {
    const controller = new AbortController();
    stop.current = controller;
    return () => controller.abort();
  }, []);

  const updateCard = (id: string, change: (card: Card) => Card) => setCards((list) => list.map((card) => (card.id === id ? change(card) : card)));

  // On the list already, sold in the NUSR, the shop's name for the model,
  // and the last list price.
  async function lookUp(card: Card) {
    updateCard(card.id, (old) => ({ ...old, lookup: { state: "looking" } }));
    const items = card.rows.map((row) => ({ key: row.key, vin: row.values.vin, modelNumber: row.unit.modelNumber, description: row.unit.description }));
    const result = await lookUpUnitsAction(items).catch(() => ({ error: "The connection dropped. Check it, then look the units up again." }));
    if ("error" in result) {
      updateCard(card.id, (old) => ({ ...old, lookup: { state: "failed", error: result.error } }));
      return;
    }
    const byKey = new Map(result.units.map((found) => [found.key, found]));
    updateCard(card.id, (old) => ({
      ...old,
      lookup: { state: "done" },
      rows: old.rows.map((row) => {
        const found = byKey.get(row.key);
        if (!found) return row;
        // The shop's own name for the model, unless one's been typed.
        const named = found.model !== null && row.modelFrom !== "typed";
        return {
          ...row,
          lookup: found,
          values: named ? { ...row.values, model: found.model!.name } : row.values,
          modelFrom: named ? found.model!.from : row.modelFrom,
          take: found.onList ? false : row.take,
        };
      }),
    }));
  }

  // Each file dropped, read one after another.
  async function readFiles(files: File[]) {
    const controller = stop.current;
    if (files.length === 0 || !controller) return;
    if (reading) {
      setProblems((list) => [...list, ...files.map((file) => ({ fileName: file.name, error: "Another file was being read: drop this one again once it's done." }))]);
      return;
    }
    // New invoices, where it's read, is at the top: brought back into view
    // when the file was dropped further down (on the list, say).
    const box = section.current?.getBoundingClientRect();
    if (box && (box.top < 0 || box.top > window.innerHeight - 160)) section.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    for (const [index, file] of files.entries()) {
      const queued = files.length - index - 1;
      setReading({ fileName: file.name, progress: { step: "opening", done: 0, pages: 0 }, queued });
      const result = await readUnitInvoiceFile(file, (progress) => setReading({ fileName: file.name, progress, queued }), controller.signal);
      if (controller.signal.aborted) return;
      if ("error" in result) {
        setProblems((list) => [...list, { fileName: file.name, error: result.error }]);
        continue;
      }
      const { invoices, scanned } = result;
      const units = invoices.flatMap((invoice) => invoice.units);
      if (units.length === 0) {
        const kinds = invoices.filter((invoice) => invoice.kind !== "wholeGoods" && invoice.kind !== "other");
        setProblems((list) => [
          ...list,
          {
            fileName: file.name,
            error: kinds.length
              ? `No units on it: it has ${inWords(kinds.map((invoice) => `${KIND_WORDS[invoice.kind]} invoice${invoice.number ? ` ${invoice.number}` : ""}`))}. Drop the whole goods invoice for a unit.`
              : "No units were found on it: a whole goods invoice has the model number in its Part column and the VIN on the line under it.",
          },
        ]);
        continue;
      }
      const numbers = invoices.filter((invoice) => invoice.units.length > 0).map((invoice) => invoice.number);
      const sameAs = numbers.every(Boolean) ? `invoices:${[...numbers].sort().join(",")}` : `file:${file.name}:${file.size}`;
      if (known.current.has(sameAs)) {
        setProblems((list) => [...list, { fileName: file.name, error: "It's here already." }]);
        continue;
      }
      known.current.add(sameAs);
      // Short, so its rows' keys ("1a2b3c4d-1") are too.
      const id = crypto.randomUUID().slice(0, 8);
      const card: Card = { id, fileName: file.name, sameAs, scanned, invoices, rows: rowsOf(id, invoices, today), lookup: { state: "looking" }, adding: false, error: null };
      setCards((list) => [...list, card]);
      void lookUp(card);
    }
    setReading(null);
    if (input.current) input.current.value = "";
  }

  function close(card: Card) {
    known.current.delete(card.sameAs);
    setCards((list) => list.filter((one) => one.id !== card.id));
  }

  // A file can be dropped anywhere on the page (the list, further down,
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

  // Adds the ticked units (not on the list already, not added yet) as
  // they're checked on the card.
  async function add(card: Card) {
    const rows = card.rows.filter((row) => row.take && !row.added && !row.lookup?.onList);
    if (rows.length === 0) return;
    updateCard(card.id, (old) => ({ ...old, adding: true, error: null, rows: old.rows.map((row) => ({ ...row, problem: null })) }));
    const units = rows.map((row) => ({
      key: row.key,
      ...row.values,
      modelNumber: row.unit.modelNumber ?? "",
      description: row.unit.description,
      engineNumber: row.unit.engineNumber ?? "",
      invoiceNumber: row.unit.invoice ?? "",
      invoiceDate: row.invoiceDate ?? "",
    }));
    const result = await addStockUnitsAction({ fileName: card.fileName, units }).catch(() => ({ error: "The connection dropped. Check it, then add them again." }));
    if ("error" in result) {
      updateCard(card.id, (old) => ({ ...old, adding: false, error: result.error }));
      return;
    }
    if ("problems" in result) {
      const byKey = new Map(result.problems.map((problem) => [problem.key, problem]));
      updateCard(card.id, (old) => ({
        ...old,
        adding: false,
        error: `${plural(result.problems.length, "unit needs", "units need")} fixing first: nothing was added.`,
        rows: old.rows.map((row) => {
          const problem = byKey.get(row.key);
          return problem ? { ...row, problem: { error: problem.error, field: problem.field } } : row;
        }),
      }));
      const first = result.problems[0];
      document.getElementById(`${first.key}-${first.field ?? "model"}`)?.focus();
      return;
    }
    const added = new Map(result.added.map((one) => [one.key, one.id]));
    const already = new Map(result.already.map((one) => [one.key, one]));
    updateCard(card.id, (old) => ({
      ...old,
      adding: false,
      rows: old.rows.map((row) => {
        const id = added.get(row.key);
        if (id) return { ...row, added: { id } };
        const there = already.get(row.key);
        if (there && row.lookup) return { ...row, take: false, lookup: { ...row.lookup, onList: { id: there.id, name: there.name, receivedOn: row.values.receivedOn, soldOn: null } } };
        return row;
      }),
    }));
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {dragging && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-forest-950/70 p-6 backdrop-blur-sm" data-unit-list-dragging>
          <p className="rounded-xl border-2 border-dashed border-glow/60 bg-charcoal-900/90 px-8 py-6 text-center text-base font-medium text-glow">Drop the invoice to read its units</p>
        </div>
      )}
      <section ref={section} className="scroll-mt-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" aria-labelledby="new-units" data-unit-list-new>
        <h2 id="new-units" className="text-base font-semibold text-ink">
          New invoices
        </h2>
        <label
          htmlFor={FILE_INPUT}
          className={`mt-4 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-glow/40 ${
            dragging ? "border-glow/60 bg-glow/10" : "border-white/20 hover:border-white/30"
          }`}
          data-unit-list-drop
        >
          <span className="text-sm font-medium text-ink">{reading ? `Reading ${reading.fileName}…` : "Drop a whole goods invoice here, or choose one"}</span>
          <span className="text-xs text-ink-muted">
            The PDF from the dealer portal (Invoice Print), or a scan or photo of the printout. A scan with several invoices in it is fine: parts and rebate invoices are left out. Anywhere on the page will do.
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
            data-unit-list-file
          />
        </label>
        {reading && (
          <div className="mt-4" role="status" data-unit-list-reading>
            <p className="text-sm text-ink">
              {progressText(reading.progress)}
              {reading.queued > 0 && ` Then ${plural(reading.queued, "more file", "more files")}.`}
            </p>
            {reading.progress.pages > 0 && (
              <div
                role="progressbar"
                aria-label="Pages read"
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

      {cards.map((card) => (
        <UnitsCard
          key={card.id}
          card={card}
          today={today}
          onChange={(change) => updateCard(card.id, change)}
          onLookUp={() => void lookUp(card)}
          onAdd={() => void add(card)}
          onClose={() => close(card)}
        />
      ))}
    </div>
  );
}

// --- A file's units -------------------------------------------------------------

function UnitsCard({
  card,
  today,
  onChange,
  onLookUp,
  onAdd,
  onClose,
}: {
  card: Card;
  today: string;
  onChange: (change: (card: Card) => Card) => void;
  onLookUp: () => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const setRow = (key: string, change: (row: Row) => Row) => onChange((old) => ({ ...old, rows: old.rows.map((row) => (row.key === key ? change(row) : row)) }));
  const withUnits = card.invoices.filter((invoice) => invoice.units.length > 0);
  const leftOut = card.invoices.filter((invoice) => invoice.units.length === 0);
  const toAdd = card.rows.filter((row) => row.take && !row.added && !row.lookup?.onList);
  const added = card.rows.filter((row) => row.added).length;
  const listed = card.rows.filter((row) => row.added || row.lookup?.onList).length;
  const cost = toAdd.reduce((sum, row) => sum + (centsOf(row.values.cost) ?? 0), 0);
  const noList = toAdd.filter((row) => !row.values.listPrice.trim()).length;
  const dates = [...new Set(withUnits.map((invoice) => invoice.date).filter((date): date is string => date !== null))];
  const invoiceDate = dates.length === 1 ? dates[0] : null;
  const setReceived = (day: string) => onChange((old) => ({ ...old, rows: old.rows.map((row) => (row.added ? row : { ...row, values: { ...row.values, receivedOn: day } })) }));

  return (
    <section className="scroll-mt-4 space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" aria-label={card.fileName} data-unit-list-card={card.fileName}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold break-words text-ink">
            {withUnits.length === 1 && withUnits[0].number ? `Invoice ${withUnits[0].number}` : card.fileName}
            {invoiceDate && <span className="font-normal text-ink-muted"> · {formatDay(invoiceDate)}</span>}
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {[
              withUnits.length > 1 ? `Invoices ${inWords(withUnits.map((invoice) => invoice.number ?? "(no number read)"))}` : withUnits[0]?.number ? card.fileName : null,
              plural(card.rows.length, "unit", "units"),
              card.scanned ? "read from a scan" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none" data-unit-list-close>
          Close
        </button>
      </div>

      {leftOut.length > 0 && (
        <p className="text-sm text-ink-muted" data-unit-list-left-out>
          Left out, with no units on {leftOut.length === 1 ? "it" : "them"}:{" "}
          {inWords(leftOut.map((invoice) => [KIND_WORDS[invoice.kind] ? `${KIND_WORDS[invoice.kind]} invoice` : "invoice", invoice.number].filter(Boolean).join(" ")))}.
        </p>
      )}
      {withUnits.map((invoice) => {
        const { sum, charges, total, apart } = invoiceAddsUp(invoice);
        if (apart === null || apart === 0) return null;
        return (
          <Notice key={invoice.number ?? invoice.pages.join(",")} tone="trail">
            {invoice.number ? `Invoice ${invoice.number}` : "An invoice"}&apos;s total is {formatMoney(total)}, but its units come to {formatMoney(sum)}
            {charges ? ` and its other charges to ${formatMoney(charges)}` : ""}: check the costs against the invoice.
          </Notice>
        );
      })}
      {card.lookup.state === "failed" && (
        <div className="flex flex-wrap items-center gap-3">
          <Notice tone="trail">{card.lookup.error}</Notice>
          <button type="button" onClick={onLookUp} className={smallButtonClass}>
            Look them up again
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="text-ink-muted">Received:</span>
        <button type="button" onClick={() => setReceived(today)} className={linkButtonClass}>
          all today ({formatDay(today)})
        </button>
        {invoiceDate && invoiceDate !== today && (
          <button type="button" onClick={() => setReceived(invoiceDate)} className={linkButtonClass} data-unit-list-invoice-date>
            all on the invoice date ({formatDay(invoiceDate)})
          </button>
        )}
      </div>

      <ul className="space-y-3">
        {card.rows.map((row) => (
          <UnitRow key={row.key} row={row} looking={card.lookup.state === "looking"} onChange={(change) => setRow(row.key, change)} />
        ))}
      </ul>

      {card.error && (
        <p role="alert" className="text-sm text-trail">
          {card.error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-4">
        <div className="min-w-0 space-y-1 text-sm">
          {toAdd.length > 0 ? (
            <p className="text-ink">
              {plural(toAdd.length, "unit", "units")} to add, costing {formatMoney(cost)}
              {noList > 0 && <span className="text-ink-muted">; {plural(noList, "has", "have")} no list price yet (it can be filled in later too)</span>}.
            </p>
          ) : (
            <p className="text-ink-muted">{listed === card.rows.length ? "Every unit is on the list." : "No units ticked to add."}</p>
          )}
          {added > 0 && toAdd.length > 0 && <p className="text-xs text-ink-muted">{plural(added, "unit is", "units are")} added already.</p>}
        </div>
        <button type="button" onClick={onAdd} disabled={toAdd.length === 0 || card.adding || card.lookup.state === "looking"} className={primaryLinkClass} data-unit-list-add>
          {card.adding ? "Adding…" : `Add ${plural(toAdd.length, "unit", "units")} to the list`}
        </button>
      </div>
    </section>
  );
}

const MODEL_FROM: Record<ModelFrom, string> = {
  invoice: "Polaris's description: type the name you use, and the next one with this model number gets it.",
  typed: "",
  list: "As the last one with this model number was named on the list.",
  paint: "From the same model in another paint on the list.",
  nusr: "As the NUSR named the last one of this model sold.",
  models: "From Polaris's model list (System Admin > Manuals).",
};

function UnitRow({ row, looking, onChange }: { row: Row; looking: boolean; onChange: (change: (row: Row) => Row) => void }) {
  const { unit, values, lookup, added, problem } = row;
  const done = added !== null || Boolean(lookup?.onList);
  const set = (field: keyof Values, value: string) =>
    onChange((old) => ({ ...old, values: { ...old.values, [field]: value }, modelFrom: field === "model" ? "typed" : old.modelFrom, problem: old.problem?.field === field ? null : old.problem }));
  const id = (field: keyof UnitFields) => `${row.key}-${field}`;
  const wrong = (field: keyof UnitFields) => problem?.field === field;
  const vin = checkVin(values.vin);
  const read = unit.vin;
  const readAsShown = read !== null && values.vin === read.vin;
  const listPrice = lookup?.listPrice;
  const details = [unit.modelNumber, unit.description, unit.engineNumber && `Engine # ${unit.engineNumber}`, unit.invoice && `Invoice ${unit.invoice}`, `page ${unit.page}`].filter(Boolean);

  return (
    <li className={`rounded-lg border p-4 ${added ? "border-glow/30 bg-glow/5" : "border-white/10"}`} data-unit-list-row={values.vin}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-ink">
          <input
            type="checkbox"
            checked={row.take && !done}
            disabled={done}
            onChange={(event) => {
              const take = event.currentTarget.checked;
              onChange((old) => ({ ...old, take }));
            }}
            className="size-4 accent-glow"
          />
          {added ? "Added" : lookup?.onList ? "On the list already" : "Add this unit"}
        </label>
        <p className="text-xs break-words text-ink-muted">{details.join(" · ")}</p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-6 lg:grid-cols-12">
        <div className="sm:col-span-1 lg:col-span-1">
          <label htmlFor={id("unitYear")} className="text-xs font-medium text-ink-muted">
            Year
          </label>
          <input id={id("unitYear")} value={values.unitYear} inputMode="numeric" maxLength={4} disabled={done} aria-invalid={wrong("unitYear") || undefined} onChange={(event) => set("unitYear", event.currentTarget.value)} className={boxClass} />
        </div>
        <div className="sm:col-span-5 lg:col-span-5">
          <label htmlFor={id("model")} className="text-xs font-medium text-ink-muted">
            Model
          </label>
          <input id={id("model")} value={values.model} maxLength={120} disabled={done} aria-invalid={wrong("model") || undefined} onChange={(event) => set("model", event.currentTarget.value)} className={boxClass} data-unit-list-model />
          {!done && (looking && row.modelFrom === "invoice" ? <p className="mt-1 text-xs text-ink-muted">Looking for the name you use…</p> : MODEL_FROM[row.modelFrom] && <p className="mt-1 text-xs text-ink-muted">{MODEL_FROM[row.modelFrom]}</p>)}
        </div>
        <div className="sm:col-span-3 lg:col-span-3">
          <label htmlFor={id("vin")} className="text-xs font-medium text-ink-muted">
            VIN
          </label>
          <input
            id={id("vin")}
            value={values.vin}
            maxLength={30}
            disabled={done}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={wrong("vin") || (vin.status === "ok" && !vin.checkDigitOk) || undefined}
            onChange={(event) => set("vin", event.currentTarget.value.toUpperCase())}
            className={`${boxClass} font-mono tracking-wide`}
            data-unit-list-vin
          />
          {!done && (
            <div className="mt-1 text-xs">
              {vin.status === "ok" ? (
                vin.checkDigitOk ? (
                  readAsShown && !read.sure ? (
                    <p className="text-trail">Read from a scan and not sure: check it against the unit.</p>
                  ) : (
                    <p className="text-glow">Check digit matches.</p>
                  )
                ) : (
                  <p className="text-trail">Its check digit doesn&apos;t match: check it against the unit.</p>
                )
              ) : vin.status === "empty" ? (
                <p className="text-trail">No VIN was read: type it in.</p>
              ) : (
                <p className="text-trail">{vin.message}</p>
              )}
              {read && read.others.length > 0 && (
                <p className="mt-0.5 text-ink-muted">
                  Could also be{" "}
                  {read.others.map((other, index) => (
                    <span key={other}>
                      {index > 0 && " or "}
                      <button type="button" onClick={() => set("vin", other)} className={`${linkButtonClass} font-mono`}>
                        {other}
                      </button>
                    </span>
                  ))}
                  {read.others.includes(values.vin) || !readAsShown ? (
                    <>
                      {" "}
                      or{" "}
                      <button type="button" onClick={() => set("vin", read.vin)} className={`${linkButtonClass} font-mono`}>
                        {read.vin}
                      </button>
                    </>
                  ) : null}
                  .
                </p>
              )}
            </div>
          )}
        </div>
        <div className="sm:col-span-3 lg:col-span-3">
          <label htmlFor={id("receivedOn")} className="text-xs font-medium text-ink-muted">
            Received
          </label>
          <input id={id("receivedOn")} type="date" value={values.receivedOn} disabled={done} aria-invalid={wrong("receivedOn") || undefined} onChange={(event) => set("receivedOn", event.currentTarget.value)} className={boxClass} />
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor={id("cost")} className="text-xs font-medium text-ink-muted">
            Cost
          </label>
          <input id={id("cost")} value={values.cost} inputMode="decimal" disabled={done} aria-invalid={wrong("cost") || undefined} onChange={(event) => set("cost", event.currentTarget.value)} className={`${boxClass} font-mono`} data-unit-list-cost />
          {!done && !unit.cost.sure && values.cost === moneyBox(unit.cost.cents ?? -1) && <p className="mt-1 text-xs text-trail">Read from a scan: check it against the invoice.</p>}
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor={id("listPrice")} className="text-xs font-medium text-ink-muted">
            List Price
          </label>
          <input id={id("listPrice")} value={values.listPrice} inputMode="decimal" disabled={done} aria-invalid={wrong("listPrice") || undefined} onChange={(event) => set("listPrice", event.currentTarget.value)} className={`${boxClass} font-mono`} data-unit-list-list-price />
          {!done && listPrice && !values.listPrice.trim() && (
            <button type="button" onClick={() => set("listPrice", moneyBox(listPrice.cents))} className={`${linkButtonClass} mt-1 text-xs`}>
              Use {formatMoney(listPrice.cents)}, the last one&apos;s ({formatDay(listPrice.receivedOn)})
            </button>
          )}
        </div>
        <div className="sm:col-span-2 lg:col-span-6">
          <label htmlFor={id("notes")} className="text-xs font-medium text-ink-muted">
            Notes
          </label>
          <input id={id("notes")} value={values.notes} maxLength={1000} disabled={done} aria-invalid={wrong("notes") || undefined} onChange={(event) => set("notes", event.currentTarget.value)} className={boxClass} placeholder="Presold to…, on the floor, at the shop…" />
        </div>
      </div>

      <div className="mt-3 space-y-1 text-sm empty:hidden">
        {problem && (
          <p role="alert" className="text-trail">
            {problem.error}
          </p>
        )}
        {added && (
          <p className="text-glow">
            Added to the list.{" "}
            <Link href={`/unit-list/${added.id}`} className="underline">
              Open it
            </Link>
          </p>
        )}
        {!added && lookup?.onList && (
          <p className="text-ink-muted">
            <Link href={`/unit-list/${lookup.onList.id}`} className="text-glow hover:underline">
              {lookup.onList.name}
            </Link>{" "}
            has this VIN on the list already, received {formatDay(lookup.onList.receivedOn)}
            {lookup.onList.soldOn ? ` and sold ${formatDay(lookup.onList.soldOn)}` : ""}.
          </p>
        )}
        {lookup?.sold && (
          <p className="text-ink-muted" data-unit-list-sold>
            The NUSR has it sold on {formatDay(lookup.sold.soldOn)} to {lookup.sold.customerName}
            {lookup.sold.salesperson ? ` (${lookup.sold.salesperson})` : ""}: it&apos;s on the list as sold, not in stock.
          </p>
        )}
      </div>
    </li>
  );
}

