import "server-only";

import { sql } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { normalizeFaultCodes } from "@/lib/diagnose-rules";
import { suggestUnits } from "@/lib/diagnose-tools";
import { causeSystem } from "@/lib/diagnose-zones";
import {
  NO_UNIT,
  estimateFrom,
  openingCodes,
  splitCodes,
  timesPeriod,
  unitGroup,
  type Estimate,
  type FinishedDiagnosis,
  type PastJob,
  type TimesParams,
} from "@/lib/diagnosis-times-rules";
import { uuidArray } from "@/lib/library";
import { SHOP_TIME_ZONE } from "@/lib/nusr-rules";
import { allows } from "@/lib/permissions";
import type { CurrentUser } from "@/lib/session";
import { linesNamed } from "@/lib/unit-vehicle";

// Reports > Diagnosis times: the diagnoses whose clock ended in a period (End,
// or "This was it"), by the shop's day, with the time on their clocks and
// each person's part, what was wrong and the fault codes they started with;
// src/lib/diagnosis-times-rules.ts adds them up. It's a KPI, for those who
// see the shop's (reports.kpis: managers and admins), and only ever their
// own shop's diagnoses.

export type DiagnosisTimes = {
  diagnoses: FinishedDiagnosis[];
  // Started in the period and still going (the clock not ended), with the
  // time on their clocks so far.
  open: { count: number; seconds: number };
};

type Row = {
  id: string;
  title: string;
  unit: string | null;
  started_by: string;
  started_at: Date | string;
  finished_at: Date | string;
  finished_on: string;
  status: string;
  fix: string | null;
  cause: { system?: unknown; title?: unknown; why?: unknown } | null;
  opening: string | null;
};

type PersonRow = { conversation_id: string; user_id: string; name: string; seconds: number };

const iso = (value: Date | string) => new Date(value).toISOString();

export async function diagnosisTimes(actor: CurrentUser, params: TimesParams): Promise<DiagnosisTimes | { error: string }> {
  if (!allows(actor, "reports.kpis")) return { error: "Only a manager or admin can see how long diagnoses take." };
  const period = timesPeriod(params);
  // The period's first and last moments, in the shop's time zone.
  const from = sql`(${period.start}::date)::timestamp at time zone ${SHOP_TIME_ZONE}`;
  const until = sql`(${period.end}::date + 1)::timestamp at time zone ${SHOP_TIME_ZONE}`;
  return withShop(actor.shop.id, async (tx) => {
    // Each diagnosis whose latest stretch ended it in the period.
    const finished = await tx.execute<Row>(sql`
      select c.id, c.title, c.unit_label as unit, u.name as started_by, c.created_at as started_at,
        l.ended_at as finished_at, (l.ended_at at time zone ${SHOP_TIME_ZONE})::date::text as finished_on,
        c.status, c.outcome ->> 'title' as fix,
        (select t.reply -> 'likelyCauses' -> ((c.outcome ->> 'rank')::int - 1) from diagnosis_turns t
          where t.conversation_id = c.id and t.seq = (c.outcome ->> 'seq')::int) as cause,
        (select t.tech_text from diagnosis_turns t where t.conversation_id = c.id and t.seq = 1) as opening
      from diagnosis_time_spans l
      join diagnosis_conversations c on c.id = l.conversation_id
      join users u on u.id = c.user_id
      where l.stop in ('end', 'solved')
        and l.ended_at >= ${from} and l.ended_at < ${until}
        and l.seq = (select max(x.seq) from diagnosis_time_spans x where x.conversation_id = l.conversation_id)
      order by l.ended_at desc, c.id
    `);
    const ids = finished.rows.map((row) => row.id);
    const people =
      ids.length === 0
        ? { rows: [] as PersonRow[] }
        : await tx.execute<PersonRow>(sql`
            select s.conversation_id, s.user_id, u.name, sum(extract(epoch from s.ended_at - s.started_at))::float8 as seconds
            from diagnosis_time_spans s join users u on u.id = s.user_id
            where s.conversation_id = any(${uuidArray(ids)})
            group by s.conversation_id, s.user_id, u.name
          `);
    // Started in the period, and not ended.
    const [open] = (
      await tx.execute<{ count: number; seconds: number }>(sql`
        select count(*)::int as count, coalesce(sum(going.seconds), 0)::float8 as seconds from (
          select sum(extract(epoch from s.ended_at - s.started_at)) as seconds
          from diagnosis_conversations c join diagnosis_time_spans s on s.conversation_id = c.id
          where c.created_at >= ${from} and c.created_at < ${until}
          group by c.id
          having coalesce((array_agg(s.stop order by s.seq desc))[1], '') not in ('end', 'solved')
        ) going
      `)
    ).rows;

    const byDiagnosis = new Map<string, FinishedDiagnosis["people"]>();
    for (const person of people.rows) {
      const list = byDiagnosis.get(person.conversation_id) ?? [];
      list.push({ id: person.user_id, name: person.name, seconds: Math.round(Number(person.seconds)) });
      byDiagnosis.set(person.conversation_id, list);
    }
    const diagnoses = finished.rows.map((row): FinishedDiagnosis => {
      const list = (byDiagnosis.get(row.id) ?? []).sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
      const solved = row.status === "solved";
      const cause = solved && row.cause && typeof row.cause === "object" ? row.cause : null;
      return {
        id: row.id,
        title: row.title,
        unit: row.unit,
        startedBy: row.started_by,
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        finishedOn: row.finished_on,
        solved,
        fix: solved ? row.fix : null,
        system: solved ? causeSystem({ system: cause?.system, title: String(cause?.title ?? row.fix ?? ""), why: typeof cause?.why === "string" ? cause.why : "" }) : null,
        codes: openingCodes(row.opening),
        seconds: list.reduce((sum, person) => sum + person.seconds, 0),
        people: list,
      };
    });
    return { diagnoses, open: { count: open?.count ?? 0, seconds: Math.round(Number(open?.seconds ?? 0)) } };
  });
}

// --- Estimates --------------------------------------------------------------------

// The quick form's "Fault codes: …" line of a diagnosis's opening message.
const OPENING_CODES = sql.raw(`substring(t.tech_text from '(?n)^Fault codes: (.*)$')`);

// What an estimate goes by (estimateFrom): the shop's solved diagnoses whose
// clock ended in the last year, newest first, at most PAST_JOBS of them, and
// never `exclude` (the diagnosis being estimated).
const PAST_JOBS = 2000;

async function pastJobs(tx: ShopTransaction, exclude: string | null): Promise<PastJob[]> {
  const result = await tx.execute<{ unit: string | null; codes: string | null; seconds: number }>(sql`
    select c.unit_label as unit,
      (select ${OPENING_CODES} from diagnosis_turns t where t.conversation_id = c.id and t.seq = 1) as codes,
      clock.seconds
    from diagnosis_conversations c
    join lateral (
      select sum(extract(epoch from s.ended_at - s.started_at))::float8 as seconds, max(s.ended_at) as last,
        (array_agg(s.stop order by s.seq desc))[1] as stop
      from diagnosis_time_spans s where s.conversation_id = c.id
    ) clock on clock.stop in ('end', 'solved')
    where c.status = 'solved' and clock.last >= now() - interval '1 year'
      ${exclude ? sql`and c.id <> ${exclude}` : sql``}
    order by clock.last desc
    limit ${PAST_JOBS}
  `);
  return result.rows.map((row) => ({ unit: row.unit, codes: splitCodes(row.codes), seconds: Math.round(Number(row.seconds)) }));
}

// A diagnosis's own estimate (beside its clock): by its unit and the fault
// codes it started with, from the shop's other solved diagnoses.
export async function conversationEstimate(shopId: string, conversation: { id: string; unitLabel: string | null }): Promise<Estimate | null> {
  return withShop(shopId, async (tx) => {
    const [opening] = (
      await tx.execute<{ codes: string | null }>(
        sql`select ${OPENING_CODES} as codes from diagnosis_turns t where t.conversation_id = ${conversation.id} and t.seq = 1`,
      )
    ).rows;
    const codes = splitCodes(opening?.codes ?? null);
    if (unitGroup(conversation.unitLabel) === NO_UNIT && codes.length === 0) return null;
    return estimateFrom(await pastJobs(tx, conversation.id), { unit: conversation.unitLabel, codes });
  });
}

// A model number as typed (Z19VDE99AM), rather than a name.
const isModelNumber = (text: string) => /^[A-Z0-9]{5,14}$/i.test(text) && /\d/.test(text) && /[A-Z]/i.test(text) && linesNamed(text).length === 0;

// The estimate for a diagnosis about to start, as the quick form is filled
// in: its unit (a model from the model list, a model number as typed, or a
// year and model) and the fault codes as typed.
export async function estimateForStart(shopId: string, input: { unit: string; codes: string }): Promise<Estimate | null> {
  let unit = String(input.unit ?? "").trim().slice(0, 120);
  const codes = normalizeFaultCodes(String(input.codes ?? "").slice(0, 400));
  if (isModelNumber(unit)) {
    const [model] = await suggestUnits(shopId, unit);
    if (model && model.modelNumber === unit.toUpperCase()) unit = model.label;
  }
  if (unitGroup(unit) === NO_UNIT && codes.length === 0) return null;
  return withShop(shopId, async (tx) => estimateFrom(await pastJobs(tx, null), { unit, codes }));
}
