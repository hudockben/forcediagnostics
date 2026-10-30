// System Admin > Sticker & Plate log: what an entry holds and how what's
// typed is checked. No server imports, so the form checks a sticker number
// the way the server does.

export const PLATE_CLASSES = [1, 2] as const;
export type PlateClass = (typeof PLATE_CLASSES)[number];

export const PLATE_CLASS_LABELS: Record<PlateClass, string> = { 1: "Class 1", 2: "Class 2" };

export const MAX_STICKER_LENGTH = 40;
export const STICKER_LOG_PAGE_SIZE = 25;

export const isPlateClass = (value: unknown): value is PlateClass => PLATE_CLASSES.includes(Number(value) as PlateClass) && String(value).trim() !== "";

// " #a 12-345 " -> "A 12-345": upper-cased, spaces evened out, without a
// "#" in front, or "No." or "No" and a space before a digit ("No. 77001",
// "No 77001"). Letters that are part of the number stay: "NOR-1234" is
// NOR-1234.
export function normalizeSticker(text: unknown) {
  return String(typeof text === "string" ? text : "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:#\s*|no\.\s*|no\s+(?=\d))/i, "")
    .toUpperCase();
}

// A sticker number without its spaces, dashes, dots and slashes: "A 12-345",
// "A12345" and "A-12345" are one sticker typed three ways. The log keeps
// each number once by this (a unique index on the same expression,
// drizzle/0034_sticker_number_key.sql), and search finds by it.
export const stickerKey = (stickerNumber: string) => normalizeSticker(stickerNumber).replace(/[^A-Z0-9]/g, "");

export type StickerEntryFields = { stickerNumber: string; plateClass: PlateClass };

// What the form sends, checked.
export function checkStickerEntry(input: { stickerNumber: unknown; plateClass: unknown }): { entry: StickerEntryFields } | { error: string } {
  const stickerNumber = normalizeSticker(input.stickerNumber);
  if (!stickerNumber) return { error: "Enter the sticker number." };
  if (stickerNumber.length > MAX_STICKER_LENGTH) return { error: "That sticker number is too long." };
  if (!/^[A-Z0-9][A-Z0-9 ./-]*$/.test(stickerNumber)) {
    return { error: "A sticker number is letters and digits (dashes, dots and slashes are fine)." };
  }
  if (!isPlateClass(input.plateClass)) return { error: "Pick the plate classification: 1 or 2." };
  return { entry: { stickerNumber, plateClass: Number(input.plateClass) as PlateClass } };
}

// ?class= from the address: 1, 2, or every class.
export const parseClassFilter = (value: unknown): PlateClass | null =>
  typeof value === "string" && isPlateClass(value) ? (Number(value) as PlateClass) : null;

export type StickerLogRow = {
  stickerNumber: string;
  customerName: string;
  plateClass: PlateClass;
  createdAt: Date;
  createdBy: string | null;
};

// The log as CSV, for a spreadsheet or a report: one row per sticker, the
// date as the shop writes it. It starts with a byte order mark so Excel
// reads it as UTF-8.
export function stickerLogCsv(rows: StickerLogRow[], timeZone = "America/New_York"): string {
  // A cell starting with = + - or @ is a formula to Excel: an apostrophe in
  // front keeps it text.
  const field = (value: string) => {
    const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const day = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  const lines = [
    "Sticker #,Customer Name,Plate Classification,Logged,Logged by",
    ...rows.map((row) =>
      [row.stickerNumber, row.customerName, String(row.plateClass), day.format(row.createdAt), row.createdBy ?? ""].map(field).join(","),
    ),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
