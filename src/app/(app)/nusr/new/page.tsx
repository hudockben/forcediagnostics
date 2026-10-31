import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { LoadingLine, PageHeading } from "@/components/app/ui";
import { getCustomerChoice } from "@/lib/sticker-log";
import { customerForSale, saleSuggestions } from "@/lib/nusr";
import { DEFAULT_BONUS_RATE_BP, DEFAULT_HOLDBACK_RATE_BP, shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { SaleForm, WidePage } from "../forms";

export const metadata: Metadata = { title: "Log a sale" };

export default function NewSalePage(props: PageProps<"/nusr/new">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <NewSale searchParams={props.searchParams} />
    </Suspense>
  );
}

// A new sale: today, the rates the last sale used, and a customer to start
// from when it's opened from their record (?customer=).
async function NewSale({ searchParams }: { searchParams: PageProps<"/nusr/new">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const { customer: customerId } = await searchParams;
  const [suggestions, choice, details] = await Promise.all([
    saleSuggestions(user.shop.id),
    typeof customerId === "string" ? getCustomerChoice(user.shop.id, customerId) : Promise.resolve(null),
    typeof customerId === "string" ? customerForSale(user.shop.id, customerId) : Promise.resolve(null),
  ]);
  const defaults = {
    soldOn: shopToday(),
    holdbackRateBp: suggestions.latest?.holdbackRateBp ?? DEFAULT_HOLDBACK_RATE_BP,
    bonusRateBp: suggestions.latest?.bonusRateBp ?? DEFAULT_BONUS_RATE_BP,
  };
  return (
    <WidePage className="space-y-6">
      <div>
        <Link href="/nusr" className="text-sm text-glow/90 hover:text-glow hover:underline">
          ‹ NUSR
        </Link>
        <PageHeading
          title="Log a sale"
          description="Pick the customer and type the VIN: the rest of what the app knows fills itself in, and the profit, holdback and bonuses work themselves out as you type. Amounts can be sums, like 1250+89.99."
        />
      </div>
      <SaleForm
        key={`${choice?.id ?? ""}`}
        sale={null}
        initialCustomer={choice && details ? { choice, details } : null}
        defaults={defaults}
        suggestions={{
          salespeople: suggestions.salespeople,
          financeCompanies: suggestions.financeCompanies,
          categories: suggestions.categories,
          models: suggestions.models,
          comsNumbers: suggestions.comsNumbers,
        }}
      />
    </WidePage>
  );
}
