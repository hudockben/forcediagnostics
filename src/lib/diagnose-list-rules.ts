// The Diagnose tab's list of diagnoses: its search and its pages. No server
// imports, so the search box in the browser cleans what it sends the way the
// server reads it.

import { cutText } from "@/lib/manual-rules";

export const LIST_PAGE_SIZE = 8;
export const MAX_LIST_QUERY_LENGTH = 100;
// Words past this many are left out of a search.
export const MAX_LIST_WORDS = 8;

// The search as it goes in the address: one space between words, no longer
// than the box allows.
export function cleanListQuery(text: string) {
  return cutText(text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim(), MAX_LIST_QUERY_LENGTH).trim();
}

// Every word in a search, each once, without the punctuation round it. A
// word with no letter or digit in it ("—", "-", pasted between a unit and
// its complaint) is left out.
function searchWords(query: string) {
  const words = new Set<string>();
  for (const part of cleanListQuery(query).split(" ")) {
    const word = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    if (word) words.add(word);
  }
  return [...words];
}

// "RZR  misfire, Mike" -> ["rzr", "misfire", "mike"]: the words a diagnosis
// has to have somewhere to be found, in any order; the first MAX_LIST_WORDS
// of them. None means no search at all (the whole list).
export function listSearchWords(query: string): string[] {
  return searchWords(query).slice(0, MAX_LIST_WORDS);
}

// Whether a search has more words than it uses, so the count can say so.
export function listSearchIsCut(query: string) {
  return searchWords(query).length > MAX_LIST_WORDS;
}

// A LIKE pattern for the word anywhere in a text, with LIKE's own
// characters (%, _ and the backslash that escapes them) taken as typed.
export function containsPattern(word: string) {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ?page= from the address: a whole number from 1; anything else is page 1.
export function parsePage(value: string | string[] | undefined) {
  const text = (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  if (!/^\d+$/.test(text)) return 1;
  return Math.min(Math.max(1, Number(text)), 1_000_000);
}

export type ListPage = {
  page: number;
  pages: number;
  // Rows to skip, and the rows the page holds counted from 1 ("9–16 of 37";
  // 0 and 0 when there are none).
  offset: number;
  from: number;
  to: number;
};

// The page to show of `total` rows: the one asked for, kept within the pages
// there are, so a page past the end shows the last one.
export function listPage(total: number, asked: number, perPage = LIST_PAGE_SIZE): ListPage {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Math.floor(asked) || 1), pages);
  const offset = (page - 1) * perPage;
  return { page, pages, offset, from: total === 0 ? 0 : offset + 1, to: Math.min(total, offset + perPage) };
}

// The page numbers to offer: the first and last, `around` either side of
// the current one, and null for each gap. A gap that would hide one page
// shows that page instead. pageItems(5, 10) -> [1, null, 4, 5, 6, null, 10].
export function pageItems(page: number, pages: number, around = 1): (number | null)[] {
  const shown = new Set([1, pages]);
  for (let n = page - around; n <= page + around; n++) if (n >= 1 && n <= pages) shown.add(n);
  const items: (number | null)[] = [];
  let last = 0;
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (n - last === 2) items.push(last + 1);
    else if (n - last > 2) items.push(null);
    items.push(n);
    last = n;
  }
  return items;
}

// The list's address for a search and a page; no search and page 1 are
// left out, so the plain list stays /diagnose. System Admin's lists page
// the same way, at their own path, which can carry a filter of its own
// ("/admin/sticker-plate-log?class=1").
export function listHref(query: string, page = 1, path = "/diagnose") {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `${path}${path.includes("?") ? "&" : "?"}${search}` : path;
}
