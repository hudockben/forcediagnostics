import type { UnitVehicle } from "@/lib/diagnose-zones";
import { brandInfo } from "@/lib/manual-catalog-rules";

// Which unit drawing a conversation gets. Pure, for the server (see
// unitVehicle in src/lib/diagnose-tools.ts) and the tests; the browser only
// gets the answer.

const LABEL_WORDS: [UnitVehicle, RegExp][] = [
  ["utv", /\b(rzr|ranger|general|xpedition|crew|utvs?|side.?by.?sides?)\b/i],
  ["atv", /\b(sportsman|scrambler|atvs?|outlaw|phoenix|trail boss|hawkeye)\b/i],
  ["generator", /\b(generators?)\b/i],
];

const fromBrandVehicle = { UTV: "utv", ATV: "atv", Generator: "generator" } as const satisfies Record<string, UnitVehicle>;

// The drawing for a unit: from the model list's brand codes for its model
// number (RZR, RGR, ATV, GEN, ...) when they agree on one kind of vehicle,
// otherwise from the words in its name; null when neither says.
export function chooseVehicle(unit: { brands: readonly string[]; label: string | null }): UnitVehicle | null {
  const kinds = new Set(
    unit.brands
      .map((code) => brandInfo(code.toUpperCase()).vehicle)
      .filter((vehicle): vehicle is keyof typeof fromBrandVehicle => vehicle in fromBrandVehicle)
      .map((vehicle) => fromBrandVehicle[vehicle]),
  );
  if (kinds.size === 1) return [...kinds][0];
  const label = unit.label ?? "";
  for (const [vehicle, pattern] of LABEL_WORDS) if (pattern.test(label)) return vehicle;
  return null;
}

// The whole order: the brand codes listed for the unit's model number; when
// those don't decide it, the codes of the manuals it's using; then the
// words in its name.
export function vehicleForUnit(unit: { numberBrands: readonly string[]; manualBrands: readonly string[]; label: string | null }): UnitVehicle | null {
  return (
    chooseVehicle({ brands: unit.numberBrands, label: null }) ??
    chooseVehicle({ brands: unit.manualBrands, label: null }) ??
    chooseVehicle({ brands: [], label: unit.label })
  );
}
