// The tech ticking off Claude's checks on the Diagnose screen: a check is
// done, and OK (nothing wrong) or a problem found if they say. The ticks are
// saved with the conversation (step_checks), so the bay tablet and the
// office PC show the same, and Claude hears about them with the tech's next
// message, as it hears about "Ruled out" and "This was it". A check is the
// same check from one reply to the next when its words are, so a tick stays
// on a check Claude gives again. Pure (no React, no database): shared by the
// server, the panel and the tests.

import type { StepCheckEntry, StepResult } from "@/lib/diagnose-rules";

// A check's words as they're compared: case, accents, punctuation and
// spacing aside ("Measure coil primary resistance." is "measure coil
// primary resistance"). Signs such as < > = + stay, each a word of its own:
// "under 12 V" and "over 12 V" written with them are two checks.
export const stepKey = (action: string) =>
  String(action ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\p{Sm}/gu, " $& ")
    .replace(/[^\p{L}\p{N}\p{Sm}]+/gu, " ")
    .trim();

export type StepState = { done: boolean; result: StepResult | null };
export const NOT_DONE: StepState = { done: false, result: null };

const stateOf = (entry: StepCheckEntry | undefined): StepState =>
  entry?.done ? { done: true, result: entry.result ?? null } : NOT_DONE;

export const sameState = (a: StepState, b: StepState) => a.done === b.done && (!a.done || a.result === b.result);

// A state as a screen sent it (how a check stood when it was tapped), or
// null when it isn't one.
export function stepStateIn(value: unknown): StepState | null {
  if (!value || typeof value !== "object") return null;
  const { done, result } = value as { done?: unknown; result?: unknown };
  if (typeof done !== "boolean") return null;
  if (result !== null && result !== undefined && result !== "ok" && result !== "problem") return null;
  return done ? { done, result: (result as StepResult | undefined) ?? null } : NOT_DONE;
}

// How each check stands: its latest entry, by its words' key.
export function stepStates(entries: StepCheckEntry[]): Map<string, StepCheckEntry> {
  const latest = new Map<string, StepCheckEntry>();
  for (const entry of entries) latest.set(stepKey(entry.action), entry);
  return latest;
}

export const stepStateOf = (states: Map<string, StepCheckEntry>, action: string): StepState => stateOf(states.get(stepKey(action)));

// What Claude last heard about a check: its latest entry Claude was told
// about, or not done when it was told nothing.
const heard = (entries: StepCheckEntry[], key: string) => stateOf(entries.findLast((entry) => entry.sentInSeq !== null && stepKey(entry.action) === key));

// The entries after a tick (or a tick taken back: done false). An entry
// Claude hasn't heard yet is replaced, and one that only puts the check back
// as Claude last heard it isn't kept, so taking back a tick Claude never
// heard leaves nothing; once Claude has heard, a change is a new entry. While
// a message is with Claude (inFlight), entries it hasn't heard may be on
// their way to it, so they're kept and the tick goes after them: Claude
// hears the change with the message after.
export function applyStepCheck(entries: StepCheckEntry[], entry: StepCheckEntry, { inFlight = false }: { inFlight?: boolean } = {}): StepCheckEntry[] {
  const next: StepCheckEntry = { ...entry, result: entry.done ? (entry.result ?? null) : null, sentInSeq: null };
  if (inFlight) return [...entries, next];
  const key = stepKey(entry.action);
  const kept = entries.filter((other) => !(other.sentInSeq === null && stepKey(other.action) === key));
  return sameState(stateOf(next), heard(kept, key)) ? kept : [...kept, next];
}

// "Measure coil primary resistance…" for Claude's note: the check's words,
// cut short when they run long.
const quoted = (text: string, max: number) => {
  const tidy = String(text ?? "").replace(/\s+/g, " ").trim();
  return `“${tidy.length > max ? `${tidy.slice(0, max - 1).trimEnd()}…` : tidy}”`;
};

const listed = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

const SAID: Record<"ok" | "problem" | "done" | "undone", string> = {
  ok: "OK (found nothing wrong)",
  problem: "problem found",
  done: "done (no result given)",
  undone: "unticked (not done after all)",
};

// The app's note to Claude about the ticks it hasn't heard yet: each check
// once, as it stands now, and only when that isn't what Claude last heard.
export function stepNotes(entries: StepCheckEntry[]): string[] {
  const latest = new Map<string, StepCheckEntry>();
  for (const entry of entries) if (entry.sentInSeq === null) latest.set(stepKey(entry.action), entry);
  const lines: string[] = [];
  for (const [key, entry] of latest) {
    const now = stateOf(entry);
    if (sameState(now, heard(entries, key))) continue;
    const said = !now.done ? SAID.undone : SAID[now.result ?? "done"];
    const causes = entry.causes ?? [];
    const forWhat = causes.length > 0 ? ` (for ${causes.length === 1 ? "cause" : "causes"} ${listed(causes.map((title) => quoted(title, 120)))})` : "";
    lines.push(`- ${quoted(entry.action, 200)}${forWhat}: ${said}`);
  }
  return lines.length > 0 ? [`Since your last reply the tech checked:\n${lines.join("\n")}`] : [];
}

// The step to do next in a list (a cause's steps, quickest first, or Start
// here): the first that isn't done, or -1 when they all are.
export const nextStep = (states: StepState[]) => states.findIndex((state) => !state.done);

// What an open cause's steps suggest, quietly, by its buttons (never marked
// for the tech): a problem found on any of them, "This was it"; every one
// done and OK, "Ruled out". Nothing while a step isn't done or has no result.
export type MarkHint = "ruled_out" | "confirmed" | null;
export function markHint(states: StepState[]): MarkHint {
  if (states.some((state) => state.done && state.result === "problem")) return "confirmed";
  if (states.length > 0 && states.every((state) => state.done && state.result === "ok")) return "ruled_out";
  return null;
}
