// The parts of each system of the unit, for the part sheet: a tap on the
// unit opens its system, the tech picks a part, and the sheet shows that
// part's manual page (diagram and procedure) with what the page says
// about it. This file has the part names to pick from (a reviewed list of
// what Polaris calls the common parts of each system, plus the parts the
// conversation's causes name, those first) and how a part's pages are
// ranked, toward the service procedure for it in this unit's own manual.
// Pure (no React, no database): shared by the server, the screen and the
// tests. The search itself is in src/lib/diagnose-part-sheet.ts.

import { causeSystem, isCauseSystem, type CauseState, type DrawnSystem, type UnitVehicle } from "@/lib/diagnose-zones";
import { stem, wordsOf, type FactsState, type PageRef } from "@/lib/manual-facts-rules";

export const isDrawnSystem = (value: unknown): value is DrawnSystem => isCauseSystem(value) && value !== "other";

// A part as the chips name it, the words a cause's title can call it by
// (word patterns, tried case-insensitively on whole words, as in
// diagnose-zones), and the kinds of unit it's on when it isn't all of them.
type Part = { name: string; match: string[]; only?: UnitVehicle[] };

// Most likely to be asked about first, within each system. Names are the
// ones Polaris's service manuals use, so a search for one finds its page.
export const PART_NAMES: Record<DrawnSystem, Part[]> = {
  charging_starting: [
    { name: "Starter solenoid", match: ["starter (?:solenoid|relay)s?", "solenoids?"] },
    { name: "Starter motor", match: ["starter(?: motor)?s?", "starting motor"] },
    { name: "Battery", match: ["batter(?:y|ies)"] },
    { name: "Battery cables", match: ["battery (?:cables?|terminals?|leads?|posts?)", "(?:positive|negative) (?:cables?|leads?)"] },
    { name: "Stator", match: ["stators?", "alternators?", "charging coils?"] },
    { name: "Regulator/rectifier", match: ["(?:voltage )?regulator(?:/rectifier| rectifier)?s?", "rectifiers?", "reg/rec"] },
    { name: "Flywheel", match: ["flywheels?"] },
    { name: "Starter drive", match: ["starter (?:drive|bendix|clutch)(?:es)?", "bendix"] },
    { name: "Recoil starter", match: ["recoil(?: starter)?s?", "pull start(?:er)?s?"], only: ["atv", "generator"] },
  ],
  ignition: [
    { name: "Spark plug", match: ["spark plugs?", "plugs?"] },
    { name: "Ignition coil", match: ["(?:ignition )?coils?", "coil packs?"] },
    { name: "Spark plug cap", match: ["(?:spark )?plug (?:caps?|boots?|wires?|leads?)"] },
    { name: "Crankshaft position sensor", match: ["crank(?:shaft)? position sensors?", "cps", "ckp(?: sensor)?"] },
    { name: "CDI module", match: ["cdi(?: modules?| box(?:es)?| units?)?"], only: ["atv", "generator"] },
  ],
  fuel: [
    { name: "Fuel pump", match: ["fuel pumps?", "fuel pump modules?"] },
    { name: "Fuel injector", match: ["(?:fuel )?injectors?"] },
    { name: "Fuel filter", match: ["fuel filters?", "fuel (?:pump )?strainers?", "pickup screens?"] },
    { name: "Fuel pressure regulator", match: ["fuel pressure regulators?"] },
    { name: "Fuel tank vent", match: ["(?:fuel )?tank vent(?: lines?| hoses?)?", "vent (?:lines?|hoses?)", "fuel cap vents?"] },
    { name: "Fuel tank", match: ["fuel tanks?", "gas tanks?"] },
    { name: "Fuel lines", match: ["fuel (?:lines?|hoses?)"] },
    { name: "Carburetor", match: ["carb(?:uret(?:t)?or)?s?"], only: ["atv", "generator"] },
    { name: "Fuel valve", match: ["fuel (?:valves?|petcocks?|shut-?offs?)", "petcocks?"], only: ["generator"] },
  ],
  air_intake: [
    { name: "Air filter", match: ["air ?filters?", "air cleaner(?: elements?)?", "filter elements?"] },
    { name: "Airbox", match: ["air ?box(?:es)?", "air cleaner (?:box|housing)(?:es)?"] },
    { name: "Throttle body", match: ["throttle bod(?:y|ies)"] },
    { name: "Intake boot", match: ["intake (?:boots?|manifolds?)", "throttle body boots?"] },
    { name: "Idle air control valve", match: ["idle air control(?: valves?| motors?)?", "iac(?: valves?| motors?)?"] },
    { name: "Throttle position sensor", match: ["throttle position sensors?", "tps"] },
    { name: "T-MAP sensor", match: ["t-?map(?: sensors?)?", "map sensors?", "(?:intake )?air temp(?:erature)? sensors?"] },
  ],
  exhaust: [
    { name: "Muffler", match: ["mufflers?", "silencers?"] },
    { name: "Exhaust header pipe", match: ["(?:exhaust )?headers?(?: pipes?)?", "head ?pipes?", "exhaust (?:manifolds?|pipes?)"] },
    { name: "Exhaust gasket", match: ["(?:exhaust|header|manifold) gaskets?"] },
    { name: "Spark arrestor", match: ["spark arrest(?:o|e)rs?(?: screens?)?"] },
    { name: "Oxygen sensor", match: ["(?:oxygen|o2) sensors?"], only: ["utv", "atv"] },
  ],
  cooling: [
    { name: "Radiator", match: ["radiators?"] },
    { name: "Water pump", match: ["water pumps?", "coolant pumps?"] },
    { name: "Thermostat", match: ["thermostats?"] },
    { name: "Cooling fan", match: ["(?:cooling |radiator )?fans?(?: motors?)?"] },
    { name: "Coolant hoses", match: ["(?:coolant|radiator) hoses?"] },
    { name: "Radiator cap", match: ["(?:radiator|pressure|coolant) caps?"] },
    { name: "Coolant temperature sensor", match: ["(?:engine )?coolant temp(?:erature)? sensors?", "ect(?: sensors?)?"] },
    { name: "Coolant reservoir", match: ["(?:coolant )?(?:reservoir|recovery bottle|overflow bottle)s?"] },
  ],
  engine: [
    { name: "Oil filter", match: ["oil filters?"] },
    { name: "Valves", match: ["valves?(?: clearance| lash| springs?| seals?)?", "valve train"] },
    { name: "Cam chain tensioner", match: ["(?:cam )?chain tensioners?", "cam chains?", "timing chains?"] },
    { name: "Camshaft", match: ["cam(?:shaft)?s?", "cam lobes?"] },
    { name: "Cylinder head", match: ["cylinder heads?"] },
    { name: "Head gasket", match: ["head gaskets?"] },
    { name: "Piston and rings", match: ["pistons?(?: rings?)?", "(?:piston|compression|oil) rings?"] },
    { name: "Crankshaft", match: ["crank(?:shaft)?s?", "(?:crank|main) bearings?"] },
    { name: "Oil pump", match: ["oil pumps?"] },
  ],
  electrical: [
    { name: "ECU", match: ["ecu", "ecm", "engine control (?:unit|module)"] },
    { name: "Fuse box", match: ["fuses?", "fuse (?:box|block|panel)(?:es)?"] },
    { name: "Relays", match: ["relays?"] },
    { name: "Wiring harness", match: ["(?:wiring |main )?harness(?:es)?", "wir(?:e|es|ing)"] },
    { name: "Key switch", match: ["(?:key|ignition) switch(?:es)?"] },
    { name: "Instrument cluster", match: ["(?:instrument )?clusters?", "gauges?", "speedometers?", "displays?"], only: ["utv", "atv"] },
    { name: "Headlights", match: ["head ?lights?", "lights?", "lamps?", "tail ?lights?"], only: ["utv", "atv"] },
    { name: "Speed sensor", match: ["(?:vehicle |wheel )?speed sensors?", "vss"], only: ["utv", "atv"] },
    { name: "Ground wires", match: ["grounds?", "ground (?:wires?|straps?|connections?)"] },
    { name: "Control panel", match: ["control panels?", "outlets?", "receptacles?"], only: ["generator"] },
  ],
  drive_clutch: [
    { name: "Drive belt", match: ["(?<!seat )belts?", "drive belts?"] },
    { name: "Drive clutch", match: ["(?:drive|primary) clutch(?:es)?"] },
    { name: "Driven clutch", match: ["(?:driven|secondary) clutch(?:es)?"] },
    { name: "Clutch cover", match: ["clutch (?:covers?|cover gaskets?)"] },
    { name: "Clutch ducts", match: ["clutch (?:ducts?|ducting|intake|outlet)", "pvt (?:ducts?|intake|outlet)"] },
    { name: "One-way bearing", match: ["one.?way (?:bearings?|clutch(?:es)?)", "ebs"], only: ["atv"] },
  ],
  transmission: [
    { name: "Transmission", match: ["transmissions?", "gear ?box(?:es)?"] },
    { name: "Shift cable", match: ["shift(?:er)? cables?"] },
    { name: "Gear selector", match: ["gear selectors?", "shift(?:er)? (?:levers?|handles?)", "range selectors?"] },
    { name: "Gear position switch", match: ["gear position (?:switch(?:es)?|sensors?)", "(?:neutral|park|reverse) switch(?:es)?"] },
    { name: "Shift linkage", match: ["shift linkages?", "linkages?", "shift (?:forks?|drums?)"] },
  ],
  front_drive: [
    { name: "Front gearcase", match: ["front (?:gear ?cases?|diff\\w*)", "gear ?cases?"] },
    { name: "Front drive axle", match: ["front (?:drive )?(?:axles?|half.?shafts?|cv axles?)", "(?:cv |drive )?axles?", "half.?shafts?"] },
    { name: "Front prop shaft", match: ["(?:front )?prop ?shafts?"] },
    { name: "CV boot", match: ["(?:front )?cv (?:boots?|joints?)", "boots?"] },
    { name: "AWD coil", match: ["(?:awd|adc|demand drive|hilliard)(?: (?:coil|clutch|module|solenoid)s?)?"] },
  ],
  rear_drive: [
    { name: "Rear gearcase", match: ["rear (?:gear ?cases?|diff\\w*)", "gear ?cases?"] },
    { name: "Rear drive axle", match: ["rear (?:drive )?(?:axles?|half.?shafts?|cv axles?)", "(?:cv |drive )?axles?", "half.?shafts?"] },
    { name: "Rear prop shaft", match: ["rear prop ?shafts?", "prop ?shafts?"] },
    { name: "CV boot", match: ["(?:rear )?cv (?:boots?|joints?)", "boots?"] },
  ],
  brakes: [
    { name: "Brake pads", match: ["(?:brake )?pads?"] },
    { name: "Brake caliper", match: ["(?:brake )?calipers?"] },
    { name: "Brake disc", match: ["(?:brake )?(?:discs?|disks?|rotors?)"] },
    { name: "Master cylinder", match: ["master cylinders?"] },
    { name: "Brake lines", match: ["brake (?:lines?|hoses?)"] },
    { name: "Parking brake", match: ["park(?:ing)? brakes?"] },
  ],
  steering: [
    { name: "Tie rod end", match: ["tie.?rods?(?: ends?)?"] },
    { name: "Steering rack", match: ["steering (?:racks?|gear ?box(?:es)?)", "rack and pinion"], only: ["utv"] },
    { name: "EPS unit", match: ["eps(?: units?| motors?)?", "power steering(?: units?)?"] },
    { name: "Steering shaft", match: ["steering (?:shafts?|columns?)"], only: ["utv"] },
    { name: "Steering post", match: ["steering (?:posts?|stems?)", "handlebars?"], only: ["atv"] },
  ],
  suspension: [
    { name: "Shocks", match: ["shocks?(?: absorbers?)?", "coil.?overs?"] },
    { name: "A-arms", match: ["a.?arms?", "control arms?"] },
    { name: "Ball joints", match: ["ball joints?"] },
    { name: "Bushings", match: ["bushings?"] },
    { name: "Stabilizer bar", match: ["(?:stabili[sz]er|sway) bars?(?: links?)?"] },
    { name: "Trailing arms", match: ["trailing arms?", "radius rods?"] },
    { name: "Springs", match: ["(?:coil )?springs?"] },
  ],
  wheels_tires: [
    { name: "Tire", match: ["tires?", "tyres?"] },
    { name: "Wheel", match: ["wheels?", "rims?"] },
    { name: "Wheel bearing", match: ["(?:wheel |hub )bearings?"] },
    { name: "Wheel hub", match: ["(?:wheel )?hubs?"] },
    { name: "Lug nuts", match: ["(?:lug|wheel) nuts?"] },
  ],
  body_frame: [
    { name: "Cargo box", match: ["cargo (?:box|bed)(?:es)?", "dump bed"], only: ["utv"] },
    { name: "Seat", match: ["seats?"], only: ["utv", "atv"] },
    { name: "Body panels", match: ["(?:body )?panels?", "plastics?", "fenders?"] },
    { name: "Frame", match: ["frames?(?: welds?| cracks?)?"] },
    { name: "Racks", match: ["(?:front |rear |cargo )?racks?"], only: ["atv"] },
    { name: "Front bumper", match: ["(?:front )?bumpers?"], only: ["utv"] },
    { name: "Roll cage", match: ["rops", "roll cages?", "cages?", "roofs?"], only: ["utv"] },
  ],
};

// Nouns that name a part whatever the system, for a cause's part that isn't
// on the list ("Water in the speedometer connector"): the noun with up to
// two words before it, which have to leave at least one once the words
// that only describe a fault are taken off.
const NOUNS =
  "(?:connectors?|sensors?|switch(?:es)?|relays?|fuses?|hoses?|lines?|cables?|seals?|bearings?|gaskets?|bushings?|boots?|mounts?|bolts?|clamps?|brackets?|valves?|pumps?|filters?|belts?|chains?|wires?|terminals?|modules?|motors?|levers?|linkages?|harness(?:es)?)";
const PART_NOUNS = `(?:[a-z0-9/-]+ ){0,2}${NOUNS}`;

// Words that say what's wrong, not which part ("Worn drive belt", "Water
// in the connector"), and small words: taken off the ends of a part's name.
const NOT_PART = new Set(
  (
    "the a an in on at of to from into inside behind under and or with by its this that " +
    "low high weak bad worn faulty failing failed defective loose cracked damaged corroded broken leaking leaky stuck " +
    "sticking dirty clogged plugged blocked restricted blown wet water moisture missing bent seized stretched glazed " +
    "frayed chafed chafing pinched kinked collapsed contaminated intermittent poor open shorted short burnt burned melted " +
    "binding misadjusted incorrect wrong excessive insufficient no weakening sticky noisy slipping overheating lean rich " +
    "torn split warped scored pitted swollen ruptured sulfated fouled seeping stripped sheared " +
    "leak leaks corrosion crack cracks damage wear play noise debris dirt air failure fault problem issue condition " +
    "breaking down out possible likely"
  ).split(" "),
);

// Abbreviations kept in capitals in a name made from a cause's words.
const ACRONYMS = new Set(
  "ecu ecm cdi efi fi egt tps iac eps cv awd adc abs o2 map t-map vss cps ckp ect led pvt ebs rops atv utv".split(" "),
);

const pattern = (source: string) => new RegExp(`\\b${source}\\b`, "gi");

const PART_PATTERNS = Object.fromEntries(
  Object.entries(PART_NAMES).map(([system, parts]) => [
    system,
    parts.flatMap((part) => part.match.map((source) => ({ part, regex: pattern(source) }))),
  ]),
) as Record<DrawnSystem, { part: Part; regex: RegExp }[]>;
const NOUN_PATTERN = pattern(PART_NOUNS);
const NOUN_WORD = new RegExp(`^${NOUNS}$`, "i");

// "speedometer connector" -> "Speedometer connector", "ecu relay" -> "ECU
// relay".
function asName(words: string[]) {
  return words
    .map((word, index) => (ACRONYMS.has(word) ? word.toUpperCase() : index === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

// A phrase's words without the fault words and small words at either end.
function trimmed(phrase: string) {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  while (words.length > 0 && NOT_PART.has(words[0])) words.shift();
  while (words.length > 0 && NOT_PART.has(words[words.length - 1])) words.pop();
  return words;
}

// The longest match in the text of any of the patterns.
function longest<T>(text: string, patterns: { regex: RegExp; value: T }[]) {
  let best: { value: T; text: string } | null = null;
  for (const { regex, value } of patterns) {
    for (const match of text.matchAll(regex)) {
      if (!best || match[0].length > best.text.length) best = { value, text: match[0] };
    }
  }
  return best;
}

// The part a cause's title names, in a system: one on the list ("Starter
// solenoid failing" -> "Starter solenoid", "Fouled or worn spark plugs" ->
// "Spark plug"), or the part noun it names ("Water in the speedometer
// connector" -> "Speedometer connector"), or failing both its words
// without the fault ones ("Low fuel pressure" -> "Fuel pressure"); null
// when nothing in it names a part ("Lean condition", "Air pocket in the
// cooling system").
export function partOfCause(title: string, system: DrawnSystem): string | null {
  const text = String(title ?? "").replace(/\([^)]*\)/g, " ");
  const listed = longest(text, PART_PATTERNS[system].map(({ part, regex }) => ({ regex, value: part })));
  // A part noun's words don't run through one that says what's wrong:
  // "Failed fuel pump relay" is the relay's, not the fuel pump's.
  const nounText = text.replace(/[A-Za-z]+/g, (word) => (NOT_PART.has(word.toLowerCase()) ? "|" : word));
  const noun = longest(nounText, [{ regex: NOUN_PATTERN, value: null }]);
  const nounWords = noun ? trimmed(noun.text) : [];
  // A noun with words of its own ("speedometer connector") beats a shorter
  // listed name inside it ("connector" isn't one; "battery" in "battery
  // terminal connector" is).
  if (nounWords.length >= 2 && (!listed || nounWords.join(" ").length > listed.text.length)) return asName(nounWords);
  if (listed) return listed.value.name;
  // What the title says before it says why, when or where ("..., under
  // load", "... due to ..."), and of "X in the Y" the part: Y when X only
  // says what's wrong ("Water in the connector").
  const first = text.split(/\s*(?:[,;:]|\s[-–—]\s|\b(?:due to|because|when|under|during|after|while|causing|from)\b)\s*/i)[0];
  const [left, right] = first.split(/\s+\b(?:at|in|on|of|inside|behind|to)\s+(?:the|a|an)\b\s+/i);
  const leftWords = trimmed(left ?? "");
  const words = right !== undefined && (leftWords.length === 0 || NOT_PART.has(left.trim().split(/\s+/).at(-1)!.toLowerCase())) ? trimmed(right) : leftWords;
  if (words.length === 0 || words.length > 4) return null;
  // One word that isn't a part on its own ("Pocket", "Compression").
  if (words.length === 1 && !NOUN_WORD.test(words[0])) return null;
  return asName(words);
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// A cause as the sheet needs it: its title, system (as tagged, or worked
// out from its words) and how it stands on the screen.
export type SheetCause = { title: string; system?: unknown; why?: string; status: CauseState };

const STATUS_ORDER: Record<CauseState, number> = { confirmed: 0, open: 1, ruled_out: 2 };

// The causes in a system, as the screen orders them: the confirmed one,
// then the open ones, ruled-out ones last; Claude's order within each.
export function causesIn<T extends SheetCause>(causes: T[], system: DrawnSystem): T[] {
  return causes
    .map((cause, index) => ({ cause, index }))
    .filter(({ cause }) => causeSystem({ system: cause.system, title: cause.title, why: cause.why }) === system)
    .sort((a, b) => STATUS_ORDER[a.cause.status] - STATUS_ORDER[b.cause.status] || a.index - b.index)
    .map(({ cause }) => cause);
}

export const MAX_PARTS = 10;

// The part names to pick from for a system: the parts the conversation's
// causes there name (in the screen's order), then the system's own list for
// the kind of unit (all of it when the kind isn't known), each once.
export function partNames(system: DrawnSystem, { vehicle = null, causes = [] }: { vehicle?: UnitVehicle | null; causes?: SheetCause[] } = {}): string[] {
  const names: string[] = [];
  const add = (name: string | null) => {
    if (name && !names.some((other) => sameName(other, name))) names.push(name);
  };
  for (const cause of causesIn(causes, system)) add(partOfCause(cause.title, system));
  for (const part of PART_NAMES[system]) {
    if (!part.only || vehicle === null || part.only.includes(vehicle)) add(part.name);
  }
  return names.slice(0, MAX_PARTS);
}

// What to search the manuals for: the part's name as words ("Regulator/
// rectifier" -> "regulator rectifier", "Piston and rings" -> "piston
// rings").
export function partSearchText(part: string) {
  return part
    .replace(/[/&+]+/g, " ")
    .replace(/\b(?:and|or|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- The sheet ------------------------------------------------------------------

// A page that shows the part; cited: one the conversation's causes cite;
// about: one about the part (see aboutPart), not one that only names it.
export type PartPage = { manualId: string; page: number; title: string; cited: boolean; about: boolean };

// What the part sheet shows for a system (see src/lib/diagnose-part-sheet.ts).
export type PartSheet = {
  system: DrawnSystem;
  // The names to pick from, and the one picked.
  parts: string[];
  part: string;
  // Best first: the one drawn large, then the others.
  pages: PartPage[];
  // No manual to search: the unit has none in the library, or no unit has
  // been picked (the pages, if any, are the ones the causes cite).
  noManual: boolean;
  // The card of the page asked about, else of the large page; null with no
  // page at all, or when the large page isn't about the part (no page is:
  // the screen says so and shows the pages that name it without a card).
  facts: { page: PageRef; state: FactsState } | null;
};

// A page's card, asked for on its own (src/lib/diagnose-part-sheet.ts).
export type PartCard = { page: PageRef; state: FactsState };

// --- On the screen --------------------------------------------------------------

export const samePage = (a: PageRef, b: PageRef) => a.manualId.toLowerCase() === b.manualId.toLowerCase() && a.page === b.page;

// The page drawn large: the one the tech picked among the part's pages,
// else the best.
export function largePage(sheet: Pick<PartSheet, "pages">, picked: PageRef | null): PartPage | null {
  return (picked && sheet.pages.find((page) => samePage(page, picked))) || sheet.pages[0] || null;
}

// The part's other pages, best first, for the small pictures under it.
export function otherPages(sheet: Pick<PartSheet, "pages">, large: PageRef): PartPage[] {
  return sheet.pages.filter((page) => !samePage(page, large));
}

// A page's card as the sheet brought it: only the large page's, the first
// time (null for any other page, which is asked for on its own).
export function cardOf(sheet: Pick<PartSheet, "facts">, page: PageRef): FactsState | null {
  return sheet.facts && samePage(sheet.facts.page, page) ? sheet.facts.state : null;
}

// Where a card's numbered steps skip numbers (the check against the page
// left a step out): each gap's first and last number, before the step
// after it. Only for a card the check left something out of; a page's own
// numbering can skip.
export function stepGaps(steps: { n: number }[], partial: boolean): Map<number, [number, number]> {
  const gaps = new Map<number, [number, number]>();
  if (!partial) return gaps;
  steps.forEach((step, index) => {
    const before = index === 0 ? 0 : steps[index - 1].n;
    if (step.n > before + 1) gaps.set(index, [before + 1, step.n - 1]);
  });
  return gaps;
}

// Whether asking about a page's card again now would change nothing: read,
// read with nothing on it, or not readable now (no API key, the day's
// readings used, a failed read tried again only later). "unread" and
// "reading" are worth asking again.
export const cardSettled = (state: FactsState) => state.status === "ready" || state.status === "empty" || state.status === "unavailable";

// The Library's search for a part, for a unit with no page for it.
export const partLibraryHref = (part: string) => `/library?q=${encodeURIComponent(part.replace(/\s+/g, " ").trim())}`;

// --- Ranking a part's pages -----------------------------------------------------

// Words a service procedure's page has in its headings and boxes
// ("STARTER SOLENOID REPLACEMENT", "TORQUE").
export const PROCEDURE_WORDS = ["service", "replacement", "removal", "installation", "inspection", "torque", "disassembly", "assembly", "adjustment", "test"];

// A page's contents or index (lines of headings with dot leaders and page
// numbers: "Starter Solenoid Replacement ........ 10.45"): it names every
// part but shows none.
export function isContentsPage(text: string) {
  return (text.match(/(?:\.\s?){4,}\s*\d/g) ?? []).length >= 3;
}

// How many of the page's lines start like a numbered step ("1. Raise dump
// bed."), counting each number once.
export function numberedSteps(text: string) {
  const numbers = new Set<number>();
  for (const match of text.matchAll(/(?:^|\n)\s*(\d{1,2})[.)]\s+[A-Za-z]/g)) numbers.add(Number(match[1]));
  return numbers.size;
}

// Whether the page has every word of the part's name.
export function mentionsPart(text: string, part: string) {
  const page = new Set(wordsOf(text));
  const wanted = wordsOf(partSearchText(part));
  return wanted.length > 0 && wanted.every((word) => page.has(word));
}

// A heading naming the part: a line in capitals with every word of it,
// and a procedure word when asked for one ("STARTER SOLENOID REPLACEMENT"),
// else any ("CARGO BOX", "BATTERY LOCATION": a diagram's or a location's).
function hasHeading(text: string, part: string, procedure: boolean) {
  const wanted = wordsOf(partSearchText(part));
  return text.split("\n").some((line) => {
    const letters = line.replace(/[^A-Za-z]/g, "");
    if (letters.length < 6 || letters !== letters.toUpperCase()) return false;
    const words = new Set(wordsOf(line));
    return wanted.every((word) => words.has(word)) && (!procedure || PROCEDURE_WORDS.some((word) => words.has(stem(word))));
  });
}

// Whether a page is about the part (its procedure, its diagram, where it
// is), not one that only names it on the way (another part's procedure:
// "1. Raise the rear cargo box."): one a cause naming the part cites, or
// one with a heading naming it.
export function aboutPart(page: Pick<PageCandidate, "text" | "cited">, part: string) {
  return page.cited === "part" || (mentionsPart(page.text, part) && !isContentsPage(page.text) && hasHeading(page.text, part, false));
}

export type PageCandidate = {
  manualId: string;
  page: number;
  // The manual's title, as the screen shows it.
  title: string;
  text: string;
  // Full-text search's rank (0 for a page it didn't find).
  rank: number;
  // In the unit's own manual (by its model number).
  own: boolean;
  // Cited by a cause naming this part, or by another cause in the system.
  cited: "part" | "system" | null;
};

// How well a page shows the part: a page a cause naming this part cites
// comes first. Then, among pages with the part on them, the ones about it
// (a heading names it), its service procedure most (the heading's
// procedure word, procedure words, numbered steps, a torque spec, which
// only count on a page about the part), over pages that only mention it (a
// wiring diagram, a troubleshooting chart, another part's procedure), with
// a little more for one the system's other causes cite (but not enough to
// beat a page about the part). The unit's own manual over others; search's
// own rank last. A page without the part (found by some of its words) comes
// after those, and a contents page after everything a cause naming the part
// doesn't cite: shown large only when the search finds nothing else, and
// then, as it's about no part, as a page that only names it.
export function pageScore(page: PageCandidate, part: string) {
  const text = page.text;
  let score = page.cited === "part" ? 100 : 0;
  if (mentionsPart(text, part)) {
    const words = new Set(wordsOf(text));
    score += 10;
    // A contents page's lines are headings of other pages.
    const procedure = !isContentsPage(text) && hasHeading(text, part, true);
    const about = procedure || (!isContentsPage(text) && hasHeading(text, part, false));
    if (page.cited === "system") score += about ? 15 : 8;
    const phrase = wordsOf(partSearchText(part)).join(" ");
    if (phrase.includes(" ") && wordsOf(text).join(" ").includes(phrase)) score += 4;
    if (about) {
      score += procedure ? 30 : 20;
      score += Math.min(10, 2 * PROCEDURE_WORDS.filter((word) => words.has(stem(word))).length);
      if (numberedSteps(text) >= 2) score += 6;
      if (/\d\s*(?:in\.?|ft\.?)[\s.-]*lbs?\b|\d\s*N\s*[·•∙⋅.-]?\s*m\b/i.test(text)) score += 3;
    }
  }
  if (isContentsPage(text)) score -= 40;
  if (page.own) score += 5;
  score += 3 * Math.min(1, Math.max(0, page.rank));
  return score;
}

// The pages to show for a part, best first: at most `limit` (the one drawn
// large, then the others).
export function rankPages<T extends PageCandidate>(pages: T[], part: string, limit = 4): T[] {
  const seen = new Set<string>();
  return pages
    .filter((page) => {
      const key = `${page.manualId.toLowerCase()}:${page.page}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((page) => ({ page, score: pageScore(page, part) }))
    .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title) || a.page.page - b.page.page)
    .slice(0, limit)
    .map(({ page }) => page);
}
