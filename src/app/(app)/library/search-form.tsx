"use client";

import { useRouter } from "next/navigation";

import { inputBaseClass, labelClass, primaryLinkClass } from "@/components/hud";

// The Library's search box and filters. They live in the address
// (/library?q=…&brand=ATV&year=2020&model=RZR+XP), so a search can be shared
// or bookmarked. Choosing a brand or year applies it straight away; the
// search box and Model apply with Search (or Enter). Without JavaScript it's
// a plain GET form.

type Props = {
  query: string;
  brand: string;
  year: string;
  model: string;
  maxQueryLength: number;
  maxModelLength: number;
  // Filters only show once there's a model list to filter by.
  showFilters: boolean;
  brands: { brand: string; manuals: number }[];
  years: number[];
};

function Chevron() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 fill-none stroke-ink-muted"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 8 5 5 5-5" />
    </svg>
  );
}

export function LibrarySearchForm(props: Props) {
  const router = useRouter();
  const { query, brand, year, model } = props;

  // Only what's filled in goes in the address.
  function go(form: HTMLFormElement) {
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === "string" && value.trim()) params.set(name, value.trim());
    }
    const search = params.toString();
    router.push(search ? `/library?${search}` : "/library");
  }

  // A filter value from a shared link that no ready manual has any more
  // still shows, so the select says what's applied.
  const brands = brand && !props.brands.some((b) => b.brand === brand) ? [...props.brands, { brand, manuals: 0 }] : props.brands;
  const years = year && !props.years.includes(Number(year)) ? [Number(year), ...props.years] : props.years;

  return (
    <form
      action="/library"
      role="search"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        go(event.currentTarget);
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="library-q" className="sr-only">
          Search the manuals
        </label>
        <input
          // Next keeps this page mounted when only the address changes (the
          // Library tab, Back), so a new key makes each box show the new value.
          key={`q:${query}`}
          id="library-q"
          name="q"
          type="search"
          defaultValue={query}
          maxLength={props.maxQueryLength}
          placeholder='P0300, 2205123, "fuel pump relay"'
          autoComplete="off"
          enterKeyHint="search"
          className={inputBaseClass}
        />
        <button type="submit" className={`${primaryLinkClass} shrink-0`}>
          Search
        </button>
      </div>

      {props.showFilters && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="min-w-0">
            <label htmlFor="library-brand" className={labelClass}>
              Brand
            </label>
            <div className="relative mt-1.5">
              <select
                key={`brand:${brand}`}
                id="library-brand"
                name="brand"
                defaultValue={brand}
                onChange={(event) => event.currentTarget.form && go(event.currentTarget.form)}
                className={`${inputBaseClass} appearance-none truncate pr-10`}
              >
                <option value="">All brands</option>
                {brands.map((option) => (
                  <option key={option.brand} value={option.brand}>
                    {option.brand} ({option.manuals.toLocaleString("en-US")})
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </div>
          <div className="min-w-0">
            <label htmlFor="library-year" className={labelClass}>
              Year
            </label>
            <div className="relative mt-1.5">
              <select
                key={`year:${year}`}
                id="library-year"
                name="year"
                defaultValue={year}
                onChange={(event) => event.currentTarget.form && go(event.currentTarget.form)}
                className={`${inputBaseClass} appearance-none pr-10`}
              >
                <option value="">All years</option>
                {years.map((option) => (
                  <option key={option} value={String(option)}>
                    {option}
                  </option>
                ))}
              </select>
              <Chevron />
            </div>
          </div>
          <div className="min-w-0">
            <label htmlFor="library-model" className={labelClass}>
              Model
            </label>
            <input
              key={`model:${model}`}
              id="library-model"
              name="model"
              type="search"
              defaultValue={model}
              maxLength={props.maxModelLength}
              placeholder="Z24NAE99 or RZR XP"
              autoComplete="off"
              autoCapitalize="characters"
              enterKeyHint="search"
              aria-describedby="library-model-hint"
              className={`mt-1.5 ${inputBaseClass}`}
            />
            <p id="library-model-hint" className="sr-only">
              A model number or its start, or words from the model name.
            </p>
          </div>
        </div>
      )}
    </form>
  );
}
