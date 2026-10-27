import "server-only";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { withShop } from "@/db";
import { diagnosisConversations, diagnosisTurns, manualPages, manuals } from "@/db/schema";
import {
  SHOWN_DRAWING_PAGES,
  aboutPart,
  drawingPages,
  isDrawnSystem,
  mentionsPart,
  partNames,
  partOfCause,
  partSearchText,
  rankPages,
  type PageCandidate,
  type PartCard,
  type PartSheet,
} from "@/lib/diagnose-parts";
import { causeRanks } from "@/lib/diagnose-cause-steps";
import { isUuid, type DiagnosisReply, type SourceView } from "@/lib/diagnose-rules";
import { unitVehicle } from "@/lib/diagnose-tools";
import { causeSystem, shownStatus, type DrawnSystem } from "@/lib/diagnose-zones";
import { manualsForModel, searchDrawingPages, searchManuals, searchManualsWithMost } from "@/lib/library";
import { manualDisplayTitle } from "@/lib/manual-catalog";
import { readPageFacts, savedPageFacts } from "@/lib/manual-facts";
import type { PageAsk, PageRef } from "@/lib/manual-facts-rules";
import { cutText } from "@/lib/manual-rules";
import type { CurrentUser } from "@/lib/session";

// Diagnose's part sheet, from the server: for a system of the unit the tech
// tapped, the parts to pick from, the manual pages that show the picked part
// (the large one first, then a few others) and the large page's card (what
// the page says, read once: src/lib/manual-facts.ts). A part's pages are the
// pages the conversation's causes cite for it, then the system's other
// causes' pages that have it, then what a full-text search of the
// conversation's manuals (its scope, else the unit's manuals) finds for the
// part's name, ranked toward its service procedure in the unit's own manual
// (src/lib/diagnose-parts.ts). With no manual to search, the sheet says so.
// It also names the pages with the part's drawings: its exploded views in
// those manuals, then its best page and the pages its causes cite
// (drawingPages); the screen crops the drawings out of them.
// A page's card is asked for on its own (partPageCard), without the search:
// the screen asks again every couple of seconds while another device reads
// the page. Callers check diagnostics.work first; everything runs inside
// withShop.

const NOT_HERE = "That diagnosis isn't in this shop.";

// Pages search hands the ranking: enough that the procedure page is among
// them when the part is on many (a wiring diagram, a contents page, the
// troubleshooting chart all name the starter solenoid).
const SEARCHED_PAGES = 16;
const SHOWN_PAGES = 4;
// Pages that may be the part's drawings, for drawingPages to pick from.
const SEARCHED_DRAWINGS = 12;
// Of a long page, what the ranking reads.
const RANKED_TEXT = 20_000;

const manualSources = (sources: SourceView[]) =>
  sources.flatMap((source) => (source.type === "manual" ? [{ manualId: source.manualId, page: source.page }] : []));

const pageKey = (page: PageRef) => `${page.manualId.toLowerCase()}:${page.page}`;

// The pages the reply cites: those of causes naming the part, and those of
// the system's other causes (each with the checks for it).
function citedPages(reply: DiagnosisReply | null, system: DrawnSystem, part: string) {
  const forPart: PageRef[] = [];
  const forSystem: PageRef[] = [];
  if (!reply) return { forPart, forSystem };
  const causes = reply.likelyCauses;
  const checksFor = (rank: number) => reply.nextChecks.filter((check) => causeRanks(check, causes.length).includes(rank));
  causes.forEach((cause, index) => {
    const pages = manualSources([...cause.sources, ...checksFor(index + 1).flatMap((check) => check.sources)]);
    if (causeSystem(cause) === system) {
      const named = partOfCause(cause.title, system);
      (named !== null && named.toLowerCase() === part.toLowerCase() ? forPart : forSystem).push(...pages);
    }
  });
  return { forPart, forSystem };
}

// Every page the reply cites anywhere (which the sheet may open).
function citedAnywhere(reply: DiagnosisReply | null) {
  if (!reply) return new Set<string>();
  const sources = [...reply.likelyCauses.flatMap((cause) => cause.sources), ...reply.nextChecks.flatMap((check) => check.sources)];
  return new Set(manualSources(sources).map(pageKey));
}

// The conversation's unit and scope, and the reply the screen shows (the
// latest finished one). Null when the shop has no such conversation.
async function loadConversation(shopId: string, conversationId: string) {
  return withShop(shopId, async (tx) => {
    const [conversation] = await tx
      .select({
        scopeManualIds: diagnosisConversations.scopeManualIds,
        unitModelNumber: diagnosisConversations.unitModelNumber,
        unitLabel: diagnosisConversations.unitLabel,
        feedback: diagnosisConversations.feedback,
        outcome: diagnosisConversations.outcome,
      })
      .from(diagnosisConversations)
      .where(eq(diagnosisConversations.id, conversationId));
    if (!conversation) return null;
    const [turn] = await tx
      .select({ reply: diagnosisTurns.reply })
      .from(diagnosisTurns)
      .where(and(eq(diagnosisTurns.conversationId, conversationId), eq(diagnosisTurns.status, "done"), isNotNull(diagnosisTurns.reply)))
      .orderBy(desc(diagnosisTurns.seq))
      .limit(1);
    return { conversation, reply: turn?.reply ?? null };
  });
}

// The unit's own manuals, by its model number.
async function unitManualIds(shopId: string, modelNumber: string | null) {
  return modelNumber ? (await manualsForModel(shopId, modelNumber)).map((row) => row.id) : [];
}

// The text and manual title of ready pages of the shop, for ranking.
async function pageTexts(shopId: string, pages: PageRef[]) {
  if (pages.length === 0) return new Map<string, { text: string; title: string }>();
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({
        manualId: manualPages.manualId,
        page: manualPages.pageNumber,
        text: sql<string>`left(${manualPages.text}, ${RANKED_TEXT})`,
        title: manualDisplayTitle,
      })
      .from(manualPages)
      .innerJoin(manuals, and(eq(manuals.id, manualPages.manualId), eq(manuals.shopId, manualPages.shopId)))
      .where(
        and(
          eq(manuals.status, "ready"),
          sql`(${manualPages.manualId}, ${manualPages.pageNumber}) in (${sql.join(
            pages.map((page) => sql`(${page.manualId}::uuid, ${page.page}::int)`),
            sql`, `,
          )})`,
        ),
      ),
  );
  return new Map(rows.map((row) => [pageKey(row), { text: row.text, title: row.title }]));
}

export type PartSheetInput = { conversationId: string; system: string; part?: string };

// The sheet for one system and part (the first part when none is picked),
// with the large page's card as saved ("unread" until someone asks for it
// with partPageCard), when that page is about the part.
export async function partSheet(user: CurrentUser, input: PartSheetInput): Promise<PartSheet | { error: string }> {
  if (!isUuid(input.conversationId)) return { error: NOT_HERE };
  if (!isDrawnSystem(input.system)) return { error: "That isn't a part of the unit." };
  const system = input.system;
  const shopId = user.shop.id;
  const found = await loadConversation(shopId, input.conversationId);
  if (!found) return { error: NOT_HERE };
  const { conversation, reply } = found;

  const [vehicle, unitManuals] = await Promise.all([
    unitVehicle(shopId, { modelNumber: conversation.unitModelNumber, manualIds: conversation.scopeManualIds, label: conversation.unitLabel }),
    unitManualIds(shopId, conversation.unitModelNumber),
  ]);
  const causes = (reply?.likelyCauses ?? []).map((cause) => ({
    title: cause.title,
    system: cause.system,
    why: cause.why,
    status: shownStatus(cause, conversation.feedback, conversation.outcome?.title ?? null),
  }));
  const parts = partNames(system, { vehicle, causes });
  const named = typeof input.part === "string" ? cutText(input.part.replace(/\s+/g, " ").trim(), 60) : "";
  const part = named || parts[0];

  // The manuals to search: the conversation's own, else the unit's.
  const searchable = conversation.scopeManualIds ?? unitManuals;
  const own = new Set(unitManuals.map((id) => id.toLowerCase()));
  const cited = citedPages(reply, system, part);
  const query = partSearchText(part);
  // Its drawings' pages are looked for alongside (awaited below; a failure
  // there is the sheet's, not one left unhandled while this search runs).
  const views = searchable.length > 0 && query ? searchDrawingPages(shopId, query, searchable, SEARCHED_DRAWINGS, RANKED_TEXT) : Promise.resolve([]);
  views.catch(() => {});
  let hits: { manualId: string; pageNumber: number; rank: number }[] = [];
  if (searchable.length > 0 && query) {
    hits = await searchManuals(shopId, query, {}, SEARCHED_PAGES, searchable);
    // Too few with every word of a longer name: those with most of them too.
    if (hits.length < SHOWN_PAGES && query.includes(" ")) {
      const seen = new Set(hits.map((hit) => pageKey({ manualId: hit.manualId, page: hit.pageNumber })));
      const most = await searchManualsWithMost(shopId, query, SEARCHED_PAGES, searchable);
      hits.push(...most.hits.filter((hit) => !seen.has(pageKey({ manualId: hit.manualId, page: hit.pageNumber }))));
    }
  }
  const ranks = new Map(hits.map((hit) => [pageKey({ manualId: hit.manualId, page: hit.pageNumber }), hit.rank]));
  const how = new Map<string, PageCandidate["cited"]>();
  for (const page of cited.forSystem) how.set(pageKey(page), "system");
  for (const page of cited.forPart) how.set(pageKey(page), "part");
  const candidates = [...cited.forPart, ...cited.forSystem, ...hits.map((hit) => ({ manualId: hit.manualId, page: hit.pageNumber }))];
  const texts = await pageTexts(shopId, candidates);
  const ranked = rankPages(
    candidates.flatMap((page): PageCandidate[] => {
      const key = pageKey(page);
      const found = texts.get(key);
      if (!found) return [];
      const candidate = { ...page, title: found.title, text: found.text, rank: ranks.get(key) ?? 0, own: own.has(page.manualId.toLowerCase()), cited: how.get(key) ?? null };
      // Another cause's page that doesn't have this part isn't this part's.
      return candidate.cited === "system" && !ranks.has(key) && !mentionsPart(found.text, part) ? [] : [candidate];
    }),
    part,
    SHOWN_PAGES,
  );
  const pages = ranked.map((page) => ({ manualId: page.manualId, page: page.page, title: page.title, cited: page.cited !== null, about: aboutPart(page, part) }));
  const drawings = drawingPages(
    (await views).map((hit): PageCandidate => {
      const key = pageKey({ manualId: hit.manualId, page: hit.pageNumber });
      return { manualId: hit.manualId, page: hit.pageNumber, title: hit.title, text: hit.text, rank: hit.rank, own: own.has(hit.manualId.toLowerCase()), cited: how.get(key) ?? null };
    }),
    pages,
    part,
    SHOWN_DRAWING_PAGES,
  );

  let facts: PartSheet["facts"] = null;
  if (pages[0]?.about) {
    const page = { manualId: pages[0].manualId, page: pages[0].page };
    facts = { page, state: (await savedPageFacts(shopId, page)) ?? { status: "unavailable", reason: "error" } };
  }
  return { system, parts, part, pages, drawings, noManual: searchable.length === 0, facts };
}

// A page's card, read now if it never was (src/lib/manual-facts.ts). Only
// for a page of the conversation's manuals (its scope, else the unit's) or
// one its reply cites.
export async function partPageCard(
  user: CurrentUser,
  input: { conversationId: string; page: PageRef | null },
  options: { ask?: PageAsk | null } = {},
): Promise<PartCard | { error: string }> {
  if (!isUuid(input.conversationId)) return { error: NOT_HERE };
  const page = { manualId: String(input.page?.manualId ?? ""), page: Number(input.page?.page) };
  if (!isUuid(page.manualId) || !Number.isInteger(page.page) || page.page < 1) return { error: "That page isn't in the library." };
  const shopId = user.shop.id;
  const found = await loadConversation(shopId, input.conversationId);
  if (!found) return { error: NOT_HERE };
  const { conversation, reply } = found;
  const inManuals = (ids: string[]) => ids.some((id) => id.toLowerCase() === page.manualId.toLowerCase());
  const reachable =
    citedAnywhere(reply).has(pageKey(page)) ||
    inManuals(conversation.scopeManualIds ?? (await unitManualIds(shopId, conversation.unitModelNumber)));
  if (!reachable) return { error: "That page isn't in this unit's manuals." };
  const state = await readPageFacts(shopId, page, options);
  if (!state) return { error: "That page isn't in the library any more." };
  return { page, state };
}
