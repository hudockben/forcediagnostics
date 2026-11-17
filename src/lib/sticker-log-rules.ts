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

// --- Stock on hand ------------------------------------------------------------

// How many of each are on hand: the number counted on the shelf (plus any
// received since), less each one logged after that count. A kind nobody
// has counted isn't tracked, and never warns. Below LOW_STOCK_BELOW left,
// the tab and the log say it's getting low.
export const LOW_STOCK_BELOW = 10;
export const MAX_STOCK = 100_000;

export const STOCK_MODES = ["received", "counted"] as const;
export type StockMode = (typeof STOCK_MODES)[number];

export type StockUpdate = { kind: EntryKind; mode: StockMode; quantity: number };

// What the stock form sends, checked: what it is, received (added to what's
// on hand) or counted (what's on the shelf now), and how many.
export function checkStockUpdate(input: { kind: unknown; mode: unknown; quantity: unknown }): { update: StockUpdate } | { error: string } {
  const kind = parseKindFilter(input.kind);
  if (!kind) return { error: "Pick what it is: stickers, or Class 1 or Class 2 plates." };
  const mode = (STOCK_MODES as readonly unknown[]).includes(input.mode) ? (input.mode as StockMode) : null;
  if (!mode) return { error: "Pick whether these were received or counted on hand." };
  const text = String(input.quantity ?? "").replace(/,/g, "").trim();
  if (!/^\d+$/.test(text)) return { error: "Enter how many, as a whole number." };
  const quantity = Number(text);
  if (mode === "received" && quantity === 0) return { error: "Enter how many were received." };
  if (quantity > MAX_STOCK) return { error: `That's more than ${MAX_STOCK.toLocaleString("en-US")}.` };
  return { update: { kind, mode, quantity } };
}

export type StockLevel = {
  kind: EntryKind;
  // On hand when last counted, plus any received since.
  counted: number;
  countedAt: Date;
  // Logged since that count.
  used: number;
};

// Left on the shelf; never below none (more logged than counted means a
// delivery wasn't added or the count is off).
export const stockLeft = (level: Pick<StockLevel, "counted" | "used">) => Math.max(0, level.counted - level.used);
export const isLowStock = (level: Pick<StockLevel, "counted" | "used">) => level.counted - level.used < LOW_STOCK_BELOW;

// "1 sticker", "7 stickers", "1 Class 1 plate", "0 Class 2 plates".
export const stockWords = (kind: EntryKind, count: number) =>
  `${count.toLocaleString("en-US")} ${entryWords(classOf(kind))}${count === 1 ? "" : "s"}`;

const listWords = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

// What's getting low, in the log's order (stickers, then each class of
// plates); empty when nothing counted is.
export const lowStock = (levels: StockLevel[]) =>
  ENTRY_KINDS.flatMap((kind) => levels.filter((level) => level.kind === kind && isLowStock(level)));

// "Getting low: 7 stickers and 0 Class 2 plates left." for the log, the
// tab's badge and a screen reader; null when nothing counted is low.
export function lowStockMessage(levels: StockLevel[]): string | null {
  const low = lowStock(levels);
  if (low.length === 0) return null;
  return `Getting low: ${listWords(low.map((level) => stockWords(level.kind, stockLeft(level))))} left.`;
}
