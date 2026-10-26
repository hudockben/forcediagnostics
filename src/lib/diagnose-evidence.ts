// How sure the Diagnose screen says each thing is. A likely cause shows
// Claude's confidence by its heat bar, with one quiet line of what that
// rests on: the manual pages and web pages the server matched its citations
// to (counted, never taken on Claude's word), then what Claude says besides
// (the tech's report, fault codes, the checks done, experience). A step
// shows where its spec or procedure comes from, at one of three levels: the
// shop's service manual, a web source, or general knowledge (verify first).
// Pure (no React, no database): shared by the panel and the tests.

import type { BasedOn, SourceView } from "@/lib/diagnose-rules";

// A web page as a tech would call it: a forum thread (where owners and
// techs report fixes) or any other web page.
const FORUM = /forum|reddit\.com|\/threads?\/|\/t\/|\/topics?\/|\/community\/|\bcommunity\.|\/boards?\//i;
export const webKind = (source: { url: string; title?: string }): "forum post" | "web page" =>
  FORUM.test(source.url) || /\bforums?\b/i.test(source.title ?? "") ? "forum post" : "web page";

// The words for what Claude says a confidence rests on, besides the pages
// it cites (those are counted from the checked sources instead).
const BASED_ON_WORDS: Partial<Record<BasedOn, string>> = {
  tech_report: "your report",
  fault_codes: "fault codes",
  step_results: "your check results",
  experience: "experience",
};

const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// "2 manual pages · 1 forum post · your report": the manual pages (each
// page once), the web pages by kind, then Claude's other grounds, in that
// order. Manual and web in based_on add nothing by themselves: a page counts
// only when its citation held. A cause with nothing else to go on says
// general knowledge (evidenceLine is null when there's nothing at all).
export function evidenceParts(cause: { sources: SourceView[]; basedOn?: BasedOn[] }): string[] {
  const pages = new Set<string>();
  const web = { "forum post": 0, "web page": 0 };
  for (const source of cause.sources) {
    if (source.type === "manual") pages.add(`${source.manualId.toLowerCase()}:${source.page}`);
    else if (source.type === "web") web[webKind(source)] += 1;
  }
  const parts = [
    pages.size > 0 ? counted(pages.size, "manual page") : null,
    web["forum post"] > 0 ? counted(web["forum post"], "forum post") : null,
    web["web page"] > 0 ? counted(web["web page"], "web page") : null,
    ...(cause.basedOn ?? []).map((item) => BASED_ON_WORDS[item] ?? null),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0 && cause.sources.some((source) => source.type === "general")) return ["general knowledge"];
  return parts;
}

export function evidenceLine(cause: { sources: SourceView[]; basedOn?: BasedOn[] }): string | null {
  const parts = evidenceParts(cause);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Where a step's spec or procedure comes from: a page of the shop's manuals
// the server matched (high), a web source and no manual page (medium), or
// Claude's general knowledge (verify first). A spec with no manual page
// behind it is general whatever else it cites: the web is for patterns and
// fixes, not specs (the prompt says so, and its chip says to verify it).
export const SOURCE_LEVELS = ["manual", "web", "general"] as const;
export type SourceLevel = (typeof SOURCE_LEVELS)[number];

export function sourceLevel(check: { expected: string; sources: SourceView[]; unverifiedSpec?: boolean }): SourceLevel {
  const manual = check.sources.some((source) => source.type === "manual");
  if (check.unverifiedSpec || (check.expected.trim() !== "" && !manual)) return "general";
  if (manual) return "manual";
  return check.sources.some((source) => source.type === "web") ? "web" : "general";
}

// How each level reads on a step: its word, and the longer say for a title
// and screen readers. (A spec's chip says Verify rather than General: it's
// the number to check.)
export const SOURCE_LEVEL_LABELS: Record<SourceLevel, { label: string; detail: string }> = {
  manual: { label: "Manual", detail: "From your service manual" },
  web: { label: "Web", detail: "From a web source, not your manuals" },
  general: { label: "General", detail: "General knowledge, not from your manuals: verify before you rely on it" },
};
