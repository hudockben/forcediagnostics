// The systems of a machine that Claude tags each likely cause with, and that
// the unit graphic lights up: one fixed list shared by submit_diagnosis's
// schema, the reply checks and the drawings. Every one but "other" is a
// region of the side-by-side and ATV drawings, in its real place on the
// machine. Kept free of database and React imports, so the server, the
// browser and the tests share it. Which drawing a unit gets is worked out on
// the server (src/lib/unit-vehicle.ts).

export const CAUSE_SYSTEMS = [
  "engine",
  "fuel",
  "air_intake",
  "ignition",
  "exhaust",
  "cooling",
  "charging_starting",
  "electrical",
  "drive_clutch",
  "transmission",
  "front_drive",
  "rear_drive",
  "brakes",
  "steering",
  "suspension",
  "wheels_tires",
  "body_frame",
  "other",
] as const;
export type CauseSystem = (typeof CAUSE_SYSTEMS)[number];
export type DrawnSystem = Exclude<CauseSystem, "other">;

export const isCauseSystem = (value: unknown): value is CauseSystem => CAUSE_SYSTEMS.includes(value as CauseSystem);

// As the screen names them.
export const SYSTEM_LABELS: Record<CauseSystem, string> = {
  engine: "Engine",
  fuel: "Fuel",
  air_intake: "Air intake",
  ignition: "Ignition",
  exhaust: "Exhaust",
  cooling: "Cooling",
  charging_starting: "Charging / starting",
  electrical: "Electrical",
  drive_clutch: "Drive clutch",
  transmission: "Transmission",
  front_drive: "Front drive",
  rear_drive: "Rear drive",
  brakes: "Brakes",
  steering: "Steering",
  suspension: "Suspension",
  wheels_tires: "Wheels / tires",
  body_frame: "Body / frame",
  other: "Other",
};

// --- Older replies ------------------------------------------------------------

// Replies saved before causes carried a system (and a new reply whose
// system is missing or not on the list): the system worked out from the
// cause's words. Every rule that matches is scored by the length of the
// words it matched and the longest wins, so a specific part beats a
// generic word ("spark arrestor" is exhaust, not the "spark" of ignition;
// "AWD coil" is front drive, not an ignition coil; "starter relay" is
// starting, not electrical). On a tie the earlier rule wins. Symptoms
// ("misfire", "won't start") aren't keywords: they don't say which part is
// at fault. The title is tried before the why.
// Each rule is a list of word patterns, each tried on its own.
const RULES: [CauseSystem, string[]][] = [
  ["charging_starting", ["stator", "(?:voltage )?regulator(?:/rectifier)?", "rectifier", "batter(?:y|ies)(?: cables?| terminals?| drain)?", "starter(?: motor| relay| solenoid| bendix| drive)?", "starting system", "charging(?: system)?", "alternator", "flywheel"]],
  ["ignition", ["ignition(?: coils?| switch| system)?", "coils?", "coil packs?", "spark plugs?", "plugs? (?:wires?|caps?|boots?|gaps?)", "spark", "cdi"]],
  ["drive_clutch", ["(?<!seat )belts?", "drive belt", "clutch\\w*", "(?:primary|secondary|drive|driven) clutch", "clutch (?:cover|duct|weights?|springs?)", "cvt", "pvt", "sheaves?", "one.?way bearing", "engine brak\\w*", "ebs"]],
  ["cooling", ["coolant(?: leak| level| hoses?)?", "radiator(?: caps?| fins?| hoses?)?", "thermostat", "water pump", "cooling(?: system| fan)?", "overheat\\w*", "fans?", "fan (?:motor|blades?)", "antifreeze"]],
  ["fuel", ["fuel(?: pump| filter| pressure| tank| lines?| injectors?| rail)?", "injectors?", "petrol", "gas (?:tank|cap)", "fuel cap", "(?:tank|fuel tank|gas cap) vent", "vent (?:line|hose)s?", "vapou?r lock", "evap", "carb\\w*"]],
  ["air_intake", ["air ?filters?", "air ?box", "intake(?: boots?| leak| manifold)?", "throttle body", "throttle (?:return )?(?:springs?|cables?|plates?)", "idle air(?: control)?", "iac", "vacuum leak", "snorkel", "air leak"]],
  ["exhaust", ["exhaust(?: leak| gaskets?| manifold)?", "headers?(?: pipes?| gaskets?| nuts?)?", "mufflers?", "silencer", "spark arrest\\w*(?: screen)?", "backfir\\w*", "decel pop\\w*", "pops? on decel\\w*", "catalytic converter"]],
  ["brakes", ["brakes?", "brake (?:pads?|lines?|fluid|rotors?|calipers?|master cylinder|pedal)", "braking", "calipers?", "rotors?", "master cylinder", "abs"]],
  ["steering", ["steering(?: rack| column| wheel| shaft)?", "eps", "power steer\\w*", "tie.?rods?(?: ends?)?", "rack and pinion", "handlebars?"]],
  ["rear_drive", ["rear (?:gear ?case|diff\\w*|drive|axles?|cv\\w*|half.?shafts?|hubs?|prop ?shaft)(?: (?:cv )?(?:joints?|boots?|seals?|bearings?))?"]],
  [
    "front_drive",
    [
      "front (?:gear ?case|diff\\w*|drive|axles?|cv\\w*|half.?shafts?|hubs?|prop ?shaft)(?: (?:cv )?(?:joints?|boots?|seals?|bearings?|coils?))?",
      "(?:awd|adc|demand drive|hilliard)(?: (?:coil|clutch|module|solenoid)s?)?",
      "all.?wheel drive",
      "prop ?shaft",
      "cv (?:joints?|boots?|axles?)",
      "half.?shafts?",
      "axles?",
    ],
  ],
  ["transmission", ["transmission", "gear ?box", "gear ?case", "shift\\w*(?: linkage| cables?| forks?| drum)?", "gears?", "linkage", "park(?:ing)? (?:pawl|lock)", "reverse", "range selector"]],
  ["suspension", ["shocks?(?: absorbers?)?", "coil.?overs?(?: shocks?)?", "coil springs?", "springs?", "a.?arms?", "control arms?", "ball joints?", "bushings?", "sway bar(?: links?)?", "stabili[sz]er\\w*", "trailing arms?", "radius rods?", "suspension", "ride height"]],
  ["wheels_tires", ["tires?", "tyres?", "wheels?", "rims?", "lug nuts?", "wheel bearings?", "tread", "puncture"]],
  [
    "electrical",
    [
      "wir(?:e|es|ing)(?: harness)?",
      "harness",
      "connectors?",
      "ecu",
      "ecm",
      "(?:[a-z0-9]+ ){0,2}sensors?",
      "switch(?:es)?",
      "fuses?",
      "relays?",
      "grounds?",
      "ground (?:wire|strap)s?",
      "gauges?",
      "display",
      "lights?",
      "headlights?",
      "tps",
      "electrical(?: fault| short)?",
      "voltage",
      "short(?:ed)?",
    ],
  ],
  ["body_frame", ["frame(?: welds?| cracks?)?", "cage", "rops", "body", "panels?", "seats?", "doors?", "roof", "cargo (?:bed|box)", "bed", "racks?", "fenders?", "plastics?", "welds?", "rattl\\w*"]],
  ["engine", ["engine", "motor", "compression", "valves?(?: clearance| lash)?", "cam\\w*", "pistons?(?: rings?)?", "rings?", "head gasket", "cylinders?(?: head)?", "oil(?: pressure| pump| level)?", "crank\\w*", "timing(?: chain)?", "bearings?", "knock\\w*", "blow.?by", "smok\\w*"]],
];
const KEYWORDS: [CauseSystem, RegExp][] = RULES.flatMap(([system, patterns]) =>
  patterns.map((pattern): [CauseSystem, RegExp] => [system, new RegExp(`\\b${pattern}\\b`, "gi")]),
);

export function inferSystem(title: string, why = ""): CauseSystem {
  for (const text of [title, why]) {
    let best: { system: CauseSystem; length: number } | null = null;
    for (const [system, pattern] of KEYWORDS) {
      for (const match of String(text ?? "").matchAll(pattern)) {
        if (!best || match[0].length > best.length) best = { system, length: match[0].length };
      }
    }
    if (best) return best.system;
  }
  return "other";
}

// A system as Claude sent it, if it's one of the list (allowing for case
// and spaces: "Drive clutch" is drive_clutch), else null.
export function listedSystem(value: unknown): CauseSystem | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[\s/-]+/g, "_");
  return isCauseSystem(key) ? key : null;
}

// A cause's system: as Claude tagged it, or worked out from its words when
// the reply was saved before causes carried one.
export function causeSystem(cause: { system?: unknown; title: string; why?: string }): CauseSystem {
  return listedSystem(cause.system) ?? inferSystem(cause.title, cause.why ?? "");
}

// --- Glow --------------------------------------------------------------------

export type CauseLikelihood = "high" | "medium" | "low";
export type CauseState = "open" | "ruled_out" | "confirmed";

// How a system shows on the graphic, from the causes tagged to it: a
// confirmed cause wins, then the likeliest open one; only ruled-out causes
// leave it dimmed; none, the plain line-work.
export const GLOWS = ["confirmed", "high", "medium", "low", "ruled_out", "none"] as const;
export type Glow = (typeof GLOWS)[number];

// muted: a cause is confirmed elsewhere, so this system steps back (no
// glow or pulse, outline only) and the confirmed part stands out.
export type ZoneState = { system: CauseSystem; glow: Glow; causes: number[]; muted: boolean };

const LIKELIHOOD_RANK: Record<CauseLikelihood, number> = { high: 3, medium: 2, low: 1 };

export function glowFor(causes: { likelihood: CauseLikelihood; status: CauseState }[]): Glow {
  if (causes.length === 0) return "none";
  if (causes.some((cause) => cause.status === "confirmed")) return "confirmed";
  const open = causes.filter((cause) => cause.status === "open");
  if (open.length === 0) return "ruled_out";
  return open.reduce((best, cause) => (LIKELIHOOD_RANK[cause.likelihood] > LIKELIHOOD_RANK[best] ? cause.likelihood : best), "low" as CauseLikelihood);
}

// Every system that has causes, with its glow and the causes' positions in
// the list, in the list's order of first appearance. Once one is confirmed,
// the open ones are muted.
export function zoneStates(
  causes: { system: CauseSystem; likelihood: CauseLikelihood; status: CauseState }[],
): Map<CauseSystem, ZoneState> {
  const grouped = new Map<CauseSystem, number[]>();
  causes.forEach((cause, index) => grouped.set(cause.system, [...(grouped.get(cause.system) ?? []), index]));
  const states = new Map<CauseSystem, ZoneState>();
  for (const [system, indexes] of grouped) {
    states.set(system, { system, glow: glowFor(indexes.map((index) => causes[index])), causes: indexes, muted: false });
  }
  if ([...states.values()].some((state) => state.glow === "confirmed")) {
    for (const state of states.values()) state.muted = state.glow === "high" || state.glow === "medium" || state.glow === "low";
  }
  return states;
}

// The status the screen shows for a cause: the tech's own press, until
// Claude has heard about it, then Claude's latest word, except that the
// cause the tech said "This was it" to (the conversation's outcome) stays
// confirmed until they take it back.
export function shownStatus(
  cause: { title: string; status: CauseState },
  feedback: { title: string; verdict: CauseState; sentInSeq: number | null }[],
  outcomeTitle: string | null = null,
): CauseState {
  const same = (title: string) => title.toLowerCase() === cause.title.toLowerCase();
  const entry = feedback.findLast((item) => same(item.title));
  if (entry && entry.sentInSeq === null) return entry.verdict;
  return outcomeTitle !== null && same(outcomeTitle) ? "confirmed" : cause.status;
}

// --- Which drawing ---------------------------------------------------------------

export const UNIT_VEHICLES = ["utv", "atv", "generator"] as const;
export type UnitVehicle = (typeof UNIT_VEHICLES)[number];

export const VEHICLE_DRAWING_NAMES: Record<UnitVehicle, string> = {
  utv: "Side-by-side",
  atv: "ATV",
  generator: "Generator",
};
