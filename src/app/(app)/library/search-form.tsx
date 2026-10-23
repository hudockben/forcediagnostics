"use client";

import { useRouter } from "next/navigation";

import { inputBaseClass, labelClass, primaryLinkClass } from "@/components/hud";
import {
  VEHICLES,
  VEHICLE_NAMES,
  brandInfo,
  brandLabel,
  isVehicle,
  listsBrands,
  type Vehicle,
} from "@/lib/manual-catalog-rules";

// The Library's search box and filters. They live in the address
// (/library?q=…&vehicle=UTV&year=2020&model=RZR+XP, or &brand=RGR for one
// line), so a search can be shared or bookmarked. Choosing a vehicle or year
// applies it straight away; the search box and Model apply with Search (or
// Enter). Without JavaScript it's a plain GET form, which sends a line as
// ?vehicle=RGR (the server takes that as the brand).

type Props = {
  query: string;
  // The applied filter: a vehicle, or a brand code for one line.
  vehicle: string;
  brand: string;
  year: string;
  model: string;
  maxQueryLength: number;
  maxModelLength: number;
  // Filters only show once there's a model list to filter by.
  showFilters: boolean;
  vehicles: { vehicle: Vehicle; manuals: number }[];
  brands: { brand: string; manuals: number }[];
  years: number[];
};

// Indents a line under its vehicle; option text can't be styled.
const INDENT = "\u00a0\u00a0\u00a0\u00a0";

// The Vehicle select's options: each vehicle some ready manual has, and
// under UTVs and Other, the lines they have. Values are vehicles or brand
// codes. A line that is its vehicle on its own (ATV, GEN) is that vehicle.
// Diagnose's quick form uses it too.
export function vehicleOptions(props: Pick<Props, "vehicles" | "brands">, selected: string) {
  const count = (manuals: number) => ` (${manuals.toLocaleString("en-US")})`;
  const options: { value: string; label: string }[] = [];
  for (const vehicle of VEHICLES) {
    const total = props.vehicles.find((option) => option.vehicle === vehicle);
    const lines = listsBrands(vehicle)
      ? props.brands.filter((option) => brandInfo(option.brand).vehicle === vehicle)
      : [];
    if (total) options.push({ value: vehicle, label: VEHICLE_NAMES[vehicle] + count(total.manuals) });
    for (const line of lines) {
      options.push({ value: line.brand, label: INDENT + brandLabel(line.brand) + count(line.manuals) });
    }
  }
  // A filter from a shared link that no ready manual has any more still
  // shows, so the select says what's applied.
  if (selected && !options.some((option) => option.value === selected)) {
    const name = isVehicle(selected) ? VEHICLE_NAMES[selected] : brandLabel(selected);
    options.push({ value: selected, label: `${name} (0)` });
  }
  return options;
}

// What the select shows for the filter in the address.
function selectedVehicle({ vehicle, brand }: Props) {
  if (!brand) return vehicle;
  const { vehicle: of } = brandInfo(brand);
  return listsBrands(of) ? brand : of;
}

export function Chevron() {
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
  const { query, year, model } = props;

  // Only what's filled in goes in the address; a line goes as ?brand=.
  function go(form: HTMLFormElement) {
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value !== "string" || !value.trim()) continue;
      params.set(name === "vehicle" && !isVehicle(value) ? "brand" : name, value.trim());
    }
    const search = params.toString();
    router.push(search ? `/library?${search}` : "/library");
  }

  const vehicle = selectedVehicle(props);
  const vehicles = vehicleOptions(props, vehicle);
  // As for vehicles above.
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
            <label htmlFor="library-vehicle" className={labelClass}>
              Vehicle
            </label>
            <div className="relative mt-1.5">
              <select
                key={`vehicle:${vehicle}`}
                id="library-vehicle"
                name="vehicle"
                defaultValue={vehicle}
                onChange={(event) => event.currentTarget.form && go(event.currentTarget.form)}
                className={`${inputBaseClass} appearance-none truncate pr-10`}
              >
                <option value="">All vehicles</option>
                {vehicles.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
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
