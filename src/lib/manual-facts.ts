import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";

import { withShop } from "@/db";
import { manualPageFacts, manualPages, manuals } from "@/db/schema";
import { giveBackAttempt, takeAttempt } from "@/lib/attempts";
import { askClaude, isClaudeConfigured } from "@/lib/claude";
import { apiErrorDetail, classifyError, type FailureReason } from "@/lib/diagnose-loop";
import { estimateCostCents } from "@/lib/diagnose-rules";
import { manualDisplayTitle } from "@/lib/manual-catalog";
import {
  FACTS_LIMITS,
  FACTS_NUDGE,
  PAGE_FACTS_MODEL,
  checkFacts,
  factsInReply,
  factsRequest,
  hasFacts,
  type FactsState,
  type PageAsk,
  type PageFacts,
  type PageRef,
} from "@/lib/manual-facts-rules";
import { cutText } from "@/lib/manual-rules";

// Reading a manual page once, for the card beside it on Diagnose's part
// sheet. The first time anyone in the shop opens a page, Claude reads its
// text and records its steps, torque specs, tools and cautions; what it
// records is checked against the page's own text (src/lib/manual-facts-
// rules.ts) and saved in manual_page_facts, so the page is never read
// again, also when it had nothing for a card. Two devices opening the same
// page at once read it once: the first to claim the page's row reads it,
// the other is told it's being read. Readings count against the shop's
// daily allowance; without an API key, past the allowance or when the read
// fails, the page still shows without its card, and a failed read is tried
// again after a while, not every time the page is opened: when the failure
// was the page's, a few times in all, and not again when Claude declined
// the page or ran out of room (asking again would go the same way); when
// it was the service's (busy, billing, the key, the connection), however
// often it takes, so the card comes back once the service does.
// Callers check the user may see the page (Diagnose's part sheet checks
// it's one of the conversation's manuals); everything here runs inside
// withShop.

export const PAGE_FACTS_LIMITS = {
  // Readings per shop per day: about a cent each, and each page only once.
  perShopPerDay: 300,
  // A failed read is tried again after this long; one that failed because
  // of the page, up to this many reads in all (the service's failures
  // don't count, see NOT_THE_PAGE).
  retryAfterMs: 15 * 60 * 1000,
  maxAttempts: 3,
  // A read under way for this long lost its server (longer than the part
  // sheet's route may run): another can take it on.
  staleAfterMs: 3 * 60 * 1000,
  // Per request; the SDK tries once more after a dropped connection or a 5xx.
  timeoutMs: 30_000,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// Failures that aren't the page's: the API busy, rate-limited or unpaid, the
// key or setup, a timeout or a dropped connection. Reading the page again
// later can go through, so they never use up its reads. A request the API
// turned down or found too long, and anything unrecognised, count.
const NOT_THE_PAGE: ReadonlySet<FailureReason> = new Set(["overloaded", "rate_limited", "billing", "setup", "timeout", "connection", "stopped"]);

const allowanceKey = (shopId: string) => `page-facts:shop:${shopId}`;

type Row = typeof manualPageFacts.$inferSelect;

// A saved reading as the screen sees it, or null when the page can be read
// now (never read, a failed read old enough to try again, or a read whose
// server went away).
function savedState(row: Row | undefined, now = Date.now()): FactsState | null {
  if (!row) return null;
  if (row.status === "ready" && row.facts) return { status: "ready", facts: row.facts, partial: row.dropped > 0 };
  if (row.status === "ready" || row.status === "empty") return { status: "empty" };
  const age = now - row.attemptedAt.getTime();
  if (row.status === "reading") return age < PAGE_FACTS_LIMITS.staleAfterMs ? { status: "reading" } : null;
  const retry = age >= PAGE_FACTS_LIMITS.retryAfterMs && row.attempts < PAGE_FACTS_LIMITS.maxAttempts;
  return retry ? null : { status: "unavailable", reason: "error" };
}

// Whether a page has enough text to read (not a scanned page OCR hasn't
// read, or a photo with a caption).
const worthReading = (text: string) => text.replace(/\s+/g, "").length >= FACTS_LIMITS.minPageText;

// A ready manual's page, its text and the manual's title, with its saved
// reading if any. Null when the shop has no such page.
async function loadPage(shopId: string, ref: PageRef) {
  return withShop(shopId, async (tx) => {
    const [page] = await tx
      .select({ text: manualPages.text, title: manualDisplayTitle })
      .from(manualPages)
      .innerJoin(manuals, and(eq(manuals.id, manualPages.manualId), eq(manuals.shopId, manualPages.shopId)))
      .where(and(eq(manualPages.manualId, ref.manualId), eq(manualPages.pageNumber, ref.page), eq(manuals.status, "ready")));
    if (!page) return null;
    const [row] = await tx
      .select()
      .from(manualPageFacts)
      .where(and(eq(manualPageFacts.manualId, ref.manualId), eq(manualPageFacts.pageNumber, ref.page)));
    return { ...page, row };
  });
}

// A page's card as saved, without reading anything: "unread" when it can be
// read now. Null when the shop has no such page.
export async function savedPageFacts(shopId: string, ref: PageRef): Promise<FactsState | null> {
  const page = await loadPage(shopId, ref);
  if (!page) return null;
  return savedState(page.row) ?? (worthReading(page.text) ? { status: "unread" } : { status: "empty" });
}

// Takes the page's row for this read: a new row, or one whose read failed
// long enough ago or stalled. One statement, so of two devices asking at
// once exactly one gets it. False when another read has it (or it's done).
async function claimPage(shopId: string, ref: PageRef) {
  const retry = PAGE_FACTS_LIMITS.retryAfterMs / 1000;
  const stale = PAGE_FACTS_LIMITS.staleAfterMs / 1000;
  const rows = await withShop(shopId, (tx) =>
    tx
      .insert(manualPageFacts)
      .values({ manualId: ref.manualId, shopId, pageNumber: ref.page, status: "reading" })
      .onConflictDoUpdate({
        target: [manualPageFacts.manualId, manualPageFacts.pageNumber],
        set: {
          status: "reading",
          attemptedAt: sql`now()`,
          attempts: sql`${manualPageFacts.attempts} + 1`,
          error: null,
        },
        setWhere: sql`(${manualPageFacts.status} = 'failed' and ${manualPageFacts.attemptedAt} < now() - make_interval(secs => ${retry})
            and ${manualPageFacts.attempts} < ${PAGE_FACTS_LIMITS.maxAttempts})
          or (${manualPageFacts.status} = 'reading' and ${manualPageFacts.attemptedAt} < now() - make_interval(secs => ${stale}))`,
      })
      .returning({ attempts: manualPageFacts.attempts }),
  );
  return rows.length > 0;
}

// Saves how the read went, over the claim it holds (a read that stalled and
// was taken over by another device leaves the other's result alone). A
// failed read that would fail again (final) isn't tried again; one that
// wasn't the page's fault (free) gives back the read its claim counted.
async function saveReading(
  shopId: string,
  ref: PageRef,
  outcome: {
    status: "ready" | "empty" | "failed";
    facts?: PageFacts;
    dropped?: number;
    error?: string;
    attempt?: "final" | "free";
    usage: Usage;
  },
) {
  await withShop(shopId, (tx) =>
    tx
      .update(manualPageFacts)
      .set({
        status: outcome.status,
        facts: outcome.facts ?? null,
        dropped: outcome.dropped ?? 0,
        error: outcome.error ? cutText(outcome.error, 400) : null,
        inputTokens: sql`${manualPageFacts.inputTokens} + ${outcome.usage.inputTokens}`,
        outputTokens: sql`${manualPageFacts.outputTokens} + ${outcome.usage.outputTokens}`,
        costCents: sql`${manualPageFacts.costCents} + ${outcome.usage.costCents}`,
        ...(outcome.attempt === "final" ? { attempts: sql`greatest(${manualPageFacts.attempts}, ${PAGE_FACTS_LIMITS.maxAttempts})` } : {}),
        ...(outcome.attempt === "free" ? { attempts: sql`greatest(${manualPageFacts.attempts} - 1, 0)` } : {}),
      })
      .where(
        and(
          eq(manualPageFacts.manualId, ref.manualId),
          eq(manualPageFacts.pageNumber, ref.page),
          eq(manualPageFacts.status, "reading"),
        ),
      ),
  );
}

type Usage = { inputTokens: number; outputTokens: number; costCents: number };

function addUsage(usage: Usage, message: Pick<Anthropic.Messages.Message, "usage">) {
  const input = (message.usage.input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
  const cacheRead = message.usage.cache_read_input_tokens ?? 0;
  const output = message.usage.output_tokens ?? 0;
  usage.inputTokens += input + cacheRead;
  usage.outputTokens += output;
  usage.costCents += estimateCostCents(
    { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, webSearches: 0 },
    PAGE_FACTS_MODEL,
  );
}

// Asks Claude for the page's facts: once, and once more with a nudge when it
// answered without the tool. The tool's input, or why there's none.
async function askForFacts(ask: PageAsk, page: { manualTitle: string; page: number; text: string }, usage: Usage) {
  const params = factsRequest(page);
  const first = await ask(params, { timeoutMs: PAGE_FACTS_LIMITS.timeoutMs });
  addUsage(usage, first);
  const reply = factsInReply(first);
  if (!("problem" in reply) || reply.problem !== "no_call") return reply;
  const again = await ask(
    {
      ...params,
      messages: [
        ...params.messages,
        { role: "assistant", content: first.content as Anthropic.Messages.ContentBlockParam[] },
        { role: "user", content: [{ type: "text", text: FACTS_NUDGE }] },
      ],
    },
    { timeoutMs: PAGE_FACTS_LIMITS.timeoutMs },
  );
  addUsage(usage, again);
  return factsInReply(again);
}

// A page's card, reading the page with Claude the first time (see the top
// of this file). `ask` is the API (the real one unless a test passes its
// own; null when there's no API key). Null when the shop has no such page.
export async function readPageFacts(shopId: string, ref: PageRef, options: { ask?: PageAsk | null } = {}): Promise<FactsState | null> {
  const ask = options.ask === undefined ? (isClaudeConfigured ? askClaude : null) : options.ask;
  const page = await loadPage(shopId, ref);
  if (!page) return null;
  const saved = savedState(page.row);
  if (saved) return saved;
  if (!worthReading(page.text)) return { status: "empty" };
  if (!ask) return { status: "unavailable", reason: "setup" };

  // Counted before the claim, so a shop past its allowance never claims a
  // page it won't read; given back when another device has it.
  const key = allowanceKey(shopId);
  const allowed = await takeAttempt(key, PAGE_FACTS_LIMITS.perShopPerDay, DAY_MS);
  if (!allowed.allowed) return { status: "unavailable", reason: "limit" };
  if (!(await claimPage(shopId, ref))) {
    await giveBackAttempt(key);
    const now = await loadPage(shopId, ref);
    return savedState(now?.row) ?? { status: "reading" };
  }

  const usage: Usage = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  try {
    const reply = await askForFacts(ask, { manualTitle: page.title, page: ref.page, text: page.text }, usage);
    if ("problem" in reply) {
      console.error(`Couldn't read page ${ref.page} of manual ${ref.manualId}: ${reply.problem}`);
      // Declined, or too much for the answer's room: the same again next
      // time. No tool call even after the nudge counts as one of the reads.
      const final = reply.problem === "refusal" || reply.problem === "max_tokens";
      await saveReading(shopId, ref, { status: "failed", error: reply.problem, attempt: final ? "final" : undefined, usage });
      return { status: "unavailable", reason: "error" };
    }
    const { facts, dropped } = checkFacts(reply.input, page.text);
    const status = hasFacts(facts) ? "ready" : "empty";
    await saveReading(shopId, ref, { status, facts, dropped, usage });
    return status === "ready" ? { status, facts, partial: dropped > 0 } : { status };
  } catch (error) {
    const reason = classifyError(error);
    const detail = apiErrorDetail(error);
    console.error(`Couldn't read page ${ref.page} of manual ${ref.manualId}: ${reason}`, detail ?? error);
    const attempt = NOT_THE_PAGE.has(reason) ? "free" : undefined;
    await saveReading(shopId, ref, { status: "failed", error: detail ? `${reason}: ${detail}` : reason, attempt, usage });
    return { status: "unavailable", reason: reason === "setup" ? "setup" : "error" };
  }
}
