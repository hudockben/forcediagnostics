// Reports > Diagnosis times: how long diagnoses take, from the clock on
// each (src/lib/diagnose-clock-rules.ts), so the next one like it can be
// scheduled. A diagnosis counts in a week, month, quarter or year by the
// day it was finished (End, or "This was it"), in the shop's time zone. The
// typical times come from the solved ones (a cause confirmed), grouped by
// what was wrong (the confirmed cause's system), the fault codes it started
// with, the unit (its line and engine size: "RZR 1000") or who worked on
// it: the middle one (typical), the time 4 in 5 were done within (plan
// for), the fastest and slowest. No server imports: the page, the download
// and the tests share these.

import { SYSTEM_LABELS, type CauseSystem } from "@/lib/diagnose-zones";
import { line, parseIsoDate, shopToday } from "@/lib/nusr-rules";
import { PERIOD_LABELS, REPORT_PERIODS, periodOf, type Period, type ReportPeriod } from "@/lib/report-rules";
import { LINE_VEHICLE, UNIT_LINE_NAMES, displacementOf, linesNamed } from "@/lib/unit-vehicle";

export { PERIOD_LABELS, REPORT_PERIODS, type ReportPeriod };

// --- What the address says --------------------------------------------------------

export const TIME_GROUPS = ["fix", "code", "unit", "tech"] as const;
export type TimeGrouping = (typeof TIME_GROUPS)[number];
export const TIME_GROUP_LABELS: Record<TimeGrouping, string> = {
  fix: "What was wrong",
  code: "Fault code",
  unit: "Unit",
  tech: "Tech",
};

export type TimesParams = { view: ReportPeriod; on: string; group: TimeGrouping };

type Params = Record<string, string | string[] | undefined>;
const param = (params: Params, key: string) => {
  const value = params[key];
  return line(typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "");
};

// From the address: the period (a month unless another is asked for), the
// day it's about (the shop's today unless another real day is asked for),
// and how the typical times are grouped (by what was wrong unless asked).
export function parseTimesParams(params: Params, today = shopToday()): TimesParams {
  const view = param(params, "view");
  const group = param(params, "group");
  return {
    view: (REPORT_PERIODS as readonly string[]).includes(view) ? (view as ReportPeriod) : "month",
    on: parseIsoDate(param(params, "on")) ?? today,
    group: (TIME_GROUPS as readonly string[]).includes(group) ? (group as TimeGrouping) : "fix",
  };
}

// The address's search, leaving out what's as it is by default.
export function timesSearch({ view, on, group }: TimesParams, today = shopToday()) {
  const search = new URLSearchParams();
  if (view !== "month") search.set("view", view);
  if (on !== today) search.set("on", on);
  if (group !== "fix") search.set("group", group);
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const timesPeriod = (params: Pick<TimesParams, "view" | "on">): Period => periodOf(params.view, params.on);

// --- The diagnoses --------------------------------------------------------------

// A diagnosis finished in the period, as the server reads it.
export type FinishedDiagnosis = {
  id: string;
  title: string;
  // As shown: "2019 RZR XP 1000 EPS — Z19VDE99AM", or none.
  unit: string | null;
  startedBy: string;
  startedAt: string;
  // When its clock ended (ISO), and that day in the shop ("2026-11-05").
  finishedAt: string;
  finishedOn: string;
  // A cause confirmed ("This was it"): its title and the system it's in.
  solved: boolean;
  fix: string | null;
  system: CauseSystem | null;
  // The fault codes it started with (the quick form's).
  codes: string[];
  // Time on its clock, and each person's part of it, most first.
  seconds: number;
  people: { id: string; name: string; seconds: number }[];
};

// The fault codes in a diagnosis's opening message (the quick form's
// "Fault codes: P0300, P0301" line), or in that line's list on its own.
export const splitCodes = (list: string | null) => [...new Set((list ?? "").split(/,\s*/).map((code) => code.trim()).filter(Boolean))];
export function openingCodes(techText: string | null) {
  const match = /^Fault codes: (.+)$/m.exec(techText ?? "");
  return match ? splitCodes(match[1]) : [];
}

// The unit as the shop would group jobs: its line and engine size ("RZR
// 1000", "Ranger 570", "Sportsman 850"), or the name without its year and
// model number when it isn't one of Polaris's lines.
export const NO_UNIT = "No unit given";
export function unitGroup(label: string | null) {
  const name = (label ?? "").split(" — ")[0].trim();
  if (!name) return NO_UNIT;
  let lines = linesNamed(name);
  // The first RZRs were "RANGER RZR"; "RGR CREW … TRAIL BOSS" is a Ranger.
  if (lines.includes("rzr")) lines = lines.filter((unitLine) => unitLine !== "ranger");
  if (lines.some((unitLine) => LINE_VEHICLE[unitLine] === "utv")) lines = lines.filter((unitLine) => LINE_VEHICLE[unitLine] !== "atv");
  const plain = name.replace(/^(?:19|20)\d\d\s+/, "").replace(/\s*\(\d+ models?\)$/i, "").trim() || name;
  if (lines.length === 0) return plain;
  const size = displacementOf(name);
  return size ? `${UNIT_LINE_NAMES[lines[0]]} ${size}` : UNIT_LINE_NAMES[lines[0]];
}

// --- Typical times ----------------------------------------------------------------

export type TimeStats = {
  count: number;
  // The middle one (the two in the middle's average when there's an even
  // number), what 4 in 5 were done within, the fastest and slowest, the
  // average and the total, in seconds.
  typical: number;
  planFor: number;
  fastest: number;
  slowest: number;
  average: number;
  total: number;
};

export function timeStats(seconds: readonly number[]): TimeStats {
  const sorted = [...seconds].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return { count, typical: 0, planFor: 0, fastest: 0, slowest: 0, average: 0, total: 0 };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(count / 2);
  return {
    count,
    typical: count % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    // The smallest time at least 4 in 5 took no longer than.
    planFor: sorted[Math.ceil(0.8 * count) - 1],
    fastest: sorted[0],
    slowest: sorted[count - 1],
    average: total / count,
    total,
  };
}

export type TimeGroup = { key: string; label: string; stats: TimeStats };

// The groups no diagnosis named: listed last.
const NONE_KEY = "";

// What each solved diagnosis counts under, and for how long: its system,
// each of its fault codes, its unit, or each person's part of it.
function entriesOf(diagnosis: FinishedDiagnosis, by: TimeGrouping): { key: string; label: string; seconds: number }[] {
  switch (by) {
    case "fix": {
      const system = diagnosis.system ?? "other";
      return [{ key: system, label: SYSTEM_LABELS[system], seconds: diagnosis.seconds }];
    }
    case "code":
      return diagnosis.codes.length > 0
        ? diagnosis.codes.map((code) => ({ key: code, label: code, seconds: diagnosis.seconds }))
        : [{ key: NONE_KEY, label: "No fault codes", seconds: diagnosis.seconds }];
    case "unit": {
      const label = unitGroup(diagnosis.unit);
      return [{ key: label === NO_UNIT ? NONE_KEY : label.toLowerCase(), label, seconds: diagnosis.seconds }];
    }
    case "tech":
      return diagnosis.people.map((person) => ({ key: person.id, label: person.name, seconds: person.seconds }));
  }
}

// The solved diagnoses' typical times by `by`, the most often seen first
// (then the longest typical), what no diagnosis named last.
export function typicalTimes(diagnoses: readonly FinishedDiagnosis[], by: TimeGrouping): TimeGroup[] {
  const groups = new Map<string, { label: string; seconds: number[] }>();
  for (const diagnosis of diagnoses) {
    if (!diagnosis.solved) continue;
    for (const entry of entriesOf(diagnosis, by)) {
      const group = groups.get(entry.key) ?? { label: entry.label, seconds: [] };
      group.seconds.push(entry.seconds);
      groups.set(entry.key, group);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, label: group.label, stats: timeStats(group.seconds) }))
    .sort(
      (a, b) =>
        Number(a.key === NONE_KEY) - Number(b.key === NONE_KEY) ||
        b.stats.count - a.stats.count ||
        b.stats.typical - a.stats.typical ||
        a.label.localeCompare(b.label),
    );
}

// The period at a glance: diagnoses finished and solved, the time on their
// clocks, and the solved ones' typical time.
export function timesSummary(diagnoses: readonly FinishedDiagnosis[]) {
  const solved = diagnoses.filter((diagnosis) => diagnosis.solved);
  return {
    finished: diagnoses.length,
    solved: solved.length,
    seconds: diagnoses.reduce((sum, diagnosis) => sum + diagnosis.seconds, 0),
    solving: timeStats(solved.map((diagnosis) => diagnosis.seconds)),
  };
}

// What a diagnosis's row says about who worked on it: "Mike", "Mike, Rae".
export const peopleOf = (diagnosis: Pick<FinishedDiagnosis, "people">) => diagnosis.people.map((person) => person.name).join(", ");

// What it says was wrong: the fix, or that it ended without one.
export const fixOf = (diagnosis: Pick<FinishedDiagnosis, "solved" | "fix" | "system">) =>
  diagnosis.solved ? `${diagnosis.fix ?? "Solved"}${diagnosis.system ? ` (${SYSTEM_LABELS[diagnosis.system]})` : ""}` : "Ended, no cause confirmed";

// The download's name: "Diagnosis times November 2026 2026-11-09.xlsx".
export function timesFileName(params: TimesParams, today: string) {
  const what = timesPeriod(params).label.replace(/[^\w ,–-]+/g, "").replace(/\s+/g, " ").trim();
  return `Diagnosis times ${what} ${today}.xlsx`;
}

// --- An estimate for the next one ------------------------------------------------

// What a diagnosis about to start, or under way, is likely to take, from the
// shop's solved ones like it (src/lib/diagnosis-times.ts reads them): those
// on the same unit (its group: "RZR 1000") that started with one of the
// same fault codes, then any with one of the same codes, then any on the
// same unit. The closest of those with at least ESTIMATE_ENOUGH diagnoses
// is used, or failing that the closest with ESTIMATE_MIN; with fewer, there
// isn't one.
export const ESTIMATE_ENOUGH = 3;
export const ESTIMATE_MIN = 2;

// A solved diagnosis as an estimate needs it: its unit, the fault codes it
// started with, and the time on its clock (seconds).
export type PastJob = { unit: string | null; codes: string[]; seconds: number };

export type Estimate = {
  // How many it's from, their typical time and what 4 in 5 were done
  // within (seconds).
  count: number;
  typical: number;
  planFor: number;
  // What it went by: the unit group, and which of the codes, if either.
  unit: string | null;
  codes: string[];
};

export function estimateFrom(past: readonly PastJob[], target: { unit: string | null; codes: readonly string[] }): Estimate | null {
  const group = unitGroup(target.unit);
  const unitKey = group === NO_UNIT ? null : group.toLowerCase();
  const wanted = new Set(target.codes.map((code) => code.toUpperCase()));
  const sameUnit = (job: PastJob) => unitKey !== null && unitGroup(job.unit).toLowerCase() === unitKey;
  const sharesCode = (job: PastJob) => job.codes.some((code) => wanted.has(code.toUpperCase()));
  const tiers: { unit: string | null; byCodes: boolean; jobs: PastJob[] }[] = [];
  if (unitKey && wanted.size > 0) tiers.push({ unit: group, byCodes: true, jobs: past.filter((job) => sameUnit(job) && sharesCode(job)) });
  if (wanted.size > 0) tiers.push({ unit: null, byCodes: true, jobs: past.filter(sharesCode) });
  if (unitKey) tiers.push({ unit: group, byCodes: false, jobs: past.filter(sameUnit) });
  const tier = tiers.find((each) => each.jobs.length >= ESTIMATE_ENOUGH) ?? tiers.find((each) => each.jobs.length >= ESTIMATE_MIN);
  if (!tier) return null;
  const stats = timeStats(tier.jobs.map((job) => job.seconds));
  const seen = new Set(tier.jobs.flatMap((job) => job.codes.map((code) => code.toUpperCase())));
  return {
    count: stats.count,
    typical: stats.typical,
    planFor: stats.planFor,
    unit: tier.unit,
    codes: tier.byCodes ? target.codes.filter((code) => seen.has(code.toUpperCase())) : [],
  };
}

// "P0300", "P0300 or P0301", "P0300, P0301 or P0302".
const orList = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

// What it's from: "4 solved RZR 1000 diagnoses with P0300".
export function estimateBasis(estimate: Pick<Estimate, "count" | "unit" | "codes">) {
  const what = `${estimate.count} solved ${estimate.unit ? `${estimate.unit} ` : ""}${estimate.count === 1 ? "diagnosis" : "diagnoses"}`;
  return estimate.codes.length > 0 ? `${what} with ${orList(estimate.codes)}` : what;
}
