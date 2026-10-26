// Rules for Diagnose, the chat between a tech and Claude, shared by the
// server and the browser: the shape of Claude's structured reply, checking
// its citations against what the tools actually returned, fault codes, the
// limits, and the cost estimate. Kept free of database imports so browser
// code can use it.

import { inferSystem, listedSystem, type CauseSystem, type UnitVehicle } from "@/lib/diagnose-zones";
import type { UnitSpec } from "@/lib/unit-vehicle";

// The model behind Diagnose. Change it here only: the prompt, tools and
// prices all follow from it.
export const DIAGNOSE_MODEL = "claude-opus-5-5";

export const TURN_STATUSES = ["running", "done", "failed", "stopped"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export const CONVERSATION_STATUSES = ["open", "solved"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const DIAGNOSE_LIMITS = {
  // What a tech can type in one message.
  techText: 4000,
  // Per conversation: after this many messages, or once Claude's prompt has
  // grown past this many tokens, the tech starts a new diagnosis.
  techMessages: 40,
  contextTokens: 300_000,
  // Per tech message. When one is reached the tool result tells Claude to
  // answer with what it has.
  modelRequests: 12,
  pageReads: 30,
  manualSearches: 60,
  unitLookups: 6,
  webSearches: 5,
  // Per tech message, across retries too, counted in attempt_counters.
  messagesPerUserPerHour: 30,
  messagesPerShopPerDay: 500,
  // What the tools hand Claude.
  pageTextCharacters: 8000,
  searchHits: 8,
  // A unit lookup narrows the conversation to at most this many manuals (a
  // whole vehicle line, at most); more than that and it isn't narrowing.
  scopeManuals: 60,
} as const;

export const LIKELIHOODS = ["high", "medium", "low"] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];

export const CAUSE_STATUSES = ["open", "ruled_out", "confirmed"] as const;
export type CauseStatus = (typeof CAUSE_STATUSES)[number];

// How much work a check is, or confirming or ruling out a cause, the way an
// experienced tech tiers it: a quick look (minutes, no tools or teardown),
// a test (a meter, gauge, scan tool or Digital Wrench, or a road test), or
// teardown (panels, covers or parts off, swapping parts). The causes stay
// ranked by likelihood; the checks go quick, then test, then teardown.
export const EFFORTS = ["quick", "test", "teardown"] as const;
export type Effort = (typeof EFFORTS)[number];

// The tiers' headers over an older reply's list of next checks, the short
// tag on each of a cause's steps, and how a cause says what it takes to rule
// it in or out.
export const EFFORT_LABELS: Record<Effort, { heading: string; detail: string; step: string; cause: string }> = {
  quick: { heading: "Quick checks", detail: "minutes, no tools", step: "Quick", cause: "Quick to rule out" },
  test: { heading: "Tests", detail: "meter or scan tool", step: "Test", cause: "Needs a test" },
  teardown: { heading: "Teardown", detail: "parts off", step: "Teardown", cause: "Needs teardown" },
};

// Where a piece of advice comes from, after the server has checked it: a
// page of one of the shop's manuals, a web page from Claude's searches, or
// Claude's own general knowledge.
export type SourceView =
  | { type: "manual"; manualId: string; page: number; title: string }
  | { type: "web"; url: string; title: string }
  | { type: "general" };

export type Cause = {
  title: string;
  // The part of the machine it's in, for the unit graphic. Replies saved
  // before causes carried one don't have it: see causeSystem.
  system?: CauseSystem;
  likelihood: Likelihood;
  why: string;
  status: CauseStatus;
  sources: SourceView[];
  // How much work it is to confirm or rule out. Replies saved before causes
  // carried it don't have it (no chip shows).
  checkEffort?: Effort;
};

export type Check = {
  // Quick, test or teardown. Replies saved before checks carried it don't
  // have it: their checks show as one list, in Claude's order.
  tier?: Effort;
  action: string;
  // The likely causes it confirms or rules out, by their numbers in the
  // list (1 is the first; the drawing's callouts carry the same numbers):
  // it's shown in each of their cards, and an empty list (a check for no
  // cause in particular) under "Start here". Replies saved before checks
  // carried it don't have it: their checks show as a list of their own.
  causes?: number[];
  // Expected values and specs ("0.6-0.8 ohms primary"); blank when none.
  expected: string;
  sources: SourceView[];
  // A spec with no manual page behind it: the screen says to verify it.
  unverifiedSpec: boolean;
};

export type DiagnosisReply = {
  reply: string;
  likelyCauses: Cause[];
  nextChecks: Check[];
  safetyNotes: string[];
  questions: string[];
  // Claude didn't finish its structured reply (it ran out of steps, or
  // answered in plain text); the causes are the previous reply's.
  partial: boolean;
  // Citations the server couldn't match to anything the tools returned.
  dropped: number;
};

// What the tools showed Claude in this conversation: manual pages from
// searches and page reads, and web pages from web search. Citations are only
// kept when they point at one of these.
export type SeenSources = {
  pages: { manualId: string; page: number; title: string }[];
  urls: { url: string; title: string }[];
};

export const emptySeen = (): SeenSources => ({ pages: [], urls: [] });

export type ProgressKind = "thinking" | "unit" | "search" | "read" | "web" | "writing" | "note";
export type ProgressStep = { kind: ProgressKind; label: string; at: string };

// Token counts for one tech message, summed over its API requests.
export type TurnUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  webSearches: number;
  // The prompt size of the last request (input + cache read + cache write):
  // how big the conversation has become.
  contextTokens: number;
  // Set when a refusal fallback model answered instead.
  servedBy: string[];
  // The estimated cost, priced request by request at the rates of the model
  // that ran each part (see estimateCostCents).
  costCents: number;
};

export const emptyUsage = (): TurnUsage => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  webSearches: 0,
  contextTokens: 0,
  servedBy: [],
  costCents: 0,
});

// A retried message's usage: every attempt's tokens and cost added up (they
// were all billed), and the prompt size of the latest one.
export function addTurnUsage(earlier: Partial<TurnUsage> | null | undefined, latest: TurnUsage): TurnUsage {
  const sum = (key: keyof Omit<TurnUsage, "servedBy" | "contextTokens">) => (Number(earlier?.[key]) || 0) + latest[key];
  return {
    requests: sum("requests"),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheWrite5mTokens: sum("cacheWrite5mTokens"),
    cacheWrite1hTokens: sum("cacheWrite1hTokens"),
    webSearches: sum("webSearches"),
    contextTokens: latest.contextTokens,
    servedBy: [...new Set([...(earlier?.servedBy ?? []), ...latest.servedBy])],
    costCents: sum("costCents"),
  };
}

// A tech's "Ruled out" / "This was it" on one of Claude's causes. Claude
// hears about it in the next message (sentInSeq says which).
export type CauseVerdict = "ruled_out" | "confirmed" | "open";
export type FeedbackEntry = {
  turnId: string;
  seq: number;
  index: number;
  title: string;
  likelihood: Likelihood;
  verdict: CauseVerdict;
  userId: string;
  userName: string;
  at: string;
  sentInSeq: number | null;
};

// Prices per million tokens. Cache writes cost the input price times the
// multiplier for their TTL. Claude Opus 5 and Opus 4.8 are the models a
// refusal fallback can hand a message to. Web search isn't priced in the API
// reference this was built from: WEB_SEARCH_DOLLARS_PER_1000 is Anthropic's
// published list price at the time of writing ($10 per 1,000 searches);
// check it.
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
export const WEB_SEARCH_DOLLARS_PER_1000 = 10;

type CostedUsage = Pick<
  TurnUsage,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWrite5mTokens" | "cacheWrite1hTokens" | "webSearches"
>;

// The estimated cost of some usage on one model, in cents (fractions kept).
// A model with no price here is priced as DIAGNOSE_MODEL.
export function estimateCostCents(usage: CostedUsage, model: string = DIAGNOSE_MODEL) {
  const price = PRICES[model] ?? PRICES[DIAGNOSE_MODEL];
  const dollars =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWrite5mTokens * price.input * CACHE_WRITE_5M_MULTIPLIER +
      usage.cacheWrite1hTokens * price.input * CACHE_WRITE_1H_MULTIPLIER) /
      1_000_000 +
    (usage.webSearches * WEB_SEARCH_DOLLARS_PER_1000) / 1000;
  return dollars * 100;
}

export function formatCents(cents: number) {
  if (cents < 100) return `${cents < 10 ? cents.toFixed(1) : Math.round(cents)}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

// "p0300, p0301 c1234; SPN 520207 FMI 4" -> ["P0300", "P0301", "C1234",
// "SPN 520207 FMI 4"]: codes as the tech typed them, upper-cased, one each.
// OBD-style codes run together with spaces are split; anything else (Polaris
// SPN/FMI pairs, blink codes) stays as typed.
export function normalizeFaultCodes(text: string): string[] {
  const codes: string[] = [];
  for (const piece of String(text ?? "").split(/[,;\n]+/)) {
    const tidy = piece.toUpperCase().replace(/[^A-Z0-9 \-./]/g, " ").replace(/\s+/g, " ").trim();
    if (!tidy) continue;
    const parts = /^([PBCU][0-9A-F]{4})( [PBCU][0-9A-F]{4})*$/.test(tidy) ? tidy.split(" ") : [tidy.slice(0, 40)];
    for (const code of parts) if (!codes.includes(code)) codes.push(code);
  }
  return codes.slice(0, 12);
}

const tidyText = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim().slice(0, max) : "";

// The first message when the tech starts from the quick form, as the tech
// would have typed it.
export function startMessage(input: {
  unit?: string | null;
  vin?: string | null;
  // Part of a VIN (too short to be one), kept as the tech typed it.
  partialVin?: string | null;
  complaint?: string;
  faultCodes?: string[];
  checked?: string;
  more?: string;
}) {
  const lines = [
    input.unit ? `Unit: ${input.unit}` : null,
    input.vin ? `VIN: ${input.vin}` : null,
    input.partialVin ? `Partial VIN: ${input.partialVin} (${input.partialVin.length} of 17 characters)` : null,
    input.complaint?.trim() ? `Complaint: ${input.complaint.trim()}` : null,
    input.faultCodes?.length ? `Fault codes: ${input.faultCodes.join(", ")}` : null,
    input.checked?.trim() ? `Already checked: ${input.checked.trim()}` : null,
    input.more?.trim() ? input.more.trim() : null,
  ].filter(Boolean);
  return tidyText(lines.join("\n"), DIAGNOSE_LIMITS.techText);
}

// The quick form's first message read back as labelled rows (the reverse
// of startMessage): its leading "Unit: …", "VIN: …" (or "Partial VIN: …"),
// "Complaint: …", "Fault codes: …" and "Already checked: …" lines, and
// whatever follows. Null when the message doesn't start that way.
export const OPENING_LABELS = ["Unit", "VIN", "Partial VIN", "Complaint", "Fault codes", "Already checked"] as const;
export type OpeningRow = { label: (typeof OPENING_LABELS)[number]; value: string };

export function openingRows(text: string): { rows: OpeningRow[]; more: string } | null {
  const lines = String(text ?? "").split("\n");
  const rows: OpeningRow[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const match = /^(Unit|VIN|Partial VIN|Complaint|Fault codes|Already checked): (.+)$/.exec(lines[i]);
    if (!match) break;
    rows.push({ label: match[1] as OpeningRow["label"], value: match[2].trim() });
  }
  return rows.length > 0 ? { rows, more: lines.slice(i).join("\n").trim() } : null;
}

// One of Claude's questions as a short quote for the tech's reply box.
export const QUOTE_LENGTH = 140;
export function quoteQuestion(question: string) {
  const text = String(question ?? "").replace(/\s+/g, " ").trim();
  const short = text.length > QUOTE_LENGTH ? `${text.slice(0, QUOTE_LENGTH - 1).trimEnd()}…` : text;
  return `> ${short}\n`;
}

// The reply box after tapping one of Claude's questions. Typed text with no
// quote yet is taken as the answer, so the quote goes above it; after
// earlier quotes (and their answers) it starts a block of its own, a blank
// line apart, so two quotes never run together.
export function addQuote(draft: string, question: string) {
  const quote = quoteQuestion(question);
  const text = String(draft ?? "").replace(/\s+$/, "");
  if (!text) return quote;
  if (!/^> /m.test(text)) return `${quote}${text}`;
  return `${text}\n\n${quote}`;
}

// On a tablet, what the Chat tab's badge and the Diagnosis tab's strip say
// about the last message once it has ended out of sight.
export function chatNews(status: TurnStatus) {
  if (status === "done") return { badge: "New reply", tone: "glow", text: "Claude replied.", action: "Read the reply" } as const;
  if (status === "stopped") return { badge: "Stopped", tone: "trail", text: "Your message was stopped.", action: "Open chat" } as const;
  return { badge: "Not sent", tone: "trail", text: "Your last message didn't go through.", action: "Open chat" } as const;
}

// What Claude looked at for one message, counted.
export function activityCounts(progress: ProgressStep[]) {
  const count = (kind: ProgressKind) => progress.filter((step) => step.kind === kind).length;
  return { searches: count("search"), pages: count("read"), web: count("web") };
}

// A unit from the shop's model list, suggested as the tech types.
export type UnitSuggestion = {
  modelNumber: string;
  year: number | null;
  description: string | null;
  label: string;
  manuals: number;
};

// "2019 RZR XP 1000 EPS — Z19VDE99AM": a model from the model list as the
// app shows it.
export function unitLabel(model: { year: number | null; number: string | null; description: string | null }) {
  const name = [model.year, model.description].filter(Boolean).join(" ");
  return [name, model.number].filter(Boolean).join(" — ") || "Unknown unit";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

// Web addresses are compared without a #fragment or a trailing slash, so a
// citation still matches when Claude tidies the address a little.
export function urlKey(url: string) {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

const pageKey = (manualId: string, page: number) => `${manualId.toLowerCase()}:${page}`;

// Adds what a tool returned to what Claude has seen, once each.
export function addSeen(seen: SeenSources, more: Partial<SeenSources>) {
  const pages = new Set(seen.pages.map((p) => pageKey(p.manualId, p.page)));
  for (const page of more.pages ?? []) {
    if (pages.has(pageKey(page.manualId, page.page))) continue;
    pages.add(pageKey(page.manualId, page.page));
    seen.pages.push(page);
  }
  const urls = new Set(seen.urls.map((u) => urlKey(u.url)));
  for (const entry of more.urls ?? []) {
    const key = urlKey(entry.url);
    if (!key || urls.has(key)) continue;
    urls.add(key);
    seen.urls.push(entry);
  }
  return seen;
}

export function mergeSeen(...all: SeenSources[]) {
  return all.reduce((into, more) => addSeen(into, more), emptySeen());
}

// Keeps a citation only when it points at a page or web page a tool showed
// Claude in this conversation, with the title from the tool rather than from
// Claude. Returns the checked sources and how many were dropped.
export function checkSources(raw: unknown, seen: SeenSources): { sources: SourceView[]; dropped: number } {
  const sources: SourceView[] = [];
  const keys = new Set<string>();
  let dropped = 0;
  const add = (key: string, source: SourceView) => {
    if (keys.has(key)) return;
    keys.add(key);
    sources.push(source);
  };
  for (const item of Array.isArray(raw) ? raw.slice(0, 12) : []) {
    const source = (item ?? {}) as Record<string, unknown>;
    if (source.type === "general") {
      add("general", { type: "general" });
    } else if (source.type === "manual") {
      const page = Number(source.page);
      const found =
        isUuid(source.manual_id) && Number.isInteger(page)
          ? seen.pages.find((p) => pageKey(p.manualId, p.page) === pageKey(source.manual_id as string, page))
          : undefined;
      if (found) add(pageKey(found.manualId, found.page), { type: "manual", ...found });
      else dropped += 1;
    } else if (source.type === "web") {
      const key = typeof source.url === "string" ? urlKey(source.url) : null;
      const found = key ? seen.urls.find((u) => urlKey(u.url) === key) : undefined;
      if (found) add(`web:${key}`, { type: "web", url: found.url, title: found.title || found.url });
      else dropped += 1;
    } else {
      dropped += 1;
    }
  }
  return { sources, dropped };
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], otherwise: T): T =>
  allowed.includes(value as T) ? (value as T) : otherwise;

// Words that say how much work a check is, for a tier Claude didn't give or
// gave as something else (the tools stream their input, so the API doesn't
// hold Claude to the enum). Teardown is taking something apart, or off, or
// swapping a part in: a removal word together with a part that's work to
// get at (a cover, the clutch, a wheel, a sensor), or words that only mean
// teardown. Pulling a fuse, the seat or a plug wire, or "pulling" stored
// codes, isn't. Then test words (a meter, a gauge, a scan tool, the Digital
// Wrench, a road test), then quick ones (looking, connectors, fuses, codes
// on the dash, levels). "Unplug the connector and measure the resistance"
// is a test, "pull the clutch cover and check the belt" teardown.
const TEARDOWN_ONLY =
  /\b(disassembl\w*|tear ?down|teardown|split(?:ting)? (?:the )?(?:crank ?)?cases?|cylinder head|crankcase|parts off|panels? off|body ?work off|known[- ]good)\b/i;
const TAKING_OFF = /\b(remov\w*|take (?:off|out|apart)|taking (?:off|out|apart)|pull(?:ing)?|drop(?:ping)?|swap\w*|replac\w*|install\w*|unbolt\w*)\b/i;
const HARD_TO_REACH =
  /\b((?<!air ?box |filter |fuse ?box |fuse |battery |radiator |tank )covers?|clutch\w*|belts?|stators?|flywheel|heads?|cylinders?|pistons?|valves?|cam ?shafts?|crank\w*|wheels?|hubs?|axles?|cv joints?|half ?shafts?|bearings?|seals?|(?:side|body|access|floor|rocker|inner) panels?|fenders?|hood|plastics|bodywork|skid plates?|fuel tank|gas tank|throttle bod(?:y|ies)|injectors?|fuel pump|water pump|oil pump|starter|transmission|gear ?case|gearbox|diff\w*|engine|exhaust|header|muffler|radiator|shocks?|a-arms?|(?:sensors?|coils?)\b(?! (?:connectors?|plugs?|wires?|wiring|leads?))|spark plugs?|plugs\b(?! wires?)|ecu|regulator)\b/i;
const TEST_WORDS =
  /\b(meter|multimeter|dvom|ohms?|volts?|voltage|resistance|continuity|amps?|amperage|current draw|pressure (?:test|gauge)|fuel pressure|(?:vacuum|fuel|pressure|compression) gauge|gauge set|compression|leak[- ]?down|scan tool|digital wrench|live data|data stream|oscilloscope|back ?prob\w*|load test|road test|test ride|test drive|measur\w*|vacuum|smoke test|test light|noid)\b/i;
const QUICK_WORDS =
  /\b(look\w*|inspect\w*|visual\w*|connectors?|plugged|unplugged|loose|tight\w*|wiggle|fuses?|relays?|grounds?|wiring|harness|chaf\w*|corro\w*|damaged?|broken wire|fluid|oil level|coolant level|levels?|codes?|battery terminals?|terminals?|caps?|clamps?|hoses?|seat|air filter|filter|plug wires?|boots?|bulbs?)\b/i;

export function inferEffort(...texts: string[]): Effort {
  const text = texts.join(" ");
  if (TEARDOWN_ONLY.test(text) || (TAKING_OFF.test(text) && HARD_TO_REACH.test(text))) return "teardown";
  if (TEST_WORDS.test(text)) return "test";
  if (QUICK_WORDS.test(text)) return "quick";
  return "test";
}

// A tier as Claude sent it, if it's one of the three (case, spaces and a
// few spellings aside: "Quick check", "tear down", "tests"), else null.
export function listedEffort(value: unknown): Effort | null {
  if (typeof value !== "string") return null;
  const key = value.toLowerCase().replace(/[^a-z]/g, "");
  if (key === "quick" || key === "quickcheck" || key === "quickchecks") return "quick";
  if (key === "test" || key === "tests" || key === "needsatest") return "test";
  if (key === "teardown" || key === "teardowns") return "teardown";
  return null;
}

// The next checks of a reply saved before checks carried causes, as the
// screen lists them on their own: under their tiers, quick first, numbered
// on across the tiers (step). Null for a reply saved before checks had
// tiers, which is one list in Claude's order. (A newer reply's checks go in
// its causes' cards: see diagnose-cause-steps.)
export function checkGroups<T extends { tier?: Effort }>(checks: T[]) {
  if (checks.length === 0 || !checks.every((check) => check.tier)) return null;
  const tiers = EFFORTS.map((effort) => checks.filter((check) => check.tier === effort));
  return EFFORTS.map((effort, tier) => {
    const before = tiers.slice(0, tier).reduce((sum, list) => sum + list.length, 0);
    return { effort, items: tiers[tier].map((check, index) => ({ check, step: before + index + 1 })) };
  }).filter((group) => group.items.length > 0);
}

// Checks grouped by tier, quick first, in Claude's order within each.
export const byEffort = <T extends { tier?: Effort }>(checks: T[]) =>
  checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => EFFORTS.indexOf(a.check.tier ?? "test") - EFFORTS.indexOf(b.check.tier ?? "test") || a.index - b.index)
    .map(({ check }) => check);

const strings = (value: unknown, count: number, max: number) =>
  (Array.isArray(value) ? value : []).map((item) => tidyText(item, max)).filter(Boolean).slice(0, count);

// What's missing from a submit_diagnosis call, for an error result Claude
// can fix, or null when it's usable.
export function submittedProblem(input: unknown): string | null {
  const value = (input ?? {}) as Record<string, unknown>;
  if (typeof input !== "object" || input === null) return "The input isn't an object.";
  if (typeof value.reply !== "string" || !value.reply.trim()) return "`reply` is missing or empty.";
  if (!Array.isArray(value.likely_causes)) return "`likely_causes` must be a list (it can be empty).";
  if (!Array.isArray(value.next_checks)) return "`next_checks` must be a list (it can be empty).";
  return null;
}

// Claude's submit_diagnosis input, tidied and with every citation checked
// against what the tools returned in this conversation. A cause whose
// citations all fail falls back to general knowledge; a check keeps only
// the ones that hold, and a spec left without a manual page is flagged.
export function finalizeReply(input: unknown, seen: SeenSources): DiagnosisReply {
  const value = (input ?? {}) as Record<string, unknown>;
  let dropped = 0;
  const causes = (Array.isArray(value.likely_causes) ? value.likely_causes : [])
    .slice(0, 10)
    .map((item) => {
      const cause = (item ?? {}) as Record<string, unknown>;
      const checked = checkSources(cause.sources, seen);
      dropped += checked.dropped;
      const title = tidyText(cause.title, 160);
      const why = tidyText(cause.why, 1000);
      return {
        title,
        // The tools stream their input (eager_input_streaming), so the API
        // doesn't hold Claude to the enum: a missing or unlisted system is
        // worked out from the cause's words, like an older reply's.
        system: listedSystem(cause.system) ?? inferSystem(title, why),
        likelihood: pick(cause.likelihood, LIKELIHOODS, "medium"),
        why,
        status: pick(cause.status, CAUSE_STATUSES, "open"),
        sources: checked.sources.length > 0 ? checked.sources : [{ type: "general" as const }],
        // Likewise worked out from the words when it isn't one of the three.
        checkEffort: listedEffort(cause.check_effort) ?? inferEffort(title, why),
      };
    });
  const likelyCauses: Cause[] = causes.filter((cause) => cause.title);
  // Claude's numbers for its causes (1 is its first) to their places in the
  // list kept, which leaves out a cause without a title.
  const rankOf = new Map<number, number>();
  causes.forEach((cause, index) => {
    if (cause.title) rankOf.set(index + 1, likelyCauses.indexOf(cause) + 1);
  });
  // Every open cause gets at least one check of its own (of up to ten
  // causes), and there can be general ones besides.
  const nextChecks: Check[] = (Array.isArray(value.next_checks) ? value.next_checks : [])
    .slice(0, 16)
    .map((item) => {
      const check = (item ?? {}) as Record<string, unknown>;
      const checked = checkSources(check.sources, seen);
      dropped += checked.dropped;
      const expected = tidyText(check.expected, 400);
      const action = tidyText(check.action, 600);
      return {
        tier: listedEffort(check.tier) ?? inferEffort(action, expected),
        action,
        // Causes it's about, once each, in order; numbers that aren't a
        // cause's are left out.
        causes: [...new Set((Array.isArray(check.causes) ? check.causes : []).map((n) => rankOf.get(Number(n))))]
          .filter((n): n is number => n !== undefined)
          .sort((a, b) => a - b)
          .slice(0, 5),
        expected,
        sources: checked.sources,
        unverifiedSpec: expected !== "" && !checked.sources.some((source) => source.type === "manual"),
      };
    })
    .filter((check) => check.action);
  return {
    reply: tidyText(value.reply, 6000),
    likelyCauses,
    // Quick checks, then tests, then teardown, as the prompt asks; Claude's
    // order within each tier.
    nextChecks: byEffort(nextChecks),
    safetyNotes: strings(value.safety_notes, 6, 400),
    questions: strings(value.questions_for_tech, 4, 300),
    partial: false,
    dropped,
  };
}

// When Claude didn't send a structured reply: its plain text, if any, and the
// last reply's causes and checks so the panel doesn't go blank.
export function partialReply(text: string, previous: DiagnosisReply | null): DiagnosisReply {
  return {
    reply:
      tidyText(text, 6000) ||
      "I ran out of steps before I could finish this one. Send it again, or narrow it down (one system or symptom at a time).",
    likelyCauses: previous?.likelyCauses ?? [],
    nextChecks: previous?.nextChecks ?? [],
    safetyNotes: previous?.safetyNotes ?? [],
    questions: [],
    partial: true,
    dropped: 0,
  };
}

// Model text, for showing as plain text: paragraphs split on blank lines,
// and runs of "- " / "• " / "1. " lines as lists. Nothing is ever treated as
// HTML.
export type TextBlock = { kind: "paragraph"; text: string } | { kind: "list"; ordered: boolean; items: string[] };

const BULLET = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/;

export function textBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      const ordered = bullet[1] !== undefined;
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(bullet[2].trim());
      else blocks.push({ kind: "list", ordered, items: [bullet[2].trim()] });
    } else if (!line.trim()) {
      flush();
    } else {
      // A line straight after a list item continues it.
      const last = blocks.at(-1);
      if (paragraph.length === 0 && last?.kind === "list" && /^\s{2,}/.test(line)) {
        last.items[last.items.length - 1] += ` ${line.trim()}`;
      } else paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

// The events the turn route streams to the browser, one JSON object per line.
export type TurnView = {
  id: string;
  seq: number;
  status: TurnStatus;
  techText: string;
  userName: string;
  createdAt: string;
  progress: ProgressStep[];
  reply: DiagnosisReply | null;
  error: string | null;
  // Always null; the screen no longer shows a cost per message. Pages loaded
  // before that release show "≈ <cost>" whenever this isn't null, which
  // reads "≈ $NaN" when it's missing, so it stays for one more release.
  costCents?: null;
};

export type ScopeView = {
  // Null when the conversation searches the whole library.
  label: string | null;
  manuals: { id: string; title: string }[];
};

export type ConversationView = {
  id: string;
  title: string;
  status: ConversationStatus;
  unit: string | null;
  // The unit's VIN, if the tech gave one, and its model number when it's
  // known (so the screen can say when the two don't agree).
  vin: string | null;
  modelNumber: string | null;
  // Which drawing the unit gets, if any.
  vehicle: UnitVehicle | null;
  // Which machine the 3D unit shows (line, seats, size, paint), if known.
  model: UnitSpec | null;
  scope: ScopeView;
  feedback: FeedbackEntry[];
  outcome: { title: string; seq: number } | null;
  techMessages: number;
  // Why no more messages can be sent, if so.
  full: string | null;
};

export type StreamEvent =
  | { type: "start"; conversation: ConversationView; turn: TurnView }
  | { type: "progress"; step: ProgressStep }
  | { type: "reply"; text: string }
  | {
      type: "scope";
      scope: ScopeView;
      vehicle: UnitVehicle | null;
      model: UnitSpec | null;
      vin: string | null;
      modelNumber: string | null;
    }
  | { type: "end"; conversation: ConversationView; turn: TurnView };

// What a VIN typed in the quick form finds in the shop's model list, said
// before the diagnosis starts: the unit and its manuals (models > 1 for a
// model's variants), a model that's listed without a manual, a match with
// too many manuals to narrow to, or nothing.
export type VinPreview =
  | { status: "found"; label: string; models: number; manuals: number }
  | { status: "listed"; label: string; models: number }
  | { status: "many"; models: number; manuals: number }
  | { status: "none" };

// The conversation is full; the tech starts a new one for the unit.
export const FULL_BY_MESSAGES = `This diagnosis has ${DIAGNOSE_LIMITS.techMessages} messages, as many as one can hold. Start a new diagnosis for this unit to carry on: the causes and checks so far go with it.`;
export const FULL_BY_LENGTH =
  "This diagnosis has grown too long for Claude to keep track of. Start a new diagnosis for this unit to carry on: the causes and checks so far go with it.";

export const SETUP_MESSAGE =
  "Diagnose isn't set up yet: an admin needs to add ANTHROPIC_API_KEY in Vercel (Settings → Environment Variables, for Production and Preview), then redeploy.";
