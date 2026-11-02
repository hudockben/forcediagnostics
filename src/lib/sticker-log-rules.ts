// The Sticker & Plate log tab: what an entry holds and how what's typed is
// checked. Each entry is a sticker or a plate the shop hands out, with its
// number and the customer it went to: a plate is Class 1 or Class 2
// (plateClass), a sticker has no class (null). No server imports, so the
// form checks a number the way the server does.

export const PLATE_CLASSES = [1, 2] as const;
export type PlateClass = (typeof PLATE_CLASSES)[number];

// What an entry is, as the form, the filter and the CSV name it.
export const ENTRY_KINDS = ["sticker", "1", "2"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const ENTRY_KIND_LABELS: Record<EntryKind, string> = { sticker: "Sticker", 1: "Class 1 plate", 2: "Class 2 plate" };
export const ENTRY_KIND_PLURALS: Record<EntryKind, string> = { sticker: "Stickers", 1: "Class 1 plates", 2: "Class 2 plates" };

export const kindOf = (plateClass: PlateClass | null): EntryKind => (plateClass === null ? "sticker" : plateClass === 1 ? "1" : "2");
export const classOf = (kind: EntryKind): PlateClass | null => (kind === "sticker" ? null : kind === "1" ? 1 : 2);
// "Sticker", "Class 1 plate" or "Class 2 plate"; in a sentence, "sticker"
// or "Class 1 plate".
export const entryLabel = (plateClass: PlateClass | null) => ENTRY_KIND_LABELS[kindOf(plateClass)];
export const entryWords = (plateClass: PlateClass | null) => (plateClass === null ? "sticker" : `Class ${plateClass} plate`);

export const MAX_STICKER_LENGTH = 40;
export const STICKER_LOG_PAGE_SIZE = 25;

export const isPlateClass = (value: unknown): value is PlateClass => PLATE_CLASSES.includes(Number(value) as PlateClass) && String(value).trim() !== "";

// " #a 12-345 " -> "A 12-345": upper-cased, spaces evened out, without a
// "#" or "No." in front, so the same number typed two ways is one.
export function normalizeSticker(text: unknown) {
  return String(typeof text === "string" ? text : "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:#|no\.?\s*)\s*/i, "")
    .toUpperCase();
}

export type StickerEntryFields = { stickerNumber: string; plateClass: PlateClass | null };

// What the form sends, checked: a number, and what it is ("sticker", or
// 1 or 2 for a plate's class; an import sends null for a sticker).
export function checkStickerEntry(input: { stickerNumber: unknown; plateClass: unknown }): { entry: StickerEntryFields } | { error: string } {
  const stickerNumber = normalizeSticker(input.stickerNumber);
  if (!stickerNumber) return { error: "Enter the sticker or plate number." };
  if (stickerNumber.length > MAX_STICKER_LENGTH) return { error: "That number is too long." };
  if (!/^[A-Z0-9][A-Z0-9 ./-]*$/.test(stickerNumber)) {
    return { error: "A sticker or plate number is letters and digits (dashes, dots and slashes are fine)." };
  }
  if (input.plateClass === null || input.plateClass === "sticker") return { entry: { stickerNumber, plateClass: null } };
  if (!isPlateClass(input.plateClass)) return { error: "Pick what it is: a sticker, or a Class 1 or Class 2 plate." };
  return { entry: { stickerNumber, plateClass: Number(input.plateClass) as PlateClass } };
}

// ?type= from the address: stickers, Class 1 or Class 2 plates, or
// everything.
export const parseKindFilter = (value: unknown): EntryKind | null =>
  typeof value === "string" && (ENTRY_KINDS as readonly string[]).includes(value) ? (value as EntryKind) : null;

export type StickerLogRow = {
  stickerNumber: string;
  customerName: string;
  plateClass: PlateClass | null;
  createdAt: Date;
  createdBy: string | null;
};

// The log as CSV, for a spreadsheet or a report: one row per sticker or
// plate, the date as the shop writes it. It starts with a byte order mark
// so Excel reads it as UTF-8, and comes back in through the import.
export function stickerLogCsv(rows: StickerLogRow[], timeZone = "America/New_York"): string {
  // A cell starting with = + - or @ is a formula to Excel: an apostrophe in
  // front keeps it text.
  const field = (value: string) => {
    const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const day = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  const lines = [
    "Sticker / Plate #,Customer Name,Type,Logged,Logged by",
    ...rows.map((row) =>
      [row.stickerNumber, row.customerName, entryLabel(row.plateClass), day.format(row.createdAt), row.createdBy ?? ""].map(field).join(","),
    ),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
