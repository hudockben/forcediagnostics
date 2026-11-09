// Reports > Diagnosis times' download (src/app/(app)/reports/diagnosis-times/
// export/route.ts): the period as a workbook. A Times sheet with the period
// at a glance and the typical times by each grouping (what was wrong, fault
// code, unit and tech), and a Diagnoses sheet with every diagnosis finished
// in it, its time and who worked on it. Times are decimal hours, as labor is
// booked (0.75 is 45 minutes), so they add up and divide in Excel. Pure: the
// route writes the sheets out with src/lib/xlsx-write.ts.

import { decimalHours } from "@/lib/diagnose-clock-rules";
import { SYSTEM_LABELS } from "@/lib/diagnose-zones";
import {
  TIME_GROUPS,
  TIME_GROUP_LABELS,
  peopleOf,
  timesPeriod,
  timesSummary,
  typicalTimes,
  unitGroup,
  type FinishedDiagnosis,
  type TimeStats,
  type TimesParams,
} from "@/lib/diagnosis-times-rules";
import type { Cell, Sheet } from "@/lib/xlsx-write";

const hours = (seconds: number): Cell => ({ value: decimalHours(seconds), style: "hours" });
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const STATS_HEAD = ["Solved", "Typical (h)", "Plan for (h)", "Fastest (h)", "Slowest (h)", "Average (h)", "Total (h)"];
const statsCells = (stats: TimeStats): Cell[] => [
  { value: stats.count, style: "integer" },
  hours(stats.typical),
  hours(stats.planFor),
  hours(stats.fastest),
  hours(stats.slowest),
  hours(stats.average),
  hours(stats.total),
];

// The diagnoses, newest first, as the page lists them.
function diagnosesSheet(diagnoses: readonly FinishedDiagnosis[], title: string): Sheet {
  const head = ["Finished", "Diagnosis", "Unit", "Unit group", "Fault codes", "Started by", "Worked on by", "Solved", "What was wrong", "System", "Hours"];
  const rows: Cell[][] = diagnoses.map((diagnosis) => [
    { value: day(diagnosis.finishedOn), style: "date" },
    diagnosis.title,
    diagnosis.unit,
    unitGroup(diagnosis.unit),
    diagnosis.codes.join(", "),
    diagnosis.startedBy,
    peopleOf(diagnosis),
    diagnosis.solved ? "Yes" : "No",
    diagnosis.fix,
    diagnosis.system ? SYSTEM_LABELS[diagnosis.system] : null,
    hours(diagnosis.seconds),
  ]);
  const last = rows.length + 1;
  const total = decimalHours(diagnoses.reduce((sum, diagnosis) => sum + diagnosis.seconds, 0));
  return {
    name: "Diagnoses",
    columns: [{ width: 12 }, { width: 44 }, { width: 34 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 22 }, { width: 8 }, { width: 34 }, { width: 18 }, { width: 9 }],
    rows: [
      head.map((value): Cell => ({ value, style: "header" })),
      ...rows,
      [
        { value: `TOTAL: ${diagnoses.length} ${diagnoses.length === 1 ? "diagnosis" : "diagnoses"}`, style: "total" },
        ...Array.from({ length: 9 }, (): Cell => ({ value: null, style: "total" })),
        rows.length ? { formula: `SUM(K2:K${last})`, value: total, style: "totalHours" } : { value: total, style: "totalHours" },
      ],
    ],
    freeze: { rows: 1, columns: 2 },
    autoFilter: `A1:K${Math.max(1, last)}`,
    landscape: true,
    fitToWidth: true,
    printTitles: 1,
    footer: title,
  };
}

export function timesWorkbook(
  params: TimesParams,
  data: { diagnoses: readonly FinishedDiagnosis[]; open: { count: number; seconds: number } },
  { generatedAt, timeZone }: { generatedAt: Date; timeZone: string },
): Sheet[] {
  const period = timesPeriod(params);
  const title = `Diagnosis times · ${period.label}`;
  const downloaded = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "long", timeStyle: "short" }).format(generatedAt);
  const summary = timesSummary(data.diagnoses);
  const rows: Cell[][] = [
    [{ value: title, style: "title" }],
    [
      `Downloaded ${downloaded}. Each diagnosis is counted on the day it was finished (End, or This was it). Hours are decimal (0.75 is 45 minutes). Typical is the middle one; plan for is the time 4 in 5 were done within. Typical times come from the solved diagnoses.`,
    ],
    [],
    [{ value: "Finished", style: "bold" }, { value: summary.finished, style: "integer" }],
    [{ value: "Solved", style: "bold" }, { value: summary.solved, style: "integer" }],
    [{ value: "Hours on the clock", style: "bold" }, hours(summary.seconds)],
    [{ value: "Typical to solve (h)", style: "bold" }, hours(summary.solving.typical)],
    [{ value: "Plan for (h)", style: "bold" }, hours(summary.solving.planFor)],
    [{ value: "Still open (started in the period)", style: "bold" }, { value: data.open.count, style: "integer" }, hours(data.open.seconds)],
    [],
  ];
  for (const group of TIME_GROUPS) {
    rows.push([{ value: `By ${TIME_GROUP_LABELS[group].toLowerCase()}`, style: "bold" }]);
    rows.push([TIME_GROUP_LABELS[group], ...STATS_HEAD].map((value): Cell => ({ value, style: "header" })));
    const groups = typicalTimes(data.diagnoses, group);
    if (groups.length === 0) rows.push(["No solved diagnoses"]);
    for (const row of groups) rows.push([row.label, ...statsCells(row.stats)]);
    rows.push([]);
  }
  return [
    {
      name: "Times",
      columns: [{ width: 34 }, ...STATS_HEAD.map(() => ({ width: 12 }))],
      rows,
      landscape: true,
      fitToWidth: true,
      footer: title,
    },
    diagnosesSheet(data.diagnoses, title),
  ];
}
