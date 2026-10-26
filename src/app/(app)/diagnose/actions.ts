"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { unstable_rethrow } from "next/navigation";

import { changeUnit, getConversation, markCause, markStep, requestStop, type ConversationDetail } from "@/lib/diagnose";
import { partSheet } from "@/lib/diagnose-part-sheet";
import type { PartSheet } from "@/lib/diagnose-parts";
import type {
  CauseVerdict,
  ConversationView,
  FeedbackEntry,
  ScopeView,
  StepCheckEntry,
  StepResult,
  UnitSuggestion,
  VinPreview,
} from "@/lib/diagnose-rules";
import type { StepState } from "@/lib/diagnose-step-checks";
import { previewVin, suggestUnits } from "@/lib/diagnose-tools";
import type { UnitVehicle } from "@/lib/diagnose-zones";
import type { PageRef } from "@/lib/manual-facts-rules";
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

// What a VIN typed in the quick form finds in the shop's model list.
export async function previewVinAction(vin: string): Promise<VinPreview | null> {
  const user = await requireCapability("diagnostics.work");
  const result = await attempt("look up the VIN", () => previewVin(user.shop.id, String(vin ?? "")));
  return result && !("error" in result) ? result : null;
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

// A tick on one of Claude's checks, or taking one back: the same people can
// as can mark a cause. "was" is how the check stood on the screen tapped.
export async function markStepAction(input: {
  conversationId: string;
  turnId: string;
  index: number;
  done: boolean;
  result: StepResult | null;
  was: StepState;
}): Promise<{ stepChecks: StepCheckEntry[]; stale?: true } | Failed> {
  const user = await requireCapability("diagnostics.work");
  return attempt("save the step", () =>
    markStep(user, {
      conversationId: String(input?.conversationId ?? ""),
      turnId: String(input?.turnId ?? ""),
      index: Number(input?.index),
      done: input?.done,
      result: input?.result ?? null,
      was: input?.was ?? null,
    }),
  );
}

export async function changeUnitAction(input: {
  conversationId: string;
  modelNumber?: string;
  wholeLibrary?: boolean;
}): Promise<
  | {
      scope: ScopeView;
      unit: string | null;
      vin: string | null;
      modelNumber: string | null;
      vehicle: UnitVehicle | null;
      model: UnitSpec | null;
    }
  | Failed
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

// The part sheet for a system of the unit the tech tapped: its parts, the
// manual pages that show the one picked (or the first), and the large
// page's card. With a page, that page's card, read the first time anyone
// opens it (a few seconds, once); the same people can as can see the
// diagnosis.
export async function partSheetAction(input: {
  conversationId: string;
  system: string;
  part?: string;
  page?: PageRef | null;
}): Promise<PartSheet | Failed> {
  const user = await requireCapability("diagnostics.work");
  const page = input?.page && typeof input.page === "object" ? { manualId: String(input.page.manualId ?? ""), page: Number(input.page.page) } : null;
  return attempt("open the part", () =>
    partSheet(user, {
      conversationId: String(input?.conversationId ?? ""),
      system: String(input?.system ?? ""),
      part: typeof input?.part === "string" ? input.part : undefined,
      page,
    }),
  );
}
