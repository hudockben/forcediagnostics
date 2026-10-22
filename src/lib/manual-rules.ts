// Rules for the manual library shared by the uploader in the browser and the
// server. Kept free of database imports so browser code can use it.

export const MANUAL_STATUSES = ["uploading", "extracting", "ready"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

// Big enough for any service manual; the browser reads the whole file to
// hash it and pull out its text.
export const MAX_MANUAL_BYTES = 500 * 1024 * 1024;
export const MAX_MANUAL_PAGES = 20000;

// Text kept per page. Dense wiring diagrams run to a few thousand
// characters; anything past this is cut off.
export const MAX_PAGE_TEXT_LENGTH = 50000;

// Pages are sent to the server in batches. Server Action requests are
// capped at 1 MB, so batches stay at about half that.
export const PAGE_BATCH_BYTES = 512 * 1024;
export const MAX_PAGES_PER_BATCH = 500;

export type PageText = { pageNumber: number; text: string };

// "001 - Sportsman 570 Service Manual.pdf" -> "Sportsman 570 Service Manual".
// The numbering is what the dealer portal download adds; a leading year like
// "2019 - RZR" has four digits and stays.
export function titleFromFileName(fileName: string) {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const title = base
    .replace(/\.pdf$/i, "")
    .replace(/^\d{3}\s+-\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return title || base.trim() || "Untitled manual";
}

// Text cut to at most `length` UTF-16 units without splitting a character
// outside the Basic Multilingual Plane (an emoji, say) in half: half of one
// makes encodeURIComponent throw.
export function cutText(text: string, length: number) {
  return text.slice(0, length).replace(/[\ud800-\udbff]$/, "");
}

// The name a manual's PDF opens and saves under: its title, without the
// characters file systems refuse ("2027 RZR Pro R Boost / Pro R Boost 4"
// -> "2027 RZR Pro R Boost - Pro R Boost 4.pdf").
export function pdfFileName(title: string) {
  const name = title
    .replace(/"/g, "'")
    .replace(/\s*[\\/|]+\s*/g, " - ")
    .replace(/[:*?<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${cutText(name, 200).trim() || "Manual"}.pdf`;
}

// Characters ts_headline marks matches with in search snippets. Page text
// never contains them: cleanPageText strips every control character.
export const SNIPPET_START = "\u0002";
export const SNIPPET_STOP = "\u0003";

// Text as stored: no NULs (Postgres text can't hold them; PDFs often have
// them for glyphs with no letter), no other control characters apart from
// tabs and line breaks, spaces tidied, and capped.
export function cleanPageText(text: string) {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_PAGE_TEXT_LENGTH);
}

export type SnippetPart = { text: string; match: boolean };

// Splits a ts_headline snippet into plain and matched parts, so the page can
// render matches as <mark> without treating any of the text as HTML.
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  for (const [index, piece] of snippet.split(SNIPPET_START).entries()) {
    const [matched, rest] = index === 0 ? [null, piece] : splitOnce(piece, SNIPPET_STOP);
    if (matched) parts.push({ text: matched, match: true });
    if (rest) parts.push({ text: rest, match: false });
  }
  return parts;
}

function splitOnce(text: string, separator: string): [string, string] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, ""] : [text.slice(0, at), text.slice(at + separator.length)];
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
