// Rules for Diagnose, the chat between a tech and Claude, shared by the
// server and the browser: the shape of Claude's structured reply, checking
// its citations against what the tools actually returned, fault codes, the
// limits, and the cost estimate. Kept free of database imports so browser
// code can use it.

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

// Where a piece of advice comes from, after the server has checked it: a
// page of one of the shop's manuals, a web page from Claude's searches, or
// Claude's own general knowledge.
export type SourceView =
  | { type: "manual"; manualId: string; page: number; title: string }
  | { type: "web"; url: string; title: string }
  | { type: "general" };

export type Cause = {
  title: string;
  likelihood: Likelihood;
  why: string;
  status: CauseStatus;
  sources: SourceView[];
};

export type Check = {
  action: string;
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
  complaint?: string;
  faultCodes?: string[];
  checked?: string;
  more?: string;
}) {
  const lines = [
    input.unit ? `Unit: ${input.unit}` : null,
    input.complaint?.trim() ? `Complaint: ${input.complaint.trim()}` : null,
    input.faultCodes?.length ? `Fault codes: ${input.faultCodes.join(", ")}` : null,
    input.checked?.trim() ? `Already checked: ${input.checked.trim()}` : null,
    input.more?.trim() ? input.more.trim() : null,
  ].filter(Boolean);
  return tidyText(lines.join("\n"), DIAGNOSE_LIMITS.techText);
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
  const likelyCauses: Cause[] = (Array.isArray(value.likely_causes) ? value.likely_causes : [])
    .slice(0, 10)
    .map((item) => {
      const cause = (item ?? {}) as Record<string, unknown>;
      const checked = checkSources(cause.sources, seen);
      dropped += checked.dropped;
      return {
        title: tidyText(cause.title, 160),
        likelihood: pick(cause.likelihood, LIKELIHOODS, "medium"),
        why: tidyText(cause.why, 1000),
        status: pick(cause.status, CAUSE_STATUSES, "open"),
        sources: checked.sources.length > 0 ? checked.sources : [{ type: "general" as const }],
      };
    })
    .filter((cause) => cause.title);
  const nextChecks: Check[] = (Array.isArray(value.next_checks) ? value.next_checks : [])
    .slice(0, 10)
    .map((item) => {
      const check = (item ?? {}) as Record<string, unknown>;
      const checked = checkSources(check.sources, seen);
      dropped += checked.dropped;
      const expected = tidyText(check.expected, 400);
      return {
        action: tidyText(check.action, 600),
        expected,
        sources: checked.sources,
        unverifiedSpec: expected !== "" && !checked.sources.some((source) => source.type === "manual"),
      };
    })
    .filter((check) => check.action);
  return {
    reply: tidyText(value.reply, 6000),
    likelyCauses,
    nextChecks,
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
  // Shown to managers and admins only.
  costCents: number | null;
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
  | { type: "scope"; scope: ScopeView }
  | { type: "end"; conversation: ConversationView; turn: TurnView };

// The conversation is full; the tech starts a new one for the unit.
export const FULL_BY_MESSAGES = `This diagnosis has ${DIAGNOSE_LIMITS.techMessages} messages, as many as one can hold. Start a new diagnosis for this unit to carry on: the causes and checks so far go with it.`;
export const FULL_BY_LENGTH =
  "This diagnosis has grown too long for Claude to keep track of. Start a new diagnosis for this unit to carry on: the causes and checks so far go with it.";

export const SETUP_MESSAGE =
  "Diagnose isn't set up yet: an admin needs to add ANTHROPIC_API_KEY in Vercel (Settings → Environment Variables, for Production and Preview), then redeploy.";
