import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { inputBaseClass } from "@/components/hud";
import { formatDuration } from "@/lib/diagnose-clock-rules";
import { diagnosisTimes } from "@/lib/diagnosis-times";
import {
  PERIOD_LABELS,
  REPORT_PERIODS,
  TIME_GROUPS,
  TIME_GROUP_LABELS,
  fixOf,
  parseTimesParams,
  peopleOf,
  timesPeriod,
  timesSearch,
  timesSummary,
  typicalTimes,
  type FinishedDiagnosis,
  type TimesParams,
} from "@/lib/diagnosis-times-rules";
import { formatDay, shopToday } from "@/lib/nusr-rules";
import { periodOf, shiftPeriod } from "@/lib/report-rules";
import { requireCapability } from "@/lib/session";

import { WidePage } from "../../nusr/forms";

// Reports > Diagnosis times: how long diagnoses take, from the clock on each
// (src/lib/diagnose-clock-rules.ts), for a week, month, quarter or year: the
// period at a glance, the typical times of the solved ones grouped by what
// was wrong, fault code, unit or tech, and the diagnoses themselves. All in
// the address (?view=, ?on=, ?group=), so it can be bookmarked or sent on.

export const metadata: Metadata = { title: "Diagnosis times" };

export default function DiagnosisTimesPage(props: PageProps<"/reports/diagnosis-times">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Times searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const pillClass = (active: boolean) =>
  `flex h-10 items-center rounded-full px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
    active ? "bg-glow/15 text-glow" : "text-ink-muted hover:bg-white/5 hover:text-ink"
  }`;
const linkButton =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";
const textLink = "text-sm text-glow/90 hover:text-glow hover:underline focus-visible:underline focus-visible:outline-none";

type Href = (change: Partial<TimesParams>) => string;

async function Times({ searchParams }: { searchParams: PageProps<"/reports/diagnosis-times">["searchParams"] }) {
  const user = await requireCapability("reports.kpis");
  const today = shopToday();
  const params = parseTimesParams(await searchParams, today);
  const result = await diagnosisTimes(user, params);
  const href: Href = (change) => `/reports/diagnosis-times${timesSearch({ ...params, ...change }, today)}`;
  const period = timesPeriod(params);

  return (
    <WidePage className="space-y-6">
      <PageHeading
        title="Reports"
        description="How long diagnoses take, from the clock on each one, so the next job like it can be scheduled."
        action={
          <a href={`/reports/diagnosis-times/export${timesSearch(params, today)}`} className={linkButton} data-times-export>
            Download Excel
          </a>
        }
      />
      <section className="space-y-6 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-diagnosis-times>
        <div>
          <h2 className="text-base font-semibold text-ink">Diagnosis times</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
            The time on each diagnosis&apos;s clock: it runs while the diagnosis is worked on, gaps of up to 15 minutes included (the tech at the machine), and stops by
            itself after that. Each diagnosis counts on the day it was finished, with End or This was it.
          </p>
        </div>
        <Controls params={params} today={today} href={href} />
        <PeriodNav params={params} today={today} href={href} />
        {"error" in result ? (
          <Notice tone="trail">{result.error}</Notice>
        ) : (
          <>
            {result.open.count > 0 && (
              <Notice tone="trail" live={false}>
                {plural(result.open.count, "diagnosis", "diagnoses")} started in {period.label} {result.open.count === 1 ? "is" : "are"} still open, with{" "}
                {formatDuration(result.open.seconds)} on {result.open.count === 1 ? "its clock" : "their clocks"} so far. {result.open.count === 1 ? "It counts" : "They count"} once{" "}
                {result.open.count === 1 ? "it's" : "they're"} ended (End, or This was it).
              </Notice>
            )}
            {result.diagnoses.length === 0 ? (
              <p className="text-sm text-ink-muted">No diagnoses finished in {period.label}.</p>
            ) : (
              <>
                <Summary diagnoses={result.diagnoses} />
                <Typical diagnoses={result.diagnoses} params={params} href={href} />
                <DiagnosesList diagnoses={result.diagnoses} />
              </>
            )}
          </>
        )}
      </section>
    </WidePage>
  );
}

// The period (a week, month, quarter or year) and the day it's about.
function Controls({ params, today, href }: { params: TimesParams; today: string; href: Href }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <nav aria-label="Report period">
        <ul className="flex flex-wrap gap-2">
          {REPORT_PERIODS.map((view) => (
            <li key={view}>
              <Link href={href({ view })} aria-current={params.view === view ? "page" : undefined} className={pillClass(params.view === view)}>
                {PERIOD_LABELS[view]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <form action="/reports/diagnosis-times" className="flex items-end gap-2">
        {params.view !== "month" && <input type="hidden" name="view" value={params.view} />}
        {params.group !== "fix" && <input type="hidden" name="group" value={params.group} />}
        <label className="text-xs text-ink-muted">
          As of
          <input type="date" name="on" defaultValue={params.on} required className={`${inputBaseClass} mt-1 h-10 w-44 text-sm`} />
        </label>
        <button type="submit" className={`${linkButton} min-h-10`}>
          Show
        </button>
        {params.on !== today && (
          <Link href={href({ on: today })} className={`${textLink} pb-2.5`}>
            Today
          </Link>
        )}
      </form>
    </div>
  );
}

// The period, with the ones before and after it a click away (not one still
// to come).
function PeriodNav({ params, today, href }: { params: TimesParams; today: string; href: Href }) {
  const period = timesPeriod(params);
  const previous = periodOf(params.view, shiftPeriod(period, -1));
  const next = periodOf(params.view, shiftPeriod(period, 1));
  const isCurrent = periodOf(params.view, today).start === period.start;
  return (
    <nav aria-label={`Other ${params.view}s`} className="flex flex-wrap items-center justify-between gap-3 border-y border-white/10 py-3">
      <Link href={href({ on: previous.start })} className={textLink}>
        ‹ {previous.label}
      </Link>
      <div className="text-center">
        <h3 className="text-lg font-semibold text-ink" data-times-period>
          {period.label}
        </h3>
        {!isCurrent && (
          <Link href={href({ on: today })} className={textLink}>
            This {params.view}
          </Link>
        )}
      </div>
      {next.start <= today ? (
        <Link href={href({ on: next.start })} className={textLink}>
          {next.label} ›
        </Link>
      ) : (
        <span className="text-sm text-ink-muted/60">{next.label} ›</span>
      )}
    </nav>
  );
}

// The period at a glance.
function Summary({ diagnoses }: { diagnoses: FinishedDiagnosis[] }) {
  const summary = timesSummary(diagnoses);
  const unsolved = summary.finished - summary.solved;
  const items: [string, string, string?][] = [
    ["Diagnoses finished", summary.finished.toLocaleString("en-US"), unsolved > 0 ? `${summary.solved} solved, ${unsolved} ended without a cause` : `all solved`],
    ["On the clock", formatDuration(summary.seconds), "all of them together"],
    ["Typical to solve", summary.solved > 0 ? formatDuration(summary.solving.typical) : "—", summary.solved > 0 ? `plan for ${formatDuration(summary.solving.planFor)}` : "none solved"],
    [
      "Fastest – slowest",
      summary.solved > 0 ? `${formatDuration(summary.solving.fastest)} – ${formatDuration(summary.solving.slowest)}` : "—",
      summary.solved > 0 ? "solved ones" : undefined,
    ],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4" data-times-summary>
      {items.map(([label, value, note]) => (
        <div key={label}>
          <dt className="text-xs text-ink-muted">{label}</dt>
          <dd className="mt-0.5 font-mono text-lg text-ink">{value}</dd>
          {note && <dd className="text-xs text-ink-muted">{note}</dd>}
        </div>
      ))}
    </dl>
  );
}

// A table of figures: the first column names the row.
function Table({ caption, head, rows, data }: { caption: ReactNode; head: ReactNode[]; rows: ReactNode[][]; data?: string }) {
  const cell = "px-3 py-2 whitespace-nowrap first:pl-0 last:pr-0";
  return (
    <div className="overflow-x-auto" data-times-table={data}>
      <table className="w-full text-sm">
        <caption className="pb-2 text-left text-base font-semibold text-ink">{caption}</caption>
        <thead className="border-b border-white/10">
          <tr>
            {head.map((label, index) => (
              <th key={index} scope="col" className={`${cell} align-bottom text-xs font-medium text-ink-muted ${index === 0 ? "text-left" : "text-right"}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, index) =>
                index === 0 ? (
                  <th key={index} scope="row" className={`${cell} text-left font-normal text-ink`}>
                    {value}
                  </th>
                ) : (
                  <td key={index} className={`${cell} text-right text-ink tabular-nums`}>
                    {value}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The solved diagnoses' typical times, grouped as asked.
function Typical({ diagnoses, params, href }: { diagnoses: FinishedDiagnosis[]; params: TimesParams; href: Href }) {
  const groups = typicalTimes(diagnoses, params.group);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h3 className="text-base font-semibold text-ink">Typical times</h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
            From the solved diagnoses. Typical is the middle one; plan for is the time 4 in 5 were done within, what to book the next one like it for.
          </p>
        </div>
        <div>
          <p className="text-xs text-ink-muted" id="group-by">
            Group by
          </p>
          <ul aria-labelledby="group-by" className="mt-1 flex flex-wrap gap-2">
            {TIME_GROUPS.map((group) => (
              <li key={group}>
                <Link href={href({ group })} aria-current={params.group === group ? "true" : undefined} className={pillClass(params.group === group)}>
                  {TIME_GROUP_LABELS[group]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-ink-muted">None of these diagnoses was solved (a cause confirmed with This was it), so there are no typical times yet.</p>
      ) : (
        <Table
          caption={<span className="sr-only">Typical times by {TIME_GROUP_LABELS[params.group].toLowerCase()}</span>}
          data="typical"
          head={[TIME_GROUP_LABELS[params.group], "Solved", "Typical", "Plan for", "Fastest – slowest", "Total"]}
          rows={groups.map((group) => [
            group.label,
            group.stats.count.toLocaleString("en-US"),
            <span key="typical" className="font-medium">
              {formatDuration(group.stats.typical)}
            </span>,
            formatDuration(group.stats.planFor),
            group.stats.count === 1 ? "—" : `${formatDuration(group.stats.fastest)} – ${formatDuration(group.stats.slowest)}`,
            formatDuration(group.stats.total),
          ])}
        />
      )}
    </div>
  );
}

// The diagnoses finished in the period, newest first, each opening in
// Diagnose.
function DiagnosesList({ diagnoses }: { diagnoses: FinishedDiagnosis[] }) {
  const cell = "px-3 py-2 align-top first:pl-0 last:pr-0";
  return (
    <div className="overflow-x-auto" data-times-table="diagnoses">
      <table className="w-full min-w-[48rem] text-sm">
        <caption className="pb-2 text-left text-base font-semibold text-ink">The diagnoses: {plural(diagnoses.length, "diagnosis", "diagnoses")}</caption>
        <thead className="border-b border-white/10 text-xs text-ink-muted">
          <tr>
            <th scope="col" className={`${cell} text-left font-medium`}>
              Finished
            </th>
            <th scope="col" className={`${cell} text-left font-medium`}>
              Diagnosis
            </th>
            <th scope="col" className={`${cell} text-left font-medium`}>
              Worked on by
            </th>
            <th scope="col" className={`${cell} text-left font-medium`}>
              What was wrong
            </th>
            <th scope="col" className={`${cell} text-right font-medium`}>
              Time
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {diagnoses.map((diagnosis) => (
            <tr key={diagnosis.id} data-times-diagnosis>
              <td className={`${cell} whitespace-nowrap text-ink`}>{formatDay(diagnosis.finishedOn)}</td>
              <th scope="row" className={`${cell} text-left font-normal`}>
                <Link href={`/diagnose/${diagnosis.id}`} className="text-ink hover:text-glow hover:underline">
                  {diagnosis.title}
                </Link>
                {diagnosis.unit && <span className="block text-xs text-ink-muted">{diagnosis.unit}</span>}
                {diagnosis.codes.length > 0 && <span className="block font-mono text-xs text-ink-muted">{diagnosis.codes.join(", ")}</span>}
              </th>
              <td className={`${cell} text-ink`}>{peopleOf(diagnosis)}</td>
              <td className={`${cell} ${diagnosis.solved ? "text-ink" : "text-ink-muted"}`}>{fixOf(diagnosis)}</td>
              <td className={`${cell} text-right whitespace-nowrap text-ink tabular-nums`}>{formatDuration(diagnosis.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
