// Each likely cause's own steps on the Diagnose screen: the next checks
// that confirm or rule it out, in its card under "How to check", so a tech
// never has to match a separate list of checks back to the causes. The
// causes stay ranked by likelihood (cause 1 is the likeliest, the same
// number as its callout on the unit); a cause's steps go quickest first
// (quick, then test, then teardown; Claude's order within a tier). A check
// that settles several causes is in each of their cards, so each card is
// complete on its own, and says which others it also checks. A check that
// isn't about any one cause (stored codes, the battery's charge) goes
// before them all, under "Start here". Pure (no React, no database):
// shared by the panel and the tests.

import { byEffort, type Effort } from "@/lib/diagnose-rules";
import type { CauseState } from "@/lib/diagnose-zones";

// The causes a check is for, by their numbers in the list (from 1), once
// each, in order. Numbers past the list (or that aren't whole numbers) are
// left out, so a check whose numbers all are is a general one.
export function causeRanks(check: { causes?: unknown }, causeCount: number): number[] {
  if (!Array.isArray(check.causes)) return [];
  const ranks = new Set(check.causes.map(Number).filter((rank) => Number.isInteger(rank) && rank >= 1 && rank <= causeCount));
  return [...ranks].sort((a, b) => a - b);
}

// Whether a reply's checks say which causes they're for. Replies saved
// before checks carried causes have them on none, and keep their separate
// list of next checks. A reply with no checks at all goes the new way: its
// open causes say there's no check yet.
export const checksHaveCauses = (checks: { causes?: unknown }[]) => checks.length === 0 || checks.some((check) => Array.isArray(check.causes));

export type CauseStep<T> = {
  check: T;
  // Its tier, for the tag beside it; null for a check saved without one.
  tier: Effort | null;
  // The other open causes the same check settles, by their numbers ("Also
  // checks cause 3"); none on a general check.
  also: number[];
};

export type CauseSteps<T> = {
  // "Start here": the checks for no cause in particular, quickest first.
  general: CauseStep<T>[];
  // Each open cause's steps, by its number in the list, quickest first: an
  // empty list for an open cause no check settles yet. Ruled-out and
  // confirmed causes aren't in it (their cards show no steps).
  byCause: Map<number, CauseStep<T>[]>;
};

// The reply's checks shared out among its causes (given in list order, as
// the screen shows them: open, ruled out or confirmed). Null for a reply
// saved before checks carried causes.
export function causeSteps<T extends { tier?: Effort; causes?: unknown }>(checks: T[], causes: { status: CauseState }[]): CauseSteps<T> | null {
  if (!checksHaveCauses(checks)) return null;
  const byCause = new Map<number, CauseStep<T>[]>();
  causes.forEach((cause, index) => {
    if (cause.status === "open") byCause.set(index + 1, []);
  });
  const general: CauseStep<T>[] = [];
  for (const check of byEffort(checks)) {
    const tier = check.tier ?? null;
    const ranks = causeRanks(check, causes.length);
    if (ranks.length === 0) {
      general.push({ check, tier, also: [] });
      continue;
    }
    for (const rank of ranks) byCause.get(rank)?.push({ check, tier, also: ranks.filter((other) => other !== rank && byCause.has(other)) });
  }
  return { general, byCause };
}

// A spec as its chip shows it: each number kept on one line with the word
// after it ("5 V", "25 Nm"), so a narrow card never wraps a reading away
// from its unit. For showing only: the stored text is as Claude gave it.
export const specText = (expected: string) => expected.replace(/(\d)\s+(?=[A-Za-zΩµ°%])/g, "$1\u00a0");

// What "Ask how to check" puts in the message box for a cause with no
// check yet: "How do I check cause 2, Fouled or worn spark plugs?".
export function howToCheckQuestion(rank: number, title: string) {
  const name = String(title ?? "").replace(/\s+/g, " ").trim().replace(/[\s.,;:!?]+$/, "");
  return `How do I check cause ${rank}, ${name}?`;
}

// The message box after "Ask how to check": the question on a line of its
// own after whatever is typed (a blank line apart from quoted questions and
// their answers, so it isn't read as one of them), and not twice.
export function addAsk(draft: string, question: string) {
  const text = String(draft ?? "").replace(/\s+$/, "");
  if (!text) return question;
  if (text.split("\n").some((line) => line.trim() === question)) return draft;
  return `${text}${/^> /m.test(text) ? "\n\n" : "\n"}${question}`;
}
