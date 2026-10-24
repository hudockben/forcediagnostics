// The unit's paint, read from Polaris's model description ("RZR XP 1000 EPS
// INDY RED", "SPM XP 850, PNTD RED", "SPORTSMAN 570 POLARIS PURSUIT CAMO",
// "OUTLAW 50, AVALANCHE GREY/LIME SQUEEZE", "RGR CREW XP 1000 NS ULT -
// SUNSET RED MTL"), for the 3D unit. Pure, for the server and the tests.
//
// The model list cuts descriptions at 40 characters, so the last word can
// be the start of a colour's ("GHOST GRA", "MATTE TITANI", "SAGE GREE").
// Polaris also shortens colours its own way: S.GREEN, SGRN, BLK, WHT, PPC
// (Polaris Pursuit Camo), A.CRYSTAL, W.LIGHTNING. A two-tone is written
// with a slash ("RED/BLK", "BRIGHT WHITE/INDY RED"): the first is the main
// colour, the second the accent. Anything else is a neutral gray.

export type PaintFinish = "gloss" | "matte" | "metallic" | "pearl";

export type UnitPaint = {
  // A short key for the colour ("sage-green", "bright-white+indy-red",
  // "polaris-pursuit-camo", "unknown"), for tests and the page's data.
  key: string;
  // As a tech would say it.
  name: string;
  // #rrggbb.
  base: string;
  // The second colour of a two-tone.
  accent: string | null;
  finish: PaintFinish;
  // A camouflage print: Polaris Pursuit Camo, or another (Mossy Oak,
  // Browning, Realtree...).
  camo: "pursuit" | "other" | null;
  // False when the description named no colour this knows.
  known: boolean;
};

type Colour = { key: string; name: string; hex: string; finish?: PaintFinish; camo?: "pursuit" | "other" };

// Each colour with the ways it's written, longest and most specific first
// (a bare BLUE or RED is a last resort). Words are matched whole, upper case,
// with dots and dashes between letters read as spaces ("S.GREEN" is "S GREEN").
const COLOURS: [Colour, string[]][] = [
  // Camouflage.
  [{ key: "polaris-pursuit-camo", name: "Polaris Pursuit Camo", hex: "#6b5f48", camo: "pursuit", finish: "matte" }, ["POLARIS PURSUIT CAMO", "POLARIS PUR CAMO", "POLARIS PURSUIT", "PURSUIT CAMO", "PRST CAMO", "PRST CM", "PPC", "PPWC", "PII CAMO"]],
  [{ key: "camo", name: "Camo", hex: "#5d5a44", camo: "other", finish: "matte" }, ["MOSSY OAK CAMO", "MOSSY OAK", "MOSSY", "NEW BREAKUP", "BREAKUP", "BREAK UP", "NEWBRKUP", "MONBU", "NBU", "BU", "BROWNING", "REALTREE", "NIGHT CAMO", "SD CAMO", "SAND CAMO", "CAMO"]],

  // Reds.
  [{ key: "indy-red", name: "Indy Red", hex: "#b4141c" }, ["INDY RED", "I RED", "I RD", "INDIAN RED", "INRED", "INDY"]],
  [{ key: "solar-red", name: "Solar Red", hex: "#c51f1d" }, ["SOLAR RED", "S RED"]],
  [{ key: "sunset-red", name: "Sunset Red", hex: "#931b1f", finish: "metallic" }, ["SUNSET RED METALLIC", "SUNSET RED MTLC", "SUNSET RED MTL", "SUNSET RED", "SUNSET"]],
  [{ key: "havasu-red", name: "Havasu Red", hex: "#8e171e", finish: "pearl" }, ["HAVASU RED PEARL", "HAVASU RED"]],
  [{ key: "performance-red", name: "Performance Red", hex: "#c21d24" }, ["PERFORMANCE RED"]],
  [{ key: "fury-red", name: "Fury Red", hex: "#b0171f" }, ["FURY RED"]],
  [{ key: "painted-red", name: "Red", hex: "#b2161d" }, ["PNTD RED", "PAINTED RED", "PAINT RED", "RD PRL", "RED PEARL"]],
  [{ key: "burgundy", name: "Burgundy", hex: "#5a1723", finish: "metallic" }, ["BURGUNDY METALLIC", "BURGUNDY"]],
  [{ key: "maroon", name: "Maroon", hex: "#561b20" }, ["DARK MAROON", "MAROON"]],
  [{ key: "crimson", name: "Crimson", hex: "#8a1521", finish: "metallic" }, ["CRIMSON METALLIC", "CRIMSON"]],

  // Oranges and yellows.
  [{ key: "nuclear-sunset", name: "Nuclear Sunset", hex: "#f2581b" }, ["NUCLEAR SUNSET ORANGE", "NUCLEAR SUNSET", "N SUNSET", "NSUNSET"]],
  [{ key: "orange-madness", name: "Orange Madness", hex: "#f2600f" }, ["ORANGE MADNESS"]],
  [{ key: "orange-burst", name: "Orange Burst", hex: "#f36d16" }, ["ORANGE BURST", "IRANGE BURST"]],
  [{ key: "spectra-orange", name: "Spectra Orange", hex: "#f06a1b" }, ["SPECTRA ORANGE"]],
  [{ key: "lava-orange", name: "Lava Orange", hex: "#d8501c", finish: "metallic" }, ["LAVA ORANGE METALLIC", "LAVA ORANGE"]],
  [{ key: "orange-rust", name: "Orange Rust", hex: "#a5532b", finish: "matte" }, ["MATTE ORANGE RUST", "GLOSS ORANGE RUST", "ORANGE RUST", "MATTE ORANGE", "ORST"]],
  [{ key: "orange", name: "Orange", hex: "#ee6a1f" }, ["ORANGE", "ORNG", "ORG"]],
  [{ key: "yellow", name: "Yellow", hex: "#f0c21a" }, ["YELLOW", "YLW"]],
  [{ key: "gold", name: "Gold", hex: "#b48d2e", finish: "metallic" }, ["GOLD"]],

  // Blues.
  [{ key: "velocity-blue", name: "Velocity Blue", hex: "#1d5ab5" }, ["VELOCITY BLUE", "VEL BLUE", "V BLUE", "V BL"]],
  [{ key: "voodoo-blue", name: "Voodoo Blue", hex: "#0c4ea3" }, ["VOODOO BLUE"]],
  [{ key: "radar-blue", name: "Radar Blue", hex: "#1f6ebd" }, ["RADAR BLUE"]],
  [{ key: "zenith-blue", name: "Zenith Blue", hex: "#1a4b9b" }, ["ZENITH BLUE", "ZEN BLUE", "Z BLUE", "Z BLU", "ZENITH"]],
  [{ key: "polaris-blue", name: "Polaris Blue", hex: "#0c4f9f" }, ["POLARIS BLUE"]],
  [{ key: "blue-fire", name: "Blue Fire", hex: "#1c55ad", finish: "metallic" }, ["BLUE FIRE METALLIC", "BLUE FIRE", "B FIRE"]],
  [{ key: "azure-crystal", name: "Azure Crystal", hex: "#1e78bd", finish: "metallic" }, ["AZURE CRYSTAL METALLIC", "AZURE CRYSTAL", "A CRYSTAL", "AZURE"]],
  [{ key: "storm-blue", name: "Storm Blue", hex: "#395673" }, ["STORM BLUE"]],
  [{ key: "blue-slate", name: "Blue Slate", hex: "#4e6377" }, ["BLUE SLATE", "BLUE SLT"]],
  [{ key: "steel-blue", name: "Steel Blue", hex: "#4a6c8a" }, ["STEELY BLUE", "STEEL BLUE", "SBLU"]],
  [{ key: "navy-blue", name: "Navy Blue", hex: "#1c2b4a" }, ["MATTE NAVY", "NAVY BLUE", "NAVY", "N BLUE"]],
  [{ key: "midnight-blue", name: "Midnight Blue", hex: "#1a2540" }, ["MIDNIGHT BLUE", "MIDNIGHT BLU", "MIDNIGHT"]],
  [{ key: "earth-blue", name: "Earth Blue", hex: "#35506a" }, ["EARTH BLUE"]],
  [{ key: "spirit-blue", name: "Spirit Blue", hex: "#2a5d9c" }, ["SPIRIT BLUE"]],
  [{ key: "blue-labyrinth", name: "Blue Labyrinth", hex: "#2a4a6d" }, ["BLUE LABYRINTH"]],
  [{ key: "electric-blue", name: "Electric Blue", hex: "#1b74cf" }, ["ELECTRIC BLUE", "E BLUE"]],
  [{ key: "sonic-blue", name: "Sonic Blue", hex: "#1d63c3" }, ["SONIC BLUE"]],
  [{ key: "boardwalk-blue", name: "Boardwalk Blue", hex: "#2a6bb4" }, ["BOARDWALK BLUE"]],
  [{ key: "sky-blue", name: "Sky Blue", hex: "#58a5da" }, ["SKY BLUE"]],
  [{ key: "indian-blue", name: "Indian Blue", hex: "#234e93" }, ["INDIAN S BLUE", "INDIAN BLUE"]],
  [{ key: "blue", name: "Blue", hex: "#1f59a5" }, ["BLUE", "BLU", "BL"]],

  // Grays, silvers and metals.
  [{ key: "avalanche-gray", name: "Avalanche Gray", hex: "#6c7276" }, ["AVALANCHE GRAY", "AVALANCHE GREY", "A GREY", "A GRAY", "AVALANCHE"]],
  [{ key: "ghost-gray", name: "Ghost Gray", hex: "#8d9295" }, ["GHOST GRAY", "GHOST GREY", "G GRAY", "G GREY", "GGRAY"]],
  [{ key: "stealth-gray", name: "Stealth Gray", hex: "#4a4e52" }, ["STEALTH GRAY", "STEALTH GREY", "STLTH GRAY", "STLTH GREY", "STH GRAY", "STH GRY", "STTH GRAY", "STTH GRY", "S GREY", "SGREY", "SGRAY"]],
  [{ key: "storm-gray", name: "Storm Gray", hex: "#5a5f63" }, ["STORM GRAY", "STORM GREY", "STM GR", "STR GR"]],
  [{ key: "slate-gray", name: "Slate Gray", hex: "#58606a" }, ["SLATE GRAY", "SLATE GREY"]],
  [{ key: "crater-gray", name: "Crater Gray", hex: "#6a6762" }, ["CRATER GRAY", "CRATER GREY"]],
  [{ key: "granite-gray", name: "Granite Gray", hex: "#626567" }, ["GRANITE GRAY", "GRANITE GREY", "GRANIT GREY", "GRANIT GRAY"]],
  [{ key: "magnetic-gray", name: "Magnetic Gray", hex: "#5a5d60", finish: "metallic" }, ["MAGNETIC GRAY", "MAGNETIC GREY", "MAGNETIC METALLIC", "MAGNETIC METAL", "MAGNETIC", "MAG METALLIC", "MAG GRAY", "MAG GREY"]],
  [{ key: "mirage-gray", name: "Mirage Gray", hex: "#7c7f7e" }, ["MIRAGE GRAY", "MIRAGE GREY"]],
  [{ key: "steel-gray", name: "Super Steel Gray", hex: "#6a7277" }, ["SUPER STEEL GRAY", "S STEEL GRAY", "STEEL GRAY", "STEEL GREY"]],
  [{ key: "titanium", name: "Titanium", hex: "#7e8285", finish: "metallic" }, ["TITANIUM MATTE METALLIC", "MATTE TITANIUM", "TITANIUM METALLIC", "TITANIUM", "TITANUM", "TITANIU", "TITA", "TIT", "TTNM", "M TTN", "TMM", "T MET"]],
  [{ key: "super-graphite", name: "Super Graphite", hex: "#3b3e41" }, ["MATTE SUPER GRAPHITE", "SUPER GRAPHITE", "SUP GRAPH", "S GPHT", "GRAPHITE", "GRAPHIT", "GRPH", "GPHT"]],
  [{ key: "heavy-metal", name: "Heavy Metal", hex: "#4a4c4f", finish: "metallic" }, ["MATTE HEAVY METAL", "HEAVY METAL", "HEAVY MTL", "HVY MTL", "H M GL", "H MET"]],
  [{ key: "silver", name: "Silver", hex: "#aaaeb2", finish: "metallic" }, ["LIQUID SILVER", "VOGUE SILVER", "TURBO SILVER", "SILVER QUARTZ", "S QUARTZ", "SLVR QUARTZ", "SILVER PEARL", "SILVER", "SLVR", "SILV", "SLV", "SL"]],
  [{ key: "gray", name: "Gray", hex: "#6e7377" }, ["GRAY", "GREY", "GRY"]],

  // Blacks.
  [{ key: "onyx-black", name: "Onyx Black", hex: "#141516" }, ["MATTE ONYX BLACK", "ONYX BLACK", "ONYX", "ONXY", "ONX"]],
  [{ key: "stealth-black", name: "Stealth Black", hex: "#161718", finish: "matte" }, ["STEALTH BLACK", "STEALTH BLK", "STLTH BLK", "S BLK", "STEALTH"]],
  [{ key: "cruiser-black", name: "Cruiser Black", hex: "#17181a" }, ["CRUISER BLACK", "CR BLK"]],
  [{ key: "black-crystal", name: "Black Crystal", hex: "#212226", finish: "metallic" }, ["BLACK CRYSTAL", "BLCK CRYS", "BLKCR"]],
  [{ key: "black-pearl", name: "Black Pearl", hex: "#1c1d21", finish: "pearl" }, ["GLOSS BLACK PEARL", "BLACK PEARL METALLIC", "BLACK PEARL", "BLK PEARL", "BLKPRL", "BL PRL", "BL PL", "BK PL"]],
  [{ key: "black", name: "Black", hex: "#17181a" }, ["GLOSS BLACK", "BLACK", "BLCK", "BLK", "BK", "BLA", "BLAC"]],

  // Whites.
  [{ key: "white-lightning", name: "White Lightning", hex: "#eef0ee" }, ["WHITE LIGHTNING", "WHITE LIGHTING", "W LIGHTNING", "W LTNG", "WHT LTG", "WH LTG", "WHT L", "WT LTNG", "W LT"]],
  [{ key: "bright-white", name: "Bright White", hex: "#f2f3f1" }, ["BRIGHT WHITE"]],
  [{ key: "pearl-white", name: "Pearl White", hex: "#ebe8df", finish: "pearl" }, ["ICY WHITE PEARL", "ICY WHITE", "PEARL WHITE", "WHITE PEARL", "B PEARL", "WHITE PRL", "PRL WH"]],
  [{ key: "ghost-white", name: "Ghost White", hex: "#e5e6e4" }, ["GHOST WHITE", "GST WHT"]],
  [{ key: "matte-white", name: "Matte White", hex: "#dcdcd7", finish: "matte" }, ["MATTE WHITE METALLIC", "MATTE WHITE", "M WHT"]],
  [{ key: "white", name: "White", hex: "#eeeeec" }, ["WHITE", "WHT", "WHI", "WHIT", "WH"]],

  // Greens.
  [{ key: "sage-green", name: "Sage Green", hex: "#4a5439" }, ["FOREST SAGE GREEN", "SAGE GREEN", "SAGE GRN", "SAGE GN", "SAGE", "S GREEN", "S GRN", "SGRN", "S GR", "SG GN"]],
  [{ key: "sagebrush-green", name: "Sagebrush Green", hex: "#6e7a5d" }, ["SAGEBRUSH GREEN", "SAGEBRUSH"]],
  [{ key: "moss-green", name: "Moss Green", hex: "#4c5937" }, ["MOSS GREEN"]],
  [{ key: "army-green", name: "Army Green", hex: "#4a5231" }, ["ARMY GREEN"]],
  [{ key: "treeline-green", name: "Treeline Green", hex: "#3d4e3a" }, ["TREELINE GREEN", "TREELINE GRN", "TREELINE"]],
  [{ key: "cascades-green", name: "Cascades Green", hex: "#3f5547", finish: "matte" }, ["MATTE CASCADES GREEN", "CASCADES GREEN", "C GREEN", "C GN"]],
  [{ key: "spruce", name: "Spruce", hex: "#2d4a3d" }, ["SPRUCE"]],
  [{ key: "shadow-grass", name: "Shadow Grass", hex: "#55573f", camo: "other", finish: "matte" }, ["SHADOW GRASS"]],
  [{ key: "lime-squeeze", name: "Lime Squeeze", hex: "#9acb2d" }, ["LIME SQUEEZE", "LIME SQUEZE", "L LIME", "L LIM", "LIME"]],
  [{ key: "green", name: "Green", hex: "#2f6a3a" }, ["FOREST GREEN", "GREEN", "GRN", "GREE", "GN"]],

  // Browns, tans and sands.
  [{ key: "military-tan", name: "Military Tan", hex: "#9f8b67" }, ["MILITARY TAN", "MATTE MILITARY", "MILTAN"]],
  [{ key: "desert-sand", name: "Desert Sand", hex: "#c1aa83" }, ["DESERT SAND"]],
  [{ key: "sand-dune", name: "Sand Dune", hex: "#c6b18c" }, ["SAND DUNE", "SND DN", "SANDSTONE", "SANDS", "SAND"]],
  [{ key: "mirage-beige", name: "Mirage Beige", hex: "#b9a98c" }, ["MIRAGE BEIGE", "BEIGE"]],
  [{ key: "bronze-mist", name: "Bronze Mist", hex: "#7a6550", finish: "metallic" }, ["BRONZE MIST", "NARA BRONZE", "M NARA", "NARA", "B MIST", "BRONZE", "BRNZ"]],
  [{ key: "bronson-rock", name: "Bronson Rock", hex: "#77706a" }, ["BRONSON ROCK", "BRONSON"]],
  [{ key: "matte-mocha", name: "Matte Mocha", hex: "#5a4535", finish: "matte" }, ["MATTE MOCHA", "MOCHA"]],
  [{ key: "copper", name: "Copper", hex: "#995932", finish: "metallic" }, ["COPPER"]],
  [{ key: "suede", name: "Suede", hex: "#8b7a63", finish: "metallic" }, ["SUEDE"]],
  [{ key: "brown", name: "Brown", hex: "#5b4632" }, ["BROWN", "BRWN"]],
  [{ key: "rust", name: "Rust", hex: "#8a4428" }, ["RUST"]],
  [{ key: "chalk", name: "Chalk", hex: "#d7d8d0" }, ["CHALK GLOSS", "CHALK"]],
  [{ key: "tan", name: "Tan", hex: "#a8936f" }, ["TAN"]],

  // Pinks and purples.
  [{ key: "pink-power", name: "Pink Power", hex: "#e2418a" }, ["PINK POWER", "PINK"]],
  [{ key: "purple", name: "Purple", hex: "#5f3a93" }, ["PURPLE THUNDER", "PURPLE"]],

  // A bare RED last: "RED STICKER" aside, it means a red unit.
  [{ key: "red", name: "Red", hex: "#b3171e" }, ["RED", "RD"]],
];

// Finish words, wherever they are.
const FINISHES: [PaintFinish, RegExp][] = [
  ["matte", /\b(?:MATTE|MATT|MAT|MTT|MT)\b/],
  ["pearl", /\b(?:PEARL|PRL|PEA|PEAR)\b/],
  ["metallic", /\b(?:METALLIC|METALLI|METALL|METALIC|META|MET|MTLC|MTL)\b/],
  ["gloss", /\b(?:GLOSS|GLS|GLO)\b/],
];

// Neutral Polaris-style gray for a unit whose colour isn't known.
export const UNKNOWN_PAINT: UnitPaint = {
  key: "unknown",
  name: "Unknown colour",
  base: "#6b7075",
  accent: null,
  finish: "gloss",
  camo: null,
  known: false,
};

// Words in a description that look like colours but aren't: options and
// markets ("RED STICKER", "W/ STARTER", "BL DSK" is a blade disc, "RD COM"
// Ride Command), and a finish said not to be one ("NON MTLC"). Removed
// before reading.
const NOT_COLOURS = /\b(?:RED STICKER|W ?\/ ?O\b|W ?\/ ?STARTER|W ?\/ ?ES|BL\.? DSK|TRAIL BOSS|ZUG ?\/ ?LOF|S ?\/ ?S|RD\.? ?COM\w*|RIDE ?COMMAND\+?|NON[- ]?(?:MTLC|METALLIC|MET)|N\.? ?MTLC)\b/g;

// Colours run into the next word in the list ("N. BLUEEV": Navy Blue, the
// EVAP version; "GRNBLK": green and black): split apart before reading.
const RUN_TOGETHER: [RegExp, string][] = [
  [/\b(BLUE|BLU|RED|GREEN|GRN|GRAY|GREY|GRY|BLACK|BLK|WHITE|WHT)(EVAP|EVA|EV)\b/g, "$1 $2"],
  [/\b(GRN|GREEN|RED|BLU|BLUE|WHT|WHITE|SLV|GRY|GREY|GRAY|ORG|ORANGE|YLW)(BLK|BLACK|WHT|WHITE)\b/g, "$1 / $2"],
];

type Entry = { colour: Colour; words: string[] };
const ENTRIES: Entry[] = COLOURS.flatMap(([colour, spellings]) => spellings.map((spelling) => ({ colour, words: spelling.split(" ") })));

// Upper case, letters and digits as words; dots, dashes and commas between
// them read as spaces ("S.GREEN", "RGR-24,1K"). Slashes are kept as their
// own word, for two-tones.
function words(text: string): string[] {
  let upper = text.toUpperCase();
  for (const [pattern, replacement] of RUN_TOGETHER) upper = upper.replace(pattern, replacement);
  return upper
    .replace(NOT_COLOURS, " ")
    .replace(/\//g, " / ")
    .split(/[^A-Z0-9/]+/)
    .filter(Boolean);
}

type Found = { colour: Colour; start: number; end: number };

// Words that are a colour by themselves ("BROWN", "SAND"): read as the start
// of a longer one ("BROWNING", "SAND CAMO") only where the list cut the
// description off.
const WHOLE_WORDS = new Set(ENTRIES.filter((entry) => entry.words.length === 1).map((entry) => entry.words[0]));

// The model list cuts descriptions at 40 characters.
const CUT_AT = 38;

// Every colour named in a run of words, longest match first at each spot.
// The run's last word may be cut short: in a description the list cut off,
// any start of a colour's last word when the words before it match whole
// ("STEALTH GR"); otherwise at least three letters of it ("BLUE LAB"), or
// four of a one-word colour ("TITANI").
// A bare two-letter colour ("BL", "RD", "GN"): ambiguous where the list cut
// the description off right after it ("MATTE BL" could be BLUE or BLACK),
// and not taken from a generator's description at all (its "50ST&CAN BL"
// is no colour).
const SHORT_FORMS = new Set(ENTRIES.filter((entry) => entry.words.length === 1 && entry.words[0].length <= 2).map((entry) => entry.words[0]));
const prefixOfOthers = (word: string, key: string) => ENTRIES.some((entry) => entry.colour.key !== key && entry.words.some((w) => w.length > word.length && w.startsWith(word)));

function findColours(list: string[], cut: boolean, { shortForms = true }: { shortForms?: boolean } = {}): Found[] {
  const found: Found[] = [];
  for (let i = 0; i < list.length; ) {
    let best: Found | null = null;
    for (const entry of ENTRIES) {
      const n = entry.words.length;
      if (i + n > list.length) continue;
      if (n === 1 && SHORT_FORMS.has(entry.words[0]) && list[i] === entry.words[0]) {
        if (!shortForms) continue;
        if (cut && i === list.length - 1 && prefixOfOthers(entry.words[0], entry.colour.key)) continue;
      }
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        const word = list[i + k];
        const want = entry.words[k];
        if (word === want) continue;
        const last = i + k === list.length - 1 && k === n - 1;
        const min = n > 1 ? (cut ? 1 : 3) : 4;
        ok = last && (cut || !WHOLE_WORDS.has(word)) && word.length >= min && word.length < want.length && want.startsWith(word);
      }
      if (ok && (!best || n > best.end - best.start)) best = { colour: entry.colour, start: i, end: i + n };
    }
    if (best) {
      found.push(best);
      i = best.end;
    } else i++;
  }
  return found;
}

function finishOf(text: string, colour: Colour): PaintFinish {
  const said = text.replace(NOT_COLOURS, " ");
  for (const [finish, pattern] of FINISHES) if (pattern.test(said)) return finish;
  return colour.finish ?? "gloss";
}

// The paint named in one description, or null. A generator's description
// isn't read for two-letter colours (see SHORT_FORMS).
export function paintFromText(text: string | null | undefined, { generator = false }: { generator?: boolean } = {}): UnitPaint | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  const list = words(upper);
  const found = findColours(list, text.trim().length >= CUT_AT, { shortForms: !generator });
  if (found.length === 0) return null;
  const camo = found.find((item) => item.colour.camo === "pursuit") ?? found.find((item) => item.colour.camo);
  // A two-tone: the colours either side of the first slash with one on each
  // side ("SAGE GRN/BLK", "BRIGHT WHITE/INDY RED", "GREY W LIME").
  const slash = list.findIndex((word, index) => word === "/" && found.some((f) => f.end === index) && found.some((f) => f.start === index + 1));
  let main = found[0];
  let accent: Found | null = null;
  if (slash !== -1) {
    main = found.find((f) => f.end === slash)!;
    accent = found.find((f) => f.start === slash + 1)!;
  } else {
    const withAt = list.findIndex((word, index) => word === "W" && found.some((f) => f.end === index) && found.some((f) => f.start === index + 1));
    if (withAt !== -1) {
      main = found.find((f) => f.end === withAt)!;
      accent = found.find((f) => f.start === withAt + 1)!;
    }
  }
  // Camouflage wins over the colour words around it ("BROWNING PPC LE").
  if (camo && !accent) main = camo;
  if (accent && accent.colour.key === main.colour.key) accent = null;
  const colour = main.colour;
  return {
    key: accent ? `${colour.key}+${accent.colour.key}` : colour.key,
    name: accent ? `${colour.name} / ${accent.colour.name}` : colour.name,
    base: colour.hex,
    accent: accent ? accent.colour.hex : null,
    finish: colour.camo ? "matte" : finishOf(upper, colour),
    camo: colour.camo ?? null,
    known: true,
  };
}

// The unit's paint from the first of its descriptions (then its label) that
// names one; a neutral gray if none does.
export function unitPaint(texts: (string | null | undefined)[], options: { generator?: boolean } = {}): UnitPaint {
  for (const text of texts) {
    const paint = paintFromText(text, options);
    if (paint) return paint;
  }
  return UNKNOWN_PAINT;
}
