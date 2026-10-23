import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { diagnosisConversations, diagnosisTurns, users } from "@/db/schema";
import { giveBackAttempt, takeAttempt } from "@/lib/attempts";
import { runDiagnosisLoop, type ClaudeStream, type LoopResult, type ToolHandler } from "@/lib/diagnose-loop";
import { TOOL_NAMES, webSearchEnabled } from "@/lib/diagnose-prompt";
import {
  DIAGNOSE_LIMITS,
  FULL_BY_LENGTH,
  FULL_BY_MESSAGES,
  addTurnUsage,
  emptyUsage,
  finalizeReply,
  isUuid,
  mergeSeen,
  normalizeFaultCodes,
  partialReply,
  startMessage,
  unitLabel,
  type CauseVerdict,
  type ConversationView,
  type DiagnosisReply,
  type FeedbackEntry,
  type ProgressKind,
  type ProgressStep,
  type ScopeView,
  type SeenSources,
  type StreamEvent,
  type TurnUsage,
  type TurnView,
} from "@/lib/diagnose-rules";
import {
  describeScope,
  findUnitManuals,
  readScopedPage,
  searchScopedPages,
  unitVehicle,
  type ManualScope,
} from "@/lib/diagnose-tools";
import type { UnitVehicle } from "@/lib/diagnose-zones";
import { cleanLibraryFilters, hasLibraryFilters, listReadyManuals } from "@/lib/library";
import { VEHICLE_NAMES, brandLabel } from "@/lib/manual-catalog-rules";
import { cutText } from "@/lib/manual-rules";
import type { CurrentUser } from "@/lib/session";

// Diagnose's conversations: starting one, each tech message (a turn) and
// Claude's work on it, the tech's feedback on causes, and the shop's usage.
// Callers check diagnostics.work first; everything here runs inside withShop
// for the user's own shop.

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

// A running turn's server bumps heartbeat_at this often. One that hasn't for
// STALE_AFTER_MS (the function crashed or hit its time limit) is marked
// failed whenever the conversation is looked at, so nothing spins forever.
export const HEARTBEAT_MS = 10_000;
export const STALE_AFTER_MS = 45_000;
const STALE_MESSAGE = "This message stopped part way (the server restarted or ran out of time). Retry to send it again.";

// Vercel gives the route 300 seconds (maxDuration). Past the soft deadline
// the loop asks Claude to wrap up, leaving time for one full answer; at the
// hard one it cuts off any request still streaming and ends the message,
// leaving time to save it and what it used.
export const TURN_DEADLINE_MS = 280_000;
export const TURN_SOFT_DEADLINE_MS = 150_000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Problem = { error: string; status: number };

const nowIso = () => new Date().toISOString();

// Marks this shop's running turns whose server has gone quiet as failed.
export async function failStaleTurns(tx: ShopTransaction, conversationId?: string) {
  await tx
    .update(diagnosisTurns)
    .set({ status: "failed", error: STALE_MESSAGE, finishedAt: new Date() })
    .where(
      and(
        eq(diagnosisTurns.status, "running"),
        sql`${diagnosisTurns.heartbeatAt} < now() - make_interval(secs => ${STALE_AFTER_MS / 1000})`,
        conversationId ? eq(diagnosisTurns.conversationId, conversationId) : undefined,
      ),
    );
}

type ConversationRow = typeof diagnosisConversations.$inferSelect;
type TurnRow = typeof diagnosisTurns.$inferSelect;

function fullReason(conversation: Pick<ConversationRow, "techMessages" | "contextTokens">) {
  if (conversation.techMessages >= DIAGNOSE_LIMITS.techMessages) return FULL_BY_MESSAGES;
  if (conversation.contextTokens >= DIAGNOSE_LIMITS.contextTokens) return FULL_BY_LENGTH;
  return null;
}

const scopeOf = (conversation: Pick<ConversationRow, "scopeManualIds" | "unitLabel">): ManualScope => ({
  manualIds: conversation.scopeManualIds,
  label: conversation.unitLabel,
});

// What the screen needs to show a conversation's unit: its manuals, and
// which drawing it gets.
async function unitOf(shopId: string, conversation: ConversationRow) {
  const [scope, vehicle] = await Promise.all([
    describeScope(shopId, scopeOf(conversation)),
    unitVehicle(shopId, {
      modelNumber: conversation.unitModelNumber,
      manualIds: conversation.scopeManualIds,
      label: conversation.unitLabel,
    }),
  ]);
  return { scope, vehicle };
}

function toConversationView(
  conversation: ConversationRow,
  { scope, vehicle }: { scope: ScopeView; vehicle: UnitVehicle | null },
): ConversationView {
  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    unit: conversation.unitLabel,
    vehicle,
    scope,
    feedback: conversation.feedback,
    outcome: conversation.outcome ? { title: conversation.outcome.title, seq: conversation.outcome.seq } : null,
    techMessages: conversation.techMessages,
    full: fullReason(conversation),
  };
}

// The estimated cost stays in the database (for the month's figures), not
// on the screen: costCents is always null (see TurnView).
function toTurnView(turn: TurnRow, userName: string): TurnView {
  return {
    costCents: null,
    id: turn.id,
    seq: turn.seq,
    status: turn.status,
    techText: turn.techText,
    userName,
    createdAt: turn.createdAt.toISOString(),
    progress: turn.progress,
    reply: turn.reply ?? null,
    error: turn.error,
  };
}

async function userNames(tx: ShopTransaction, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

// --- Reading ---------------------------------------------------------------

export type ConversationSummary = {
  id: string;
  title: string;
  unit: string | null;
  status: ConversationView["status"];
  startedBy: string;
  techMessages: number;
  updatedAt: string;
  lastTurn: TurnView["status"] | null;
};

// The shop's conversations, most recently used first.
export async function listConversations(shopId: string, limit = 50): Promise<ConversationSummary[]> {
  return withShop(shopId, async (tx) => {
    await failStaleTurns(tx);
    const rows = await tx
      .select({
        id: diagnosisConversations.id,
        title: diagnosisConversations.title,
        unit: diagnosisConversations.unitLabel,
        status: diagnosisConversations.status,
        startedBy: users.name,
        techMessages: diagnosisConversations.techMessages,
        updatedAt: diagnosisConversations.updatedAt,
        lastTurn: sql<TurnView["status"] | null>`(
          select t.status from ${diagnosisTurns} t
          where t.conversation_id = ${diagnosisConversations.id} order by t.seq desc limit 1
        )`,
      })
      .from(diagnosisConversations)
      .innerJoin(users, eq(users.id, diagnosisConversations.userId))
      .orderBy(desc(diagnosisConversations.updatedAt))
      .limit(limit);
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
  });
}

export type ConversationDetail = { conversation: ConversationView; turns: TurnView[] };

// One conversation and its messages, after marking a turn that died as
// failed. Null when it isn't the shop's.
export async function getConversation(user: CurrentUser, id: string): Promise<ConversationDetail | null> {
  if (!isUuid(id)) return null;
  const found = await withShop(user.shop.id, async (tx) => {
    await failStaleTurns(tx, id);
    const [conversation] = await tx.select().from(diagnosisConversations).where(eq(diagnosisConversations.id, id));
    if (!conversation) return null;
    const turns = await tx
      .select()
      .from(diagnosisTurns)
      .where(eq(diagnosisTurns.conversationId, id))
      .orderBy(asc(diagnosisTurns.seq));
    const names = await userNames(tx, [...new Set(turns.map((turn) => turn.userId))]);
    return { conversation, turns, names };
  });
  if (!found) return null;
  return {
    conversation: toConversationView(found.conversation, await unitOf(user.shop.id, found.conversation)),
    turns: found.turns.map((turn) => toTurnView(turn, found.names.get(turn.userId) ?? "")),
  };
}

// One turn, for a page polling a turn another tab or a dropped connection
// left running.
export async function getTurn(user: CurrentUser, turnId: string) {
  if (!isUuid(turnId)) return null;
  return withShop(user.shop.id, async (tx) => {
    const [row] = await tx.select().from(diagnosisTurns).where(eq(diagnosisTurns.id, turnId));
    if (!row) return null;
    await failStaleTurns(tx, row.conversationId);
    const [turn] = await tx.select().from(diagnosisTurns).where(eq(diagnosisTurns.id, turnId));
    const names = await userNames(tx, [turn.userId]);
    return toTurnView(turn, names.get(turn.userId) ?? "");
  });
}

export type MonthStats = {
  conversations: number;
  messages: number;
  webSearches: number;
  costCents: number;
  solved: number;
  // Of those, how many the tech confirmed was Claude's top-ranked cause.
  solvedTopCause: number;
};

// This calendar month (UTC) for the shop, for managers and admins.
export async function monthStats(shopId: string): Promise<MonthStats> {
  return withShop(shopId, async (tx) => {
    const month = sql`date_trunc('month', now())`;
    const [conversations] = await tx
      .select({
        started: sql<number>`count(*)::int`,
        solved: sql<number>`(count(*) filter (where ${diagnosisConversations.status} = 'solved'))::int`,
        top: sql<number>`(count(*) filter (where (${diagnosisConversations.outcome} ->> 'rank')::int = 1))::int`,
      })
      .from(diagnosisConversations)
      .where(sql`${diagnosisConversations.createdAt} >= ${month}`);
    const [turns] = await tx
      .select({
        messages: sql<number>`count(*)::int`,
        webSearches: sql<number>`coalesce(sum(${diagnosisTurns.webSearches}), 0)::int`,
        costCents: sql<number>`coalesce(sum(${diagnosisTurns.costCents}), 0)::float8`,
      })
      .from(diagnosisTurns)
      .where(sql`${diagnosisTurns.createdAt} >= ${month}`);
    return {
      conversations: conversations.started,
      messages: turns.messages,
      webSearches: turns.webSearches,
      costCents: turns.costCents,
      solved: conversations.solved,
      solvedTopCause: conversations.top,
    };
  });
}

// --- Starting a turn -------------------------------------------------------

// What the quick form or the free-typed box sends to start a conversation.
export type StartInput = {
  modelNumber?: string;
  vehicle?: string;
  brand?: string;
  year?: string;
  model?: string;
  complaint?: string;
  faultCodes?: string;
  checked?: string;
  message?: string;
  // Carry the unit and manuals over from a conversation that's full.
  from?: string;
};

export type TurnRequest = { conversationId?: string; start?: StartInput; text?: string; retryTurnId?: string };

type Prepared = {
  user: CurrentUser;
  conversation: ConversationRow;
  turn: TurnRow;
  history: MessageParam[];
  previousSeen: SeenSources;
  previousReply: DiagnosisReply | null;
  notes: string[];
  // The feedback entries this turn tells Claude about.
  feedbackSent: Set<string>;
  removeWebSearch: boolean;
  conversationView: ConversationView;
  turnView: TurnView;
};

const str = (value: unknown, max: number) => (typeof value === "string" ? cutText(value.replace(/\u0000/g, "").trim(), max) : "");

function scopeNote(label: string | null, manualTitles: string[], how: string) {
  if (!label) return "No unit has been picked yet: searches use the shop's whole library. Find the unit when you can.";
  const list = manualTitles.slice(0, 12).join("; ");
  return `${how}: ${label}. Searches and page reads use ${manualTitles.length === 1 ? "its manual" : `its ${manualTitles.length} manuals`}: ${list}${manualTitles.length > 12 ? "; …" : ""}.`;
}

// Works out a new conversation's unit, manuals, title and first message.
async function planStart(user: CurrentUser, start: StartInput) {
  const shopId = user.shop.id;
  const complaint = str(start.complaint, 1000);
  const message = str(start.message, DIAGNOSE_LIMITS.techText);
  const codes = normalizeFaultCodes(str(start.faultCodes, 400));
  const checked = str(start.checked, 1000);
  if (!complaint && !message && codes.length === 0) {
    return { error: "Say what the unit is doing (the complaint), or type a message.", status: 400 } as Problem;
  }

  let unit: { modelNumber: string | null; year: number | null; label: string } | null = null;
  let manualIds: string[] | null = null;
  let notes: string[] = [];
  const modelNumber = str(start.modelNumber, 64);
  const filters = cleanLibraryFilters({
    vehicle: str(start.vehicle, 40),
    brand: str(start.brand, 40),
    year: str(start.year, 4),
    model: str(start.model, 60),
  });

  if (start.from && isUuid(start.from)) {
    const [earlier] = await withShop(shopId, (tx) =>
      tx.select().from(diagnosisConversations).where(eq(diagnosisConversations.id, start.from!)),
    );
    if (earlier?.unitLabel) {
      unit = { modelNumber: earlier.unitModelNumber, year: earlier.unitYear, label: earlier.unitLabel };
      manualIds = earlier.scopeManualIds;
    }
  }
  if (!unit && modelNumber) {
    const lookup = await findUnitManuals(shopId, { model_number: modelNumber });
    if (lookup.scope) {
      unit = {
        modelNumber: lookup.scope.unit?.number ?? modelNumber.toUpperCase(),
        year: lookup.scope.unit?.year ?? null,
        label: lookup.scope.label ?? modelNumber.toUpperCase(),
      };
      manualIds = lookup.scope.manualIds;
    } else if (lookup.listed) {
      // In the model list, but no manual for it is in the library.
      const listed = lookup.listed;
      const name = [listed.year, listed.description].filter(Boolean).join(" ");
      notes.push(
        `The tech entered model number ${listed.number}${name ? `, a ${name}` : ""}. It's in the shop's model list, but the shop has no manual for it: searches use the whole library.`,
      );
      unit = { modelNumber: listed.number, year: listed.year, label: unitLabel(listed) };
    } else {
      notes.push(
        `The tech entered model number ${modelNumber.toUpperCase()}, which isn't in the shop's model list. Searches use the whole library.`,
      );
      unit = { modelNumber: modelNumber.toUpperCase(), year: null, label: modelNumber.toUpperCase() };
    }
  } else if (!unit && hasLibraryFilters(filters)) {
    const found = await listReadyManuals(shopId, filters);
    // "2019 RZR XP 1000", "2019 Ranger", or "UTVs (side-by-sides)".
    const line = filters.brand ? brandLabel(filters.brand) : filters.vehicle ? VEHICLE_NAMES[filters.vehicle] : "";
    const label = [filters.year, filters.model ?? line].filter(Boolean).join(" ") || line;
    unit = { modelNumber: null, year: filters.year ?? null, label };
    if (found.length > 0) manualIds = found.map((manual) => manual.id);
    else notes.push(`No manuals in the shop's library match ${label}. Searches use the whole library.`);
  }

  if (manualIds !== null && unit) {
    const scope = await describeScope(shopId, { manualIds, label: unit.label });
    manualIds = scope.manuals.map((manual) => manual.id);
    notes = [scopeNote(unit.label, scope.manuals.map((manual) => manual.title), "The tech picked the unit")];
  } else if (notes.length === 0) {
    notes.push(scopeNote(null, [], ""));
  }

  const techText = startMessage({ unit: unit?.label ?? null, complaint, faultCodes: codes, checked, more: message });
  const subject = complaint || message.split("\n")[0] || codes.join(", ");
  const title = cutText([unit?.label.split(" — ")[0], subject].filter(Boolean).join(" — "), 120);
  return { unit, manualIds, notes, techText, title };
}

// The messages a turn adds before Claude's reply: the tech's text, then the
// app's notes (and the removal of web search, when it's been turned off since
// the conversation began) as a system message, the channel the tech's own
// text can't imitate.
function openingMessages(techText: string, notes: string[], removeWebSearch: boolean): MessageParam[] {
  const opening: MessageParam[] = [{ role: "user", content: [{ type: "text", text: techText }] }];
  const system: Anthropic.Beta.Messages.BetaSystemMessageParam["content"] = [
    ...(notes.length > 0 ? [{ type: "text" as const, text: notes.join("\n\n") }] : []),
    ...(removeWebSearch
      ? [{ type: "tool_removal" as const, tool: { type: "tool_reference" as const, name: TOOL_NAMES.web } }]
      : []),
  ];
  if (system.length > 0) opening.push({ role: "system", content: system });
  return opening;
}

const feedbackKey = (entry: FeedbackEntry) => `${entry.at}|${entry.turnId}|${entry.index}`;

function feedbackNotes(feedback: FeedbackEntry[]) {
  const said: Record<CauseVerdict, string> = {
    ruled_out: "as ruled out (checked and fine)",
    confirmed: "as the cause: “This was it”",
    open: "as open again",
  };
  const lines = feedback.map((entry) => `- “${entry.title}” ${said[entry.verdict]}`);
  return lines.length > 0 ? [`Since your last reply the tech marked:\n${lines.join("\n")}`] : [];
}

// Everything about a conversation a new turn needs, read in the turn's
// transaction.
async function loadForTurn(tx: ShopTransaction, conversationId: string) {
  const [conversation] = await tx
    .select()
    .from(diagnosisConversations)
    .where(eq(diagnosisConversations.id, conversationId))
    .for("update");
  if (!conversation) return null;
  const turns = await tx
    .select()
    .from(diagnosisTurns)
    .where(eq(diagnosisTurns.conversationId, conversationId))
    .orderBy(asc(diagnosisTurns.seq));
  return { conversation, turns };
}

// Takes one message from the tech's hourly allowance and the shop's daily
// one, or says when they can send again.
async function takeMessageAllowance(user: CurrentUser): Promise<Problem | null> {
  const userKey = `diagnose:user:${user.id}`;
  const mine = await takeAttempt(userKey, DIAGNOSE_LIMITS.messagesPerUserPerHour, HOUR_MS);
  if (!mine.allowed) {
    const minutes = Math.max(1, Math.ceil(mine.retryAfterMs / 60_000));
    return {
      error: `You've sent ${DIAGNOSE_LIMITS.messagesPerUserPerHour} messages to Claude in the last hour, the most allowed. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      status: 429,
    };
  }
  const shop = await takeAttempt(`diagnose:shop:${user.shop.id}`, DIAGNOSE_LIMITS.messagesPerShopPerDay, DAY_MS);
  if (!shop.allowed) {
    await giveBackAttempt(userKey);
    const hours = Math.max(1, Math.ceil(shop.retryAfterMs / HOUR_MS));
    return {
      error: `The shop has sent ${DIAGNOSE_LIMITS.messagesPerShopPerDay} messages to Claude today, the most allowed. It opens up again in about ${hours} hour${hours === 1 ? "" : "s"}.`,
      status: 429,
    };
  }
  return null;
}

async function giveBackAllowance(user: CurrentUser) {
  await giveBackAttempt(`diagnose:user:${user.id}`);
  await giveBackAttempt(`diagnose:shop:${user.shop.id}`);
}

// Checks a turn request, counts it against the limits, and saves the turn as
// running. Returns what runTurn needs, or a problem for the tech.
export async function prepareTurn(user: CurrentUser, request: TurnRequest): Promise<Prepared | Problem> {
  const shopId = user.shop.id;
  const text = str(request.text, DIAGNOSE_LIMITS.techText + 1);
  if (text.length > DIAGNOSE_LIMITS.techText) {
    return { error: `Keep a message under ${DIAGNOSE_LIMITS.techText.toLocaleString("en-US")} characters.`, status: 400 };
  }
  const plan = request.start ? await planStart(user, request.start) : null;
  if (plan && "error" in plan) return plan;
  if (!plan) {
    if (!isUuid(request.conversationId)) return { error: "That diagnosis isn't in this shop.", status: 404 };
    if (!request.retryTurnId && !text) return { error: "Type a message first.", status: 400 };
    // Checked before taking from the allowance; checked again below.
    const quick = await withShop(shopId, async (tx) => {
      await failStaleTurns(tx, request.conversationId);
      return loadForTurn(tx, request.conversationId!);
    });
    if (!quick) return { error: "That diagnosis isn't in this shop.", status: 404 };
    const full = fullReason(quick.conversation);
    if (full && !request.retryTurnId) return { error: full, status: 409 };
    if (quick.turns.some((turn) => turn.status === "running")) {
      return { error: "Claude is still answering the last message. Wait for it, or stop it first.", status: 409 };
    }
  }

  const limited = await takeMessageAllowance(user);
  if (limited) return limited;

  const saved = await withShop(shopId, async (tx): Promise<Omit<Prepared, "conversationView" | "turnView"> | Problem> => {
    let conversation: ConversationRow;
    let turns: TurnRow[] = [];
    if (plan) {
      [conversation] = await tx
        .insert(diagnosisConversations)
        .values({
          shopId,
          userId: user.id,
          title: plan.title,
          unitModelNumber: plan.unit?.modelNumber ?? null,
          unitYear: plan.unit?.year ?? null,
          unitLabel: plan.unit?.label ?? null,
          scopeManualIds: plan.manualIds,
          webSearch: webSearchEnabled(),
          pendingNotes: plan.notes,
        })
        .returning();
    } else {
      const loaded = await loadForTurn(tx, request.conversationId!);
      if (!loaded) return { error: "That diagnosis isn't in this shop.", status: 404 };
      ({ conversation, turns } = loaded);
      if (turns.some((turn) => turn.status === "running")) {
        return { error: "Claude is still answering the last message. Wait for it, or stop it first.", status: 409 };
      }
    }

    const done = turns.filter((turn) => turn.status === "done");
    let turn: TurnRow;
    if (request.retryTurnId) {
      const last = turns.at(-1);
      if (!last || last.id !== request.retryTurnId || (last.status !== "failed" && last.status !== "stopped")) {
        return { error: "Only the last message can be retried, once it has failed or been stopped.", status: 409 };
      }
      [turn] = await tx
        .update(diagnosisTurns)
        .set({
          status: "running",
          error: null,
          progress: [],
          attempts: last.attempts + 1,
          heartbeatAt: new Date(),
          stopRequestedAt: null,
          finishedAt: null,
        })
        .where(eq(diagnosisTurns.id, last.id))
        .returning();
    } else {
      [turn] = await tx
        .insert(diagnosisTurns)
        .values({
          conversationId: conversation.id,
          shopId,
          seq: (turns.at(-1)?.seq ?? 0) + 1,
          userId: user.id,
          techText: plan ? plan.techText : text,
        })
        .returning();
    }
    const unsent = conversation.feedback.filter((entry) => entry.sentInSeq === null);
    return {
      user,
      conversation,
      turn,
      history: done.flatMap((row) => (row.history ?? []) as MessageParam[]),
      previousSeen: mergeSeen(...done.map((row) => row.seen)),
      previousReply: done.at(-1)?.reply ?? null,
      notes: [...conversation.pendingNotes, ...feedbackNotes(unsent)],
      feedbackSent: new Set(unsent.map(feedbackKey)),
      removeWebSearch: conversation.webSearch && !conversation.webSearchRemoved && !webSearchEnabled(),
    };
  });
  if ("error" in saved) {
    await giveBackAllowance(user);
    return saved;
  }
  return {
    ...saved,
    conversationView: toConversationView(saved.conversation, await unitOf(shopId, saved.conversation)),
    turnView: toTurnView(saved.turn, user.name),
  };
}

export const isProblem = (value: Prepared | Problem): value is Problem => "error" in value;

// --- Running a turn --------------------------------------------------------

// Runs Claude on a prepared turn and saves the outcome. emit gets the
// stream events for the browser; it may stop listening (a closed tab) and
// the turn still finishes and is saved. Stop is requested through the
// database (requestStop), which the heartbeat notices.
export async function runTurn(
  prepared: Prepared,
  options: { client: ClaudeStream; emit: (event: StreamEvent) => void },
) {
  const { user, conversation, turn } = prepared;
  const shopId = user.shop.id;
  const emit = (event: StreamEvent) => {
    try {
      options.emit(event);
    } catch {
      // The browser went away; the turn carries on.
    }
  };
  const progress: ProgressStep[] = [];
  const abort = new AbortController();
  const scope: ManualScope = scopeOf(conversation);
  let scopeChanged = false;
  let dirty = false;
  let saving: Promise<unknown> = Promise.resolve();

  // Saves the progress so far and bumps the heartbeat, one write at a time;
  // a stop asked for from another request shows up here.
  const beat = () => {
    dirty = false;
    saving = saving.then(async () => {
      try {
        const [row] = await withShop(shopId, (tx) =>
          tx
            .update(diagnosisTurns)
            .set({ heartbeatAt: new Date(), progress: [...progress] })
            .where(and(eq(diagnosisTurns.id, turn.id), eq(diagnosisTurns.status, "running")))
            .returning({ stopRequestedAt: diagnosisTurns.stopRequestedAt }),
        );
        if (!row || row.stopRequestedAt) abort.abort();
      } catch (error) {
        console.error("Couldn't save Diagnose progress", error);
      }
    });
  };
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  const progressTimer = setInterval(() => dirty && beat(), 1500);

  const onProgress = (kind: ProgressKind, label: string) => {
    const step = { kind, label: cutText(label, 200), at: nowIso() };
    progress.push(step);
    dirty = true;
    emit({ type: "progress", step });
  };

  const tools: ToolHandler = async (name, input) => {
    if (name === TOOL_NAMES.findUnit) {
      const lookup = await findUnitManuals(shopId, input);
      const asked = [input.model_number, input.year, input.description].filter((v) => typeof v === "string" || typeof v === "number").join(" ");
      if (!lookup.scope) return { result: lookup.result, progress: { kind: "unit", label: `Looking up the unit: ${asked}` } };
      scope.manualIds = lookup.scope.manualIds;
      scope.label = lookup.scope.label;
      scopeChanged = true;
      await withShop(shopId, (tx) =>
        tx
          .update(diagnosisConversations)
          .set({
            scopeManualIds: scope.manualIds,
            unitLabel: scope.label,
            unitModelNumber: lookup.scope!.unit?.number ?? null,
            unitYear: lookup.scope!.unit?.year ?? null,
          })
          .where(eq(diagnosisConversations.id, conversation.id)),
      );
      const [view, vehicle] = await Promise.all([
        describeScope(shopId, scope),
        unitVehicle(shopId, { modelNumber: lookup.scope.unit?.number ?? null, manualIds: scope.manualIds, label: scope.label }),
      ]);
      emit({ type: "scope", scope: view, vehicle });
      const count = view.manuals.length;
      return {
        result: lookup.result,
        progress: { kind: "unit", label: `Using ${count} ${count === 1 ? "manual" : "manuals"} for ${scope.label}` },
      };
    }
    if (name === TOOL_NAMES.search) {
      const { hits, result } = await searchScopedPages(shopId, scope, input.query);
      return {
        result,
        isError: "error" in result,
        seen: { pages: hits.map((hit) => ({ manualId: hit.manualId, page: hit.pageNumber, title: hit.title })) },
        progress: { kind: "search", label: `Searching your manuals: ${String(input.query ?? "")}` },
      };
    }
    const read = await readScopedPage(shopId, scope, input);
    return read.ok
      ? {
          result: read.result,
          seen: { pages: [{ manualId: read.manualId, page: read.page, title: read.title }] },
          progress: { kind: "read", label: `Reading page ${read.page} — ${read.title}` },
        }
      : { result: read.result, isError: true, progress: { kind: "note", label: `Couldn't read page ${String(input.page ?? "")}` } };
  };

  const started = Date.now();
  let result: LoopResult;
  try {
    result = await runDiagnosisLoop({
      client: options.client,
      history: prepared.history,
      opening: openingMessages(turn.techText, prepared.notes, prepared.removeWebSearch),
      webSearch: conversation.webSearch,
      tools,
      signal: abort.signal,
      deadline: started + TURN_DEADLINE_MS,
      softDeadline: started + TURN_SOFT_DEADLINE_MS,
      onProgress,
      onReply: (text) => emit({ type: "reply", text }),
    });
  } catch (error) {
    console.error("Diagnose turn failed", error);
    result = {
      status: "failed",
      reason: "error",
      message: "Something went wrong on the shop's side. Retry.",
      seen: { pages: [], urls: [] },
      usage: emptyUsage(),
    };
  } finally {
    clearInterval(heartbeat);
    clearInterval(progressTimer);
  }
  await saving;
  return saveOutcome(prepared, result, { progress, scopeChanged, scope, emit });
}

async function saveOutcome(
  prepared: Prepared,
  result: LoopResult,
  extra: {
    progress: ProgressStep[];
    scopeChanged: boolean;
    scope: ManualScope;
    emit: (event: StreamEvent) => void;
  },
) {
  const { user, conversation, turn } = prepared;
  const usage: TurnUsage = result.usage;
  const costCents = usage.costCents;
  const done = result.status === "done";
  const reply = done
    ? result.submitted !== null
      ? finalizeReply(result.submitted, mergeSeen(prepared.previousSeen, result.seen))
      : partialReply(result.text, prepared.previousReply)
    : null;
  const consumedNotes = conversation.pendingNotes.length;

  const saved = await withShop(user.shop.id, async (tx) => {
    const [current] = await tx
      .select()
      .from(diagnosisConversations)
      .where(eq(diagnosisConversations.id, conversation.id))
      .for("update");
    // A retry is the same row, and its earlier attempts were billed too:
    // their tokens, web searches and cost are added to, never replaced.
    const [before] = await tx
      .select({ usage: diagnosisTurns.usage, webSearches: diagnosisTurns.webSearches, costCents: diagnosisTurns.costCents })
      .from(diagnosisTurns)
      .where(eq(diagnosisTurns.id, turn.id))
      .for("update");
    const [savedTurn] = await tx
      .update(diagnosisTurns)
      .set({
        status: done ? "done" : result.status,
        history: done ? result.appended : null,
        reply,
        progress: extra.progress,
        seen: result.seen,
        usage: addTurnUsage(before?.usage, usage),
        webSearches: (before?.webSearches ?? 0) + usage.webSearches,
        costCents: (before?.costCents ?? 0) + costCents,
        error: done ? null : result.message,
        finishedAt: new Date(),
      })
      .where(eq(diagnosisTurns.id, turn.id))
      .returning();
    // Tokens are spent either way; the message only counts once it's done.
    const notes = done ? current.pendingNotes.slice(consumedNotes) : [...current.pendingNotes];
    if (!done && extra.scopeChanged) {
      notes.push(`Claude looked the unit up in a message that didn't finish: searches and page reads now use the manuals for ${extra.scope.label}.`);
    }
    const [updated] = await tx
      .update(diagnosisConversations)
      .set({
        techMessages: current.techMessages + (done ? 1 : 0),
        inputTokens: current.inputTokens + usage.inputTokens,
        outputTokens: current.outputTokens + usage.outputTokens,
        cacheReadTokens: current.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: current.cacheWriteTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens,
        webSearches: current.webSearches + usage.webSearches,
        costCents: current.costCents + costCents,
        contextTokens: done ? usage.contextTokens : current.contextTokens,
        pendingNotes: notes,
        webSearchRemoved: current.webSearchRemoved || (done && prepared.removeWebSearch),
        feedback: done
          ? current.feedback.map((entry) =>
              entry.sentInSeq === null && prepared.feedbackSent.has(feedbackKey(entry)) ? { ...entry, sentInSeq: turn.seq } : entry,
            )
          : current.feedback,
      })
      .where(eq(diagnosisConversations.id, conversation.id))
      .returning();
    return { turn: savedTurn, conversation: updated };
  });
  const turnView = toTurnView(saved.turn, user.name);
  const conversationView = toConversationView(saved.conversation, await unitOf(user.shop.id, saved.conversation));
  extra.emit({ type: "end", conversation: conversationView, turn: turnView });
  return { turn: turnView, conversation: conversationView };
}

// Asks the server running a turn to stop it (the Stop button).
export async function requestStop(user: CurrentUser, turnId: string) {
  if (!isUuid(turnId)) return false;
  const rows = await withShop(user.shop.id, (tx) =>
    tx
      .update(diagnosisTurns)
      .set({ stopRequestedAt: new Date() })
      .where(and(eq(diagnosisTurns.id, turnId), eq(diagnosisTurns.status, "running")))
      .returning({ id: diagnosisTurns.id }),
  );
  return rows.length > 0;
}

// --- Feedback and the unit -------------------------------------------------

// "Ruled out" / "This was it" (or undoing either, "open") on a cause of one of
// Claude's replies. Claude hears about it with the next message; "This was
// it" also records the conversation's outcome for AI-accuracy figures.
export async function markCause(
  user: CurrentUser,
  input: { conversationId: string; turnId: string; index: number; verdict: CauseVerdict },
): Promise<{ feedback: FeedbackEntry[]; outcome: ConversationView["outcome"]; status: ConversationView["status"] } | { error: string }> {
  const { conversationId, turnId, index, verdict } = input;
  if (!isUuid(conversationId) || !isUuid(turnId) || !Number.isInteger(index) || index < 0) {
    return { error: "That cause isn't there any more. Reload the page." };
  }
  if (verdict !== "ruled_out" && verdict !== "confirmed" && verdict !== "open") return { error: "That isn't a choice." };
  return withShop(user.shop.id, async (tx) => {
    const [conversation] = await tx
      .select()
      .from(diagnosisConversations)
      .where(eq(diagnosisConversations.id, conversationId))
      .for("update");
    const [turn] = await tx
      .select({ seq: diagnosisTurns.seq, reply: diagnosisTurns.reply })
      .from(diagnosisTurns)
      .where(and(eq(diagnosisTurns.id, turnId), eq(diagnosisTurns.conversationId, conversationId)));
    const cause = turn?.reply?.likelyCauses[index];
    if (!conversation || !turn || !cause) return { error: "That cause isn't there any more. Reload the page." };
    const entry: FeedbackEntry = {
      turnId,
      seq: turn.seq,
      index,
      title: cause.title,
      likelihood: cause.likelihood,
      verdict,
      userId: user.id,
      userName: user.name,
      at: nowIso(),
      sentInSeq: null,
    };
    // An unsent press on the same cause is replaced; once Claude has heard
    // about one, a change is a new entry.
    const sameCause = (other: FeedbackEntry) => other.title.toLowerCase() === cause.title.toLowerCase();
    const feedback = [...conversation.feedback.filter((other) => !(other.sentInSeq === null && sameCause(other))), entry];
    const isOutcome = conversation.outcome?.title.toLowerCase() === cause.title.toLowerCase();
    const outcome =
      verdict === "confirmed"
        ? { title: cause.title, likelihood: cause.likelihood, rank: index + 1, seq: turn.seq, userId: user.id, at: entry.at }
        : isOutcome
          ? null
          : conversation.outcome;
    const [updated] = await tx
      .update(diagnosisConversations)
      .set({ feedback, outcome, status: outcome ? "solved" : "open" })
      .where(eq(diagnosisConversations.id, conversationId))
      .returning();
    return {
      feedback: updated.feedback,
      outcome: updated.outcome ? { title: updated.outcome.title, seq: updated.outcome.seq } : null,
      status: updated.status,
    };
  });
}

// The tech changes the unit (or goes back to the whole library) between
// messages. Claude is told with the next message.
export async function changeUnit(
  user: CurrentUser,
  input: { conversationId: string; modelNumber?: string; wholeLibrary?: boolean },
): Promise<{ scope: ScopeView; unit: string | null; vehicle: UnitVehicle | null } | { error: string }> {
  if (!isUuid(input.conversationId)) return { error: "That diagnosis isn't in this shop." };
  const shopId = user.shop.id;
  let next: { manualIds: string[] | null; label: string | null; number: string | null; year: number | null };
  let note: string;
  if (input.wholeLibrary) {
    next = { manualIds: null, label: null, number: null, year: null };
    note = "The tech switched to the shop's whole library: searches and page reads can use any manual now.";
  } else {
    const number = str(input.modelNumber, 64);
    if (!number) return { error: "Type the model number (on the frame or VIN plate)." };
    const lookup = await findUnitManuals(shopId, { model_number: number });
    if (!lookup.scope) return { error: `${number.toUpperCase()} isn't in the shop's model list, or has no manuals in the library.` };
    next = {
      manualIds: lookup.scope.manualIds,
      label: lookup.scope.label,
      number: lookup.scope.unit?.number ?? number.toUpperCase(),
      year: lookup.scope.unit?.year ?? null,
    };
    const titles = (await describeScope(shopId, lookup.scope)).manuals.map((manual) => manual.title);
    note = scopeNote(next.label, titles, "The tech changed the unit");
  }
  const updated = await withShop(shopId, async (tx) => {
    const [conversation] = await tx
      .select({ pendingNotes: diagnosisConversations.pendingNotes })
      .from(diagnosisConversations)
      .where(eq(diagnosisConversations.id, input.conversationId))
      .for("update");
    if (!conversation) return null;
    const [row] = await tx
      .update(diagnosisConversations)
      .set({
        scopeManualIds: next.manualIds,
        unitLabel: next.label,
        unitModelNumber: next.number,
        unitYear: next.year,
        pendingNotes: [...conversation.pendingNotes, note],
      })
      .where(eq(diagnosisConversations.id, input.conversationId))
      .returning();
    return row;
  });
  if (!updated) return { error: "That diagnosis isn't in this shop." };
  const { scope, vehicle } = await unitOf(shopId, updated);
  return { scope, unit: updated.unitLabel, vehicle };
}

// What a new diagnosis starts with when it carries on from a full one: the
// unit and a summary of where things stood.
export async function carryOver(user: CurrentUser, id: string) {
  const detail = await getConversation(user, id);
  if (!detail) return null;
  const reply = detail.turns.filter((turn) => turn.status === "done").at(-1)?.reply;
  const lines = ["Carrying on from an earlier diagnosis of this unit."];
  if (reply?.likelyCauses.length) {
    lines.push(
      "Likely causes so far:",
      ...reply.likelyCauses.map((cause) => `- ${cause.title} (${cause.status === "open" ? cause.likelihood : cause.status.replace("_", " ")})`),
    );
  }
  if (reply?.nextChecks.length) lines.push("Checks that were next:", ...reply.nextChecks.map((check) => `- ${check.action}`));
  return { id: detail.conversation.id, unit: detail.conversation.unit, text: lines.join("\n") };
}
