import "server-only";

import { salesBetween, unfundedBetween, type Sale } from "@/lib/nusr";
import { allows } from "@/lib/permissions";
import { reportDays, type ReportParams } from "@/lib/report-rules";
import type { CurrentUser } from "@/lib/session";

// Reports (the Reports tab): the sales a bonus report adds up, which
// src/lib/report-rules.ts sorts into periods and salesmen. Bonuses are
// what the salesmen are paid, from the NUSR's costs and profits, so it's
// for those who can open the NUSR (sales.log: managers and admins, signed
// in with a password), and only ever the user's own shop's sales.

export type BonusSales = {
  // Every sale counted in the days the report covers.
  sales: Sale[];
  // Counting by funding: the sales sold in those days with none yet.
  unfunded: number;
};

export async function bonusSales(actor: CurrentUser, params: ReportParams): Promise<BonusSales | { error: string }> {
  if (!allows(actor, "sales.log")) return { error: "Only a manager or admin signed in with a password can see the salesmen's bonuses." };
  const { from, to } = reportDays(params);
  const [sales, unfunded] = await Promise.all([
    salesBetween(actor.shop.id, from, to, params.by),
    params.by === "funded" ? unfundedBetween(actor.shop.id, from, to) : Promise.resolve(0),
  ]);
  return { sales, unfunded };
}
