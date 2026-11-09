import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { diagnosisConversations, diagnosisTimeSpans, users } from "@/db/schema";
import { applyPlan, clockPlan, clockView, latestSpan, type ClockEvent, type ClockSpan, type ClockView } from "@/lib/diagnose-clock-rules";
import { isUuid } from "@/lib/diagnose-rules";
import type { CurrentUser } from "@/lib/session";

// The clock on a diagnosis, kept in diagnosis_time_spans (the rules are in
// src/lib/diagnose-clock-rules.ts). Diagnose moves it as the work goes:
// starting a diagnosis starts it, sending Claude a message, ticking a check,
// marking a cause and changing the unit are work on it, Claude finishing a
// message keeps it going, and "This was it" ends it (src/lib/diagnose.ts);
// the page's own use, Pause, End, Resume and the gap question come through
// /api/diagnose/clock. Everything here runs in the caller's shop
// transaction with the diagnosis's row locked (select … for update), as
// every change to a diagnosis is, so two requests never move one clock at
// once. Times are the database's clock at that moment.

type SpanRow = typeof diagnosisTimeSpans.$inferSelect;

const toSpan = (row: SpanRow): ClockSpan => ({
  id: row.id,
  seq: row.seq,
  userId: row.userId,
  startedAt: row.startedAt.getTime(),
  endedAt: row.endedAt.getTime(),
  stop: row.stop,
  gapFrom: row.gapFrom?.getTime() ?? null,
});

async function readSpans(tx: ShopTransaction, conversationId: string) {
  const rows = await tx
    .select()
    .from(diagnosisTimeSpans)
    .where(eq(diagnosisTimeSpans.conversationId, conversationId))
    .orderBy(asc(diagnosisTimeSpans.seq));
  return rows.map(toSpan);
}

// The time now (not the transaction's start, which can be before a stretch
// another request just moved on).
async function dbNow(tx: ShopTransaction) {
  const result = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
  return new Date(result.rows[0].now).getTime();
}

async function viewFor(tx: ShopTransaction, spans: ClockSpan[], viewerId: string, now: number) {
  const latest = latestSpan(spans);
  if (!latest) return null;
  const [person] = await tx.select({ name: users.name }).from(users).where(eq(users.id, latest.userId));
  return clockView(spans, viewerId, now, new Map(person ? [[latest.userId, person.name]] : []));
}

// Starts the clock on a diagnosis just started: its first stretch, from now.
export async function startClock(tx: ShopTransaction, conversation: { id: string; shopId: string }, user: CurrentUser): Promise<ClockView | null> {
  const now = await dbNow(tx);
  const [row] = await tx
    .insert(diagnosisTimeSpans)
    .values({ shopId: conversation.shopId, conversationId: conversation.id, seq: 1, userId: user.id, startedAt: new Date(now), endedAt: new Date(now) })
    .returning();
  return viewFor(tx, [toSpan(row)], user.id, now);
}

// Moves the clock for something that happened (see ClockEvent), and gives
// the clock as `viewer` sees it after.
export async function moveClock(
  tx: ShopTransaction,
  conversation: { id: string; shopId: string },
  event: ClockEvent,
  viewer: CurrentUser,
): Promise<ClockView | null> {
  const spans = await readSpans(tx, conversation.id);
  const now = await dbNow(tx);
  const plan = clockPlan(latestSpan(spans), event, now);
  const date = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms));
  // The stretch that stops goes first: only one can be going at a time.
  if (plan.update) {
    const { id, endedAt, startedAt, stop, gapFrom } = plan.update;
    await tx
      .update(diagnosisTimeSpans)
      .set({ endedAt: date(endedAt), startedAt: date(startedAt), stop, gapFrom })
      .where(eq(diagnosisTimeSpans.id, id));
  }
  let added: string | undefined;
  if (plan.add) {
    const { seq, userId, startedAt, endedAt, stop, gapFrom } = plan.add;
    const [row] = await tx
      .insert(diagnosisTimeSpans)
      .values({
        shopId: conversation.shopId,
        conversationId: conversation.id,
        seq,
        userId,
        startedAt: new Date(startedAt),
        endedAt: new Date(endedAt),
        stop,
        gapFrom: gapFrom === null ? null : new Date(gapFrom),
      })
      .returning({ id: diagnosisTimeSpans.id });
    added = row.id;
  }
  return viewFor(tx, applyPlan(spans, plan, added), viewer.id, now);
}

// The clock as `viewer` sees it, without moving it.
export async function readClock(tx: ShopTransaction, conversationId: string, viewer: CurrentUser): Promise<ClockView | null> {
  const spans = await readSpans(tx, conversationId);
  return viewFor(tx, spans, viewer.id, await dbNow(tx));
}

// What the clock's own buttons and the page's use do.
export const CLOCK_ACTIONS = ["look", "use", "pause", "end", "resume", "keep-gap", "drop-gap"] as const;
export type ClockAction = (typeof CLOCK_ACTIONS)[number];

const eventFor = (action: Exclude<ClockAction, "look">, user: CurrentUser, ago: number): ClockEvent => {
  switch (action) {
    case "use":
      return { kind: "use", userId: user.id, ago };
    case "pause":
    case "end":
      return { kind: "stop", userId: user.id, stop: action };
    case "resume":
      return { kind: "resume", userId: user.id };
    case "keep-gap":
    case "drop-gap":
      return { kind: "gap", userId: user.id, keep: action === "keep-gap" };
  }
};

// One of the clock's actions on a diagnosis of the user's shop (Diagnose's
// people check that first); "use" says how long ago the page was last used
// (`ago`, milliseconds). Null clock: a diagnosis started before the clock
// was added.
export async function clockAction(
  user: CurrentUser,
  input: { conversationId: string; action: ClockAction; ago?: number },
): Promise<{ clock: ClockView | null } | { error: string; status: number }> {
  if (!isUuid(input.conversationId)) return { error: "That diagnosis isn't in this shop.", status: 404 };
  if (!(CLOCK_ACTIONS as readonly string[]).includes(input.action)) return { error: "That isn't something the clock does.", status: 400 };
  const ago = Number.isFinite(input.ago) ? Number(input.ago) : 0;
  return withShop(user.shop.id, async (tx) => {
    const find = tx
      .select({ id: diagnosisConversations.id, shopId: diagnosisConversations.shopId })
      .from(diagnosisConversations)
      .where(eq(diagnosisConversations.id, input.conversationId));
    const [conversation] = input.action === "look" ? await find : await find.for("update");
    if (!conversation) return { error: "That diagnosis isn't in this shop.", status: 404 };
    const clock =
      input.action === "look" ? await readClock(tx, conversation.id, user) : await moveClock(tx, conversation, eventFor(input.action, user, ago), user);
    return { clock };
  });
}
