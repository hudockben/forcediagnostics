"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { unstable_rethrow } from "next/navigation";

import { changeUnit, getConversation, markCause, requestStop, type ConversationDetail } from "@/lib/diagnose";
import type { CauseVerdict, ConversationView, FeedbackEntry, ScopeView, UnitSuggestion } from "@/lib/diagnose-rules";
import { suggestUnits } from "@/lib/diagnose-tools";
import type { UnitVehicle } from "@/lib/diagnose-zones";
import { requireCapability } from "@/lib/session";
import type { UnitSpec } from "@/lib/unit-vehicle";

// The Diagnose screen's small actions. Sending a message goes through the
// streaming route instead (src/app/api/diagnose/turn/route.ts).

type Failed = { error: string };

async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | Failed> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "That didn't go through. Check the connection and try again." };
  }
}

// Model numbers from the shop's model list for the unit box.
export async function suggestUnitsAction(query: string): Promise<UnitSuggestion[]> {
  const user = await requireCapability("diagnostics.work");
  const result = await attempt("suggest units", () => suggestUnits(user.shop.id, String(query ?? "")));
  return Array.isArray(result) ? result : [];
}

export async function markCauseAction(input: {
  conversationId: string;
  turnId: string;
  index: number;
  verdict: CauseVerdict;
}): Promise<
  { feedback: FeedbackEntry[]; outcome: ConversationView["outcome"]; status: ConversationView["status"] } | Failed
> {
  const user = await requireCapability("diagnostics.work");
  return attempt("save cause feedback", () =>
    markCause(user, {
      conversationId: String(input?.conversationId ?? ""),
      turnId: String(input?.turnId ?? ""),
      index: Number(input?.index),
      verdict: input?.verdict,
    }),
  );
}

export async function changeUnitAction(input: {
  conversationId: string;
  modelNumber?: string;
  wholeLibrary?: boolean;
}): Promise<
  { scope: ScopeView; unit: string | null; vin: string | null; vehicle: UnitVehicle | null; model: UnitSpec | null } | Failed
> {
  const user = await requireCapability("diagnostics.work");
  return attempt("change the unit", () =>
    changeUnit(user, {
      conversationId: String(input?.conversationId ?? ""),
      modelNumber: typeof input?.modelNumber === "string" ? input.modelNumber : undefined,
      wholeLibrary: input?.wholeLibrary === true,
    }),
  );
}

export async function stopTurnAction(turnId: string): Promise<{ ok: boolean } | Failed> {
  const user = await requireCapability("diagnostics.work");
  return attempt("stop the message", async () => ({ ok: await requestStop(user, String(turnId ?? "")) }));
}

// The whole conversation again, after a message finished somewhere else.
export async function loadConversationAction(id: string): Promise<ConversationDetail | Failed> {
  const user = await requireCapability("diagnostics.work");
  const result = await attempt("load the diagnosis", () => getConversation(user, String(id ?? "")));
  return result ?? { error: "That diagnosis isn't in this shop." };
}
