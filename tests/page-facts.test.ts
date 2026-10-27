// Reading a manual page once for the part sheet's card: the card has the
// procedure's title, the special tools as the page prints them, and the
// line saying the page has its steps, torque specs and cautions, read from
// the page's own text. On the owner's starter-solenoid page the card has
// the title and that line, no tools; on a page with a PU- tool, the page's
// own line with its part number; on a page with nothing of the kind (a
// wiring diagram), no card. Nothing on it says anything of a torque: every
// way a torque reached the card in earlier checks (a value, a number with
// no unit or in words, a unit as OCR misreads it, wording that hands one
// fastener's value to another, a torque or tightening word, "90 deg",
// digits and letters of other scripts) is dropped from the title, printed
// as a heading or not, and keeps a tool's line off the card (its part
// number shows alone); however the page's text comes out (two columns read
// across, values before their labels, a table row wrapped under its value)
// nothing Claude pairs shows. A card saved in an earlier shape (steps,
// cautions, a torque list, notes) is read without them. Also the request
// itself (the model, no thinking, the strict tool with only a title and
// part numbers, nothing forced) and reading the answer. Pure: no database.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FACTS_LIMITS,
  FACTS_SYSTEM,
  FACTS_TOOL,
  FACTS_TOOL_NAME,
  PAGE_FACTS_MODEL,
  checkFacts,
  factsInReply,
  factsRequest,
  hasFacts,
  numbersOnPage,
  quantities,
  readOnPage,
  specTokens,
  stem,
  torqueOnPage,
  wordsOf,
} from "../src/lib/manual-facts-rules";

// The owner's own page as they gave it: the Ranger XD 1500's starter
// solenoid service, steps 1 to 7 (the figure's callouts ① to ③ in them) and
// four stacked TORQUE boxes, then the page's foot.
const OWNER_STEPS = `CHASSIS / BODY ELECTRICAL
STARTER SOLENOID SERVICE
STARTER SOLENOID REPLACEMENT
1. Raise dump bed.
2. Remove battery access panel.
3. Disconnect battery positive by loosening the terminal.
4. Disconnect starter solenoid electrical connector ①.
5. Remove start solenoid cable nuts ②.
6. Remove starter solenoid by removing fasteners ③.
7. Installation is performed by reversing the removal procedure.`;
const OWNER_BOXES = `TORQUE
Starter Solenoid Fastener:
97 in-lbs (11 N·m)
TORQUE
Starter Solenoid Cable Fastener:
35 in-lbs (4 N·m)
TORQUE
Battery Terminal Fastener (Positive):
106 in-lbs (12 N·m)
TORQUE
Battery Terminal Fastener (Negative):
62 in-lbs (7 N·m)`;
const FOOT = "10.62\n9940020 R01 - 2024 RANGER XD 1500 Service Manual\n© Copyright Polaris Inc.";
const OWNER = `${OWNER_STEPS}\n${OWNER_BOXES}\n${FOOT}`;
// Its steps as an earlier reading recorded them, word for word.
const OWNER_LIST = OWNER_STEPS.split("\n")
  .slice(3)
  .map((line) => ({ n: Number(line[0]), text: line.slice(3) }));
// What Claude records for it.
const OWNER_READING = { title: "STARTER SOLENOID REPLACEMENT", tools: [] };
const OWNER_CARD = { title: "STARTER SOLENOID REPLACEMENT", tools: [], readOnPage: true, torqueOnPage: true };

// The same page scanned and read by OCR: misread letters, other marks for
// the N·m dot, a word and a sentence broken over lines, Ibs for lbs, an l
// for a 1.
const OWNER_OCR = `CHASSIS / BODY ELECTRlCAL
STARTER SOLENOID SERVlCE
STARTER SOLENOID REPLACEMENT
1. Raise dump bed.
2. Remove battery access panel.
3. Disconnect battery positive by
loosening the terminal.
4. Disconnect starter sole-
noid electrical connector ①.
5. Remove start solenoid cable nuts ②.
6. Remove starter solenoid by removing fasteners ③.
7. lnstallation is performed by reversing the rernoval procedure.
TORQUE
Starter Solenoid Fastener:
97 in-Ibs (11 N•m)
TORQUE
Starter Solenoid Cable Fastener:
35 in-1bs (4 N-rn)
TORQUE
Battery Terminal Fastener (Positive):
l06 in-lbs (12 N m)
TORQUE
Battery Terminal Fastener (Negative):
62 in-lbs (7 Nm)`;

// A test page with no torque spec on it, a CAUTION and a PU- tool.
const STATOR = `CHARGING SYSTEM
STATOR TEST
CAUTION: Turn the key OFF before you unplug the stator connector.
Use Digital Multimeter PU-50638.
1. Disconnect the stator connector.
2. Measure the resistance across the stator leads, 0.2 to 0.4 ohms.
3. Measure the resistance between pins 1 and 2: 0.2 to 0.4 ohms.
4. Check each pin to ground for continuity.
5. Replace the stator if a reading is out of range.`;
const STATOR_READING = { title: "STATOR TEST", tools: ["Digital Multimeter PU-50638"] };

// A page with nothing the card points to: a wiring diagram's labels.
const WIRING = "STARTING SYSTEM WIRING DIAGRAM\nRD/WH\nBK\nStarter Solenoid\nBattery\nKey Switch\nECU\n10.60";

// What a reading keeps, with nothing else in it.
const kept = (input: Record<string, unknown>, page: string) => {
  const { facts, dropped } = checkFacts({ title: "", tools: [], ...input }, page);
  return { ...facts, dropped };
};
// The titles an entry gets on the card: Claude giving it as the title, the
// page not printing it, and the page printing it word for word as a line
// of its own (in capitals too, but where that would change what it says:
// "Il" for 11 isn't "IL").
function titles(entry: string, page: string, capitals = true) {
  const heading = entry.replace(/[.:]$/, "");
  const printed = [heading, ...(capitals ? [heading.toUpperCase()] : [])].map((title) => kept({ title }, `${page}\n${title}`).title);
  return [kept({ title: entry }, page).title, ...printed].filter(Boolean);
}
// The tools an entry gets on the card when the page prints it on the line
// with a tool's part number (after it, and before it), and Claude names
// that tool.
function toolLines(entry: string, page: string) {
  return [`${entry} PU-50964`, `Use PU-50964. ${entry}`].flatMap((line) => kept({ tools: ["Battery Terminal Wrench PU-50964"] }, `${page}\n${line}`).tools);
}

describe("comparing specs", () => {
  test("units are spelled one way, and N·m's dot and its stand-ins don't matter", () => {
    for (const written of ["97 in-lbs (11 N·m)", "97 in. lbs. (11 Nm)", "97 inch-pounds (11 N-m)", "97 lb-in (11 N m)", "97 IN-LBS (11 N•M)", "97 in-Ibs (11 N∙m)"]) {
      assert.deepEqual(specTokens(written), ["97", "inlb", "11", "nm"], written);
    }
    assert.deepEqual(specTokens("18 ft-lbs (24 N·m)"), ["18", "ftlb", "24", "nm"]);
    assert.deepEqual(specTokens("18 lb-ft"), ["18", "ftlb"]);
    assert.deepEqual(specTokens("9.5 to 10.5 kΩ"), ["9.5|10.5", "kohm"]);
    // Rarer torque units, each one spelling.
    assert.deepEqual(specTokens("5 kgm 5 kg·m 5 m·kg 6 kN·m 6 cNm 6 N·cm 35 in-oz 35 oz-in"), ["5", "kgfm", "5", "kgfm", "5", "kgfm", "6", "knm", "6", "ncm", "6", "ncm", "35", "inoz", "35", "inoz"]);
  });

  test("OCR's slips in a unit are read as the unit", () => {
    for (const [written, unit] of [
      ["35 in-1bs", "inlb"],
      ["35 in-|bs", "inlb"],
      ["35 ft-lb5", "ftlb"],
      ["35 1n-lbs", "inlb"],
      ["35 ins-lbs", "inlb"],
      ["35 in#", "inlb"],
      ["35 N-rn", "nm"],
      ["35 Nrn", "nm"],
    ]) {
      assert.deepEqual(specTokens(written), ["35", unit], written);
    }
  });

  test("a range is one token, so a value inside it never matches", () => {
    assert.deepEqual(specTokens("6-8 ft-lbs"), ["6|8", "ftlb"]);
    assert.deepEqual(specTokens("0.6 to 0.8 ohms"), ["0.6|0.8", "ohm"]);
    assert.ok(numbersOnPage("0.6-0.8 ohms", specTokens("Resistance: 0.6-0.8 ohms")));
    assert.ok(!numbersOnPage("0.8 ohms", specTokens("Resistance: 0.6-0.8 ohms")));
    // Two numbers with only a space between them are two numbers.
    assert.deepEqual(specTokens("M8 25 N·m"), ["m", "8", "25", "nm"]);
  });

  test("OCR's letters for digits are read as digits, but not a litre's L", () => {
    assert.deepEqual(specTokens("l06 in-lbs"), ["106", "inlb"]);
    assert.deepEqual(specTokens("1O6 in-lbs"), ["106", "inlb"]);
    assert.deepEqual(specTokens("I06 in-lbs"), ["106", "inlb"]);
    assert.deepEqual(specTokens("oil 2.5l"), ["oil", "2.5", "l"]);
    assert.deepEqual(specTokens("1l of oil"), ["1", "l", "of", "oil"]);
    // Before a torque unit an L is OCR's 1.
    assert.deepEqual(specTokens("97 in-lbs (1l N·m)"), ["97", "inlb", "11", "nm"]);
    // Words with those letters stay words.
    assert.deepEqual(specTokens("coil oil lid"), ["coil", "oil", "lid"]);
  });

  test("quantities: each number with the units right after it", () => {
    assert.deepEqual(quantities(specTokens("97 in-lbs (11 N·m)")), [["97", "inlb"], ["11", "nm"]]);
    assert.deepEqual(quantities(specTokens("0.6 to 0.8 ohms at 20 C")), [["0.6|0.8", "ohm"], ["20"]]);
  });

  test("a number has to be the page's number, not part of a bigger one or a decimal, with the same units", () => {
    const page = specTokens(STATOR);
    assert.ok(numbersOnPage("0.2 to 0.4 ohms", page));
    assert.ok(!numbersOnPage("0.2 to 0.5 ohms", page));
    assert.ok(!numbersOnPage("0.4 ohms", page), "inside the range");
    assert.ok(!numbersOnPage("0.2 to 0.4 V", page), "the wrong unit");
    assert.ok(numbersOnPage("pin 3", page), "a step's number is on the page");
    assert.ok(!numbersOnPage("pins 1 and 7", page));
    assert.ok(numbersOnPage("no numbers at all", page));
  });

  test("a number given in two units has to be given so on the page, as one spec", () => {
    const page = specTokens("Fuel pressure, engine running: 58 psi (400 kPa). Engine off: 43 psi (296 kPa).");
    assert.ok(numbersOnPage("58 psi (400 kPa)", page));
    assert.ok(numbersOnPage("400 kPa (58 psi)", page));
    assert.ok(!numbersOnPage("58 psi (296 kPa)", page));
  });

  test("words: lower case, small ones out, a light stem the same on both sides", () => {
    assert.deepEqual(wordsOf("Disconnect the battery CABLES"), wordsOf("disconnect battery cable"));
    assert.equal(stem("removed"), stem("remove"));
    assert.equal(stem("batteries"), stem("battery"));
    assert.equal(stem("switches"), stem("switch"));
    assert.equal(stem("springs"), stem("spring"));
    assert.equal(stem("speed"), "speed");
    assert.equal(stem("chassis"), "chassis");
    // A word broken over a line is one word.
    assert.ok(wordsOf("starter sole-\nnoid").includes(stem("solenoid")));
  });
});

describe("the owner's page", () => {
  test("the title and the line saying the page has its steps, torque specs and cautions; no tools", () => {
    const { facts, dropped } = checkFacts(OWNER_READING, OWNER);
    assert.equal(dropped, 0);
    assert.deepEqual(facts, OWNER_CARD);
    assert.ok(hasFacts(facts));
    // Nothing of the TORQUE boxes or the steps is on the card.
    assert.doesNotMatch(JSON.stringify(facts), /97|35|106|62|in-lbs|N·m|torque\b|Raise|Remove|Disconnect/i);
  });

  test("the title is a heading the page prints, word for word but for case and spaces: the service heading too", () => {
    for (const title of ["STARTER SOLENOID REPLACEMENT", "STARTER SOLENOID SERVICE", "Starter Solenoid Replacement", "STARTER  SOLENOID   REPLACEMENT", "CHASSIS / BODY ELECTRICAL"]) {
      assert.equal(kept({ title }, OWNER).title, title.replace(/\s+/g, " "), title);
    }
    for (const title of [
      "STARTER SOLENOID REMOVAL",
      "SOLENOID REPLACEMENT",
      "STARTER SOLENOID REPLACEMENT PROCEDURE",
      "STARTER SOLENOID - REPLACEMENT",
      "Raise dump bed.",
      "Raise dump bed",
      "Starter Solenoid Fastener",
      "Starter Solenoid Fastener:",
      "TORQUE",
      "2024 RANGER XD 1500 Service Manual",
    ]) {
      const result = kept({ title }, OWNER);
      assert.deepEqual([result.title, result.dropped], ["", 1], title);
    }
  });

  test("the same page from OCR: the same card", () => {
    const { facts, dropped } = checkFacts(OWNER_READING, OWNER_OCR);
    assert.deepEqual([facts, dropped], [OWNER_CARD, 0]);
    // Its own misread heading is printed as it is: Claude's reading of it isn't.
    assert.equal(kept({ title: "STARTER SOLENOID SERVICE" }, OWNER_OCR).title, "");
    assert.equal(kept({ title: "STARTER SOLENOID SERVlCE" }, OWNER_OCR).title, "STARTER SOLENOID SERVlCE");
  });

  test("whatever else Claude sends (steps, cautions, torques, notes, its own line for the torque specs) never reaches the card", () => {
    const reading = {
      ...OWNER_READING,
      steps: [...OWNER_LIST, { n: 8, text: "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m)." }],
      cautions: ["Starter Solenoid Cable Fastener: as for the Starter Solenoid Fastener."],
      torques: [{ item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }],
      notes: ["Cable nuts: 35 in-lbs (4 N·m)."],
      readOnPage: false,
      torqueOnPage: false,
    };
    assert.deepEqual(checkFacts(reading, OWNER), { facts: OWNER_CARD, dropped: 0 });
  });
});

// Every way a torque could reach the card in the earlier checks, written
// as Claude might put it, or as a page's text might come out: those with a
// value, a number of any kind or a torque word, and those that hand one
// fastener's value to another in words or marks.
const VALUES = {
  "a torque value, the right one too": [
    "Torque the cable fastener to 97 in-lbs (11 N·m).",
    "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m).",
    "Starter Solenoid Fastener: 97 in-lbs (11 N·m)",
    "Starter Solenoid Cable Fastener 35 in-lbs (4 N·m)",
    "Battery terminal fastener (negative) 62 in-lbs",
    "Starter solenoid fastener socket, 11 N·m",
  ],
  "a number with no unit, or what isn't one": [
    "Cable fastener: 97",
    "Starter solenoid fastener 35",
    "Cable fastener = 97",
    "Battery terminal fastener (negative): 106",
    "Starter Solenoid Fastener: 35 (4)",
    "Starter Solenoid Fastener (35)",
    "Starter solenoid fastener: 35 in.",
    "Starter solenoid fastener: 35 ft.",
    "Cable fastener: 11 Nmm",
    "Cable fastener: 97 in-tbs",
    "Starter Solenoid Fastener: 5 pounds",
  ],
  "a number in words": [
    "Starter Solenoid Cable Fastener: ninety-seven",
    "Starter Solenoid Fastener: thirty-five",
    "Battery Terminal Fastener (Negative): one hundred six",
    "Install the battery terminal fastener (positive) at sixty-two.",
    "Battery terminal fastener (positive): sixty two, not more.",
    "Turn the cable nuts a further quarter turn.",
  ],
  "a unit as OCR misreads it, or one rarely used": [
    "Starter Solenoid Fastener: 97 in-1bs (11 N-rn)",
    "Starter Solenoid Fastener: 35 in-|bs",
    "Starter Solenoid Fastener: 35 ft-lb5",
    "Starter Solenoid Fastener: 35 1n-lbs",
    "Starter Solenoid Fastener: 35 ins-lbs",
    "Starter Solenoid Fastener: 35 in#",
    "Starter Solenoid Fastener: 35 pound-inches",
    "Starter Solenoid Fastener: 35 in-oz",
    "Starter Solenoid Fastener: 4 Nrn",
    "Starter Solenoid Fastener: 5 kgm",
    "Starter Solenoid Fastener: 6 kN·m",
    "Battery terminal fastener (positive): 6 cNm",
    "Starter Solenoid Fastener: 1l N·m",
  ],
  "words for torquing or tightening, with no number": [
    "Torque the starter solenoid cable fasteners to specification.",
    "Torque the cable fastener to the starter solenoid fastener's.",
    "Retorque the battery terminal fasteners.",
    "Re-torque the battery terminal fasteners.",
    "Tighten the battery terminal securely.",
    "Install the cable nuts hand-tight.",
    "Snug the starter solenoid fasteners.",
    "Install the torqued starter solenoid fasteners.",
    "Do not overtighten the battery terminal nuts.",
    "Overtightening may damage the solenoid terminal.",
    "Overtorquing will strip the solenoid threads.",
    "Retighten the battery terminal nuts.",
    "Pretorque the solenoid fasteners ③.",
    "Do not overtorque starter solenoid cable fastener.",
    "Untorqued starter solenoid cable fastener.",
    "Detorque starter solenoid cable fastener.",
    "Battery terminal fastener (positive) firmly.",
    "Starter solenoid cable fastener: secure.",
    "Cinch starter solenoid cable fastener.",
    "Tighten the wheel nuts to specs.",
    "CYLINDER HEAD RETIGHTENING",
    "OVERTORQUE PROTECTION",
  ],
  "a torque's angle": ["Turn head bolts an additional 90 deg.", "Turn head bolts an additional 90°.", "Starter solenoid fastener plus 90 degrees"],
  "digits and letters of another script, or letters for a number": [
    "Starter Solenoid Fastener ٩٧",
    "Starter Solenoid Fastener ९७",
    "Starter Solenoid Fastener ９７",
    "Starter Solenoid Fastener ⁹⁷",
    "Starter Solenoid Cable Fastener Ⅻ",
    "Starter Solenoid Cable Fastener thirtyfive",
    "Starter Solenoid Fastener ninetyseven",
    "Starter Solenoid Fastener: ll",
    "Starter Solenoid Fastener Il",
    "Starter Solenoid Fastener lO",
    "Tоrque the starter solenoid cable fastener.",
    "Tor​que the starter solenoid cable fastener.",
    "Tor­que the starter solenoid cable fastener.",
    "Starter Solenoid Fastener 9​7",
  ],
};
const HAND_ONS = {
  "wording that hands one fastener's value to another": [
    "Starter Solenoid Cable Fastener: as for the Starter Solenoid Fastener.",
    "Starter Solenoid Cable Fastener: as with the starter solenoid fastener.",
    "Starter solenoid cable fasteners as per starter solenoid fastener.",
    "Starter solenoid cable fastener: like the starter solenoid fastener.",
    "Starter Solenoid Cable Fastener: as Starter Solenoid Fastener",
    "Use the same on the starter solenoid cable fasteners.",
    "Battery terminal fastener (negative): equal to the positive.",
    "Battery terminal fasteners (positive and negative) are identical.",
    "Starter solenoid cable fastener: matching the starter solenoid fastener.",
    "Starter solenoid cable fastener likewise.",
    "Repeat for the starter solenoid cable fasteners.",
    "Also use it on the starter solenoid cable fastener.",
    "Use the starter solenoid fastener spec on the cable fastener.",
    "Starter solenoid cable fastener: see the starter solenoid fastener specification.",
    "Install the cable nuts using the starter solenoid fastener value.",
    "Install the negative terminal fastener at the positive terminal fastener's setting.",
    "Install the negative terminal fastener following the positive terminal fastener.",
    "Battery terminal fasteners: positive and negative both as positive.",
    "Starter solenoid cable fastener: refer to the starter solenoid fastener.",
    "The starter solenoid cable fastener too.",
    "This applies to the starter solenoid cable nuts.",
  ],
  "a hand-on in words the earlier list didn't have": [
    "Starter Solenoid Cable Fastener: use Starter Solenoid Fastener",
    "For the starter solenoid cable fastener use the starter solenoid fastener's",
    "Starter Solenoid Cable Fastener: not different from Starter Solenoid Fastener",
    "Starter Solenoid Cable Fastener unchanged from Starter Solenoid Fastener",
    "Starter Solenoid Fastener and Starter Solenoid Cable Fastener alike",
    "Both Battery Terminal Fasteners (Positive, Negative): Battery Terminal Fastener (Positive)",
    "Starter Solenoid Cable Fastener takes Starter Solenoid Fastener's",
    "Starter Solenoid Cable Fastener shares Starter Solenoid Fastener's",
    "Battery Terminal Fastener (Negative) mirrors Battery Terminal Fastener (Positive)",
    "Battery Terminal Fastener (Negative): copy Battery Terminal Fastener (Positive)",
    "Battery Terminal Fastener (Negative) twin of Battery Terminal Fastener (Positive)",
    "Starter Solenoid Cable Fastener: previous fastener",
    "Starter Solenoid Cable Fastener: Starter Solenoid Fastener above",
    "Starter Solenoid Cable Fastener: Starter Solenoid Fastener again",
    "Starter Solenoid Cable Fastener: selfsame Starter Solenoid Fastener",
    "Starter Solenoid Cable Fastener interchangeable with Starter Solenoid Fastener",
    "Starter Solenoid Fastener, Starter Solenoid Cable Fastener: common",
    "Starter Solenoid Fastener, Starter Solenoid Cable Fastener: uniform",
    "Battery Terminal Fastener (Positive): double the Starter Solenoid Cable Fastener",
    "Battery Terminal Fastener (Positive): twice the Starter Solenoid Cable Fastener",
    "Starter solenoid cable nuts: starter solenoid fastener figure",
    "Starter solenoid cable nuts: starter solenoid fastener number",
    "Starter solenoid cable nuts: starter solenoid fastener amount",
    "Starter solenoid cable nuts: starter solenoid fastener reading",
    "Starter Solenoid Cable Fastener: idem",
    "Starter Solenoid Cable Fastener: do.",
    "Starter Solenoid Cable Fastener id.",
    "Starter solenoid cable fastener as the starter solenoid fastener",
    "Install cable nuts ②, then solenoid fasteners ③, in kind.",
    "Battery terminal fasteners: no more than shown.",
    "Battery terminal fasteners must not exceed the figure in the box.",
    "Battery Terminal Fastener (Negative) less than Battery Terminal Fastener (Positive)",
  ],
  "a mark or a shape that hands one on": [
    "Starter Solenoid Cable Fastener = Starter Solenoid Fastener",
    "Starter Solenoid Cable Fastener → Starter Solenoid Fastener",
    "Starter Solenoid Cable Fastener: 〃",
    'Battery Terminal Fastener (Negative): " "',
    "Battery Terminal Fastener (Negative) ''",
    "Starter Solenoid Cable Fastener: Starter Solenoid Fastener",
    "Battery Terminal Fastener (Negative): Battery Terminal Fastener (Positive)'s",
    "Starter Solenoid Cable Fastener Starter Solenoid",
    "Cable Fastener (Solenoid Fastener)",
    "Cable Fastener - Solenoid",
    "Cable nuts ② = solenoid fasteners ③.",
    "Install the cable nuts ② the way the solenoid fasteners ③ were installed.",
    "Negative terminal fastener: use positive terminal fastener figure.",
    "Cable Fastener sa-me Solenoid",
    "Starter Solenoid Fastener n i n e t y s e v e n",
    "Remove starter solenoid by removing fasteners ③①.",
    "Starter Solenoid Cable Fastener sаme Starter Solenoid Fastener",
    "Starter Solenoid Cable Fastener = s​ame Starter Solenoid Fastener",
  ],
};
// Words that are only Claude's: what the page prints as its own word is
// its own ("XXXV" in a part's name), but these the owner's page doesn't.
const CLAUDES_WORDS = ["Starter Solenoid Cable Fastener XXXV", "Starter Solenoid Fastener IV", "Starter Solenoid Cable Fastener treintaicinco", "Cable Fastener sa me Solenoid", "Battery Terminal Fastener (Negative) (Positive)"];

describe("nothing on the card says anything of a torque", () => {
  for (const [kind, entries] of Object.entries({ ...VALUES, ...HAND_ONS })) {
    test(`${kind}: never the title, the page printing it as a heading or not`, () => {
      for (const entry of entries) {
        for (const page of [OWNER, OWNER_OCR, STATOR]) assert.deepEqual(titles(entry, page, !kind.startsWith("digits and letters")), [], entry);
        assert.equal(kept({ title: entry }, OWNER).dropped, 1, entry);
      }
    });
  }

  for (const [kind, entries] of Object.entries(VALUES)) {
    test(`${kind}: on a tool's line, the line never shows, only the tool's part number`, () => {
      for (const entry of entries) {
        for (const page of [OWNER, OWNER_OCR, STATOR]) assert.deepEqual(toolLines(entry, page), ["PU-50964", "PU-50964"], entry);
      }
    });
  }

  test("words only Claude writes: never the title", () => {
    for (const entry of CLAUDES_WORDS) {
      for (const page of [OWNER, OWNER_OCR]) assert.deepEqual(kept({ title: entry }, page).title, "", entry);
    }
  });

  test("however the page's text comes out (two columns read across, values before their labels, a row wrapped under its value), what Claude pairs never reaches the card", () => {
    const pages = {
      "two columns read across": `CHASSIS / BODY ELECTRICAL
STARTER SOLENOID REPLACEMENT
1. Raise dump bed.
2. Remove battery access panel. TORQUE
3. Disconnect the battery Battery Terminal Fastener (Negative):
positive cable 62 in-lbs (7 N·m)
by loosening the terminal.
4. Disconnect starter solenoid electrical connector. TORQUE
5. Remove the start Starter Solenoid Fastener:
solenoid cable nuts 97 in-lbs (11 N·m)
${FOOT}`,
      "values before their labels": `${OWNER_STEPS.replace("procedure.", "procedure. 97 in-lbs (11 N·m)")}
Starter Solenoid Fastener:
35 in-lbs (4 N·m)
Starter Solenoid Cable Fastener:
106 in-lbs (12 N·m)
Battery Terminal Fastener (Positive):
62 in-lbs (7 N·m)
Battery Terminal Fastener (Negative): 10.62`,
      "a table row wrapped under its value": `${OWNER_STEPS}\nTORQUE SPECIFICATIONS\nStarter 97 in-lbs (11 N·m)\nSolenoid Fastener\nStarter 35 in-lbs (4 N·m)\nSolenoid Cable Fastener`,
      "units only in the table's heading": `${OWNER_STEPS}\nFASTENER IN-LBS N·M\nStarter Solenoid Fastener 97 11\nStarter Solenoid Cable Fastener 35 4`,
      "a value whose unit OCR lost": `${OWNER_STEPS}\nTORQUE\nStarter Solenoid Fastener:\n97\nTORQUE\nStarter Solenoid Cable Fastener:\n35 in-lbs (4 N·m)`,
      "a value broken over two lines": `${OWNER_STEPS}\nTORQUE\nStarter Solenoid Fastener: 97\nin-lbs (11 N·m)`,
      "a tool beside a TORQUE box": `${OWNER_STEPS}\nUse Battery Terminal Wrench PU-50964 Starter Solenoid Fastener:\nWrench Kit PU-50965 97 in-lbs (11 N·m)\n${FOOT}`,
    };
    const paired = [
      "Positive cable: 62 in-lbs (7 N·m)",
      "Remove the start solenoid cable nuts 97 in-lbs (11 N·m).",
      "Starter Solenoid Fastener: 35 in-lbs (4 N·m)",
      "Starter Solenoid Cable Fastener: 106",
      "Starter Solenoid Fastener 97",
      "Starter Solenoid Cable Fastener 97 11",
      "Solenoid Fastener 35",
      "Wrench Kit PU-50965 97 in-lbs (11 N·m)",
    ];
    for (const [name, page] of Object.entries(pages)) {
      for (const title of [...paired, ...page.split("\n")]) {
        const result = kept({ title, tools: [...paired, "PU-50964", "PU-50965"] }, page);
        assert.doesNotMatch(JSON.stringify([result.title, result.tools]), /\b(?:97|35|106|62|11|12|7|4)\b|lbs|N·m|torque/i, `${name}: ${title}`);
        assert.ok(result.readOnPage && result.torqueOnPage, name);
      }
    }
    // The tool beside the TORQUE box: its line, which has no value; the
    // other's line has one, so its part number alone.
    assert.deepEqual(kept({ tools: ["PU-50964", "PU-50965"] }, pages["a tool beside a TORQUE box"]).tools, ["Use Battery Terminal Wrench PU-50964 Starter Solenoid Fastener:", "PU-50965"]);
  });
});

describe("special tools", () => {
  test("a page with a PU- tool: the page's own line with it, whatever Claude calls it; the card has the title and the line saying the page has steps and cautions", () => {
    const { facts, dropped } = checkFacts(STATOR_READING, STATOR);
    assert.deepEqual(facts, { title: "STATOR TEST", tools: ["Use Digital Multimeter PU-50638."], readOnPage: true, torqueOnPage: false });
    assert.equal(dropped, 0);
    assert.ok(hasFacts(facts));
    for (const said of ["PU-50638", "pu-50638", "Multimeter (PU‐50638)", "A meter, PU-50638", "Use Digital Multimeter PU-50638."]) {
      assert.deepEqual(kept({ tools: [said] }, STATOR).tools, ["Use Digital Multimeter PU-50638."], said);
    }
    // A tool alone on a page with nothing else to point to is a card.
    const page = "SPECIAL TOOLS\nClutch Holding Fixture PU-50503";
    assert.ok(!readOnPage(page));
    assert.deepEqual(kept({ tools: ["PU-50503"] }, page), { title: "", tools: ["Clutch Holding Fixture PU-50503"], readOnPage: false, torqueOnPage: false, dropped: 0 });
    assert.ok(hasFacts(kept({ tools: ["PU-50503"] }, page)));
  });

  test("a part number the page doesn't print exactly, or a tool with none, isn't shown, and is counted", () => {
    for (const said of ["Digital Multimeter PU-50639", "Digital Multimeter PU 50638", "Digital Multimeter PU-5063", "Digital Multimeter", "PU-50638-A"]) {
      const result = kept({ tools: [said] }, STATOR);
      assert.deepEqual([result.tools, result.dropped], [[], 1], said);
    }
    // OCR's misread number on the page isn't the number Claude puts right.
    assert.deepEqual(kept({ tools: ["PU-50638"] }, STATOR.replace("PU-50638", "PU-5O638")).tools, []);
  });

  test("a step's number at the start of the line is taken off; a line with any other number, a callout or a torque word shows its part number alone", () => {
    const page = `CLUTCHING
DRIVE BELT REMOVAL
4. Thread the Driven Clutch Spreader Tool PU-50658 into the
threaded hole in the driven clutch.
Install Clutch Holder PU-50503 ①.
Install the Clutch Holding Fixture PU-50612 and torque the retaining bolt.
Use two Clutch Pullers PU-50700.
Clutch Puller PU-50701 for 2019 and later
TORQUE
PVT Outer Cover Fasteners:
45 in-lbs (5 N·m)`;
    assert.deepEqual(kept({ tools: ["PU-50658", "PU-50503", "PU-50612", "PU-50700", "PU-50701"] }, page).tools, [
      "Thread the Driven Clutch Spreader Tool PU-50658 into the",
      "PU-50503",
      "PU-50612",
      "PU-50700",
      "PU-50701",
    ]);
  });

  test("the first line with the part number that can be shown; each line once, however many of its numbers Claude names; at most ten", () => {
    const page = `FUEL SYSTEM\nFUEL PRESSURE TEST\nPU-43506-A 58 psi\nConnect Fuel Pressure Gauge Kit PU-43506-A or Adapter PU-43506-5 at the fuel rail.\nFuel Pressure Gauge Kit\nPU-43506-A`;
    assert.deepEqual(kept({ tools: ["Fuel Pressure Gauge Kit PU-43506-A", "Adapter PU-43506-5", "Gauge kit PU-43506-A (adapter PU-43506-5)"] }, page).tools, [
      "Connect Fuel Pressure Gauge Kit PU-43506-A or Adapter PU-43506-5 at the fuel rail.",
    ]);
    // A part number whose only line is itself.
    assert.deepEqual(kept({ tools: ["PU-43506-A"] }, "FUEL PUMP\nFuel Pressure Gauge Kit\nPU-43506-A").tools, ["PU-43506-A"]);
    const many = Array.from({ length: 14 }, (_, i) => `Use Tool PU-5${String(i).padStart(4, "0")}`);
    assert.equal(kept({ tools: many.map((line) => line.slice(4)) }, `SPECIAL TOOLS\n${many.join("\n")}`).tools.length, FACTS_LIMITS.tools);
  });

  test("a line too long for the card shows the part number alone", () => {
    const long = `Use the Clutch Puller PU-50612 ${"to pull the drive clutch off the crankshaft taper without damaging the sheaves ".repeat(5)}`;
    assert.ok(long.length > FACTS_LIMITS.text);
    assert.deepEqual(kept({ tools: ["PU-50612"] }, `CLUTCH\n${long}`).tools, ["PU-50612"]);
  });
});

describe("what the card points to on the page", () => {
  test("numbered steps, torque specs or a WARNING, CAUTION or NOTICE: the line; none of them: no line", () => {
    for (const page of [
      OWNER,
      OWNER_OCR,
      OWNER_STEPS,
      STATOR,
      "BATTERY\n1. Remove the seat.",
      "BATTERY\n2) Remove the seat.",
      "WARNING\nBattery acid is corrosive.",
      "Battery acid is corrosive. Always wear eye protection (see CAUTION).",
      "WARNlNG: Battery acid is corrosive.",
      "CAUTl0N: Hot surface.",
      "NOTICE: Do not use cleaning solvents on the drive belt.",
      "DANGER: Explosive gases.",
      "Install the front wheel and tighten the wheel nuts to specification.",
      "Install the front wheel and tighten the wheel nuts to\nspecification.",
      "Tighten the nuts to specs.",
      "TORQUE\nAxle Nut:",
    ]) {
      assert.ok(readOnPage(page), page);
    }
    for (const page of [WIRING, "BATTERY SERVICE . . . . 10.40\nSTARTER SOLENOID SERVICE . . . . 10.62", "Fuel pressure: 58 psi (400 kPa)", "10.62\n9940020 R01 - 2024 RANGER XD 1500 Service Manual", "Coil resistance 0.6-0.8 ohms", "SPECIAL TOOLS\nClutch Holding Fixture PU-50503"]) {
      assert.ok(!readOnPage(page), page);
    }
  });

  test("a page with nothing the card shows (a wiring diagram, a contents page): no card, its title alone isn't anything", () => {
    assert.ok(!hasFacts(kept({ title: "STARTING SYSTEM WIRING DIAGRAM" }, WIRING)));
    assert.equal(kept({ title: "STARTING SYSTEM WIRING DIAGRAM" }, WIRING).title, "STARTING SYSTEM WIRING DIAGRAM");
    assert.ok(!hasFacts(kept({ title: "", tools: [] }, "BATTERY SERVICE . . . . 10.40\nSTARTER SOLENOID SERVICE . . . . 10.62")));
    // With a page that has them, a title alone is a card: the line goes with it.
    assert.ok(hasFacts(kept({ title: "" }, OWNER)));
  });

  test("which pages have torque specs: the word TORQUE as OCR reads it, a torque unit in any spelling, with or without a number, or \"to specification\"", () => {
    for (const page of [OWNER, OWNER_OCR, "T0RQUE\nCable Nut:", "TOROUE SPECIFICATIONS", "Tighten the axle nut to 110 ft-lbs (149 N·m).", "Axle nut 110 ft-1bs", "Cable nut 4 N-rn", "Cable nut 35 in#", "FASTENER FT-LBS N·M\nAxle Nut 110 149", "Install the wheel and tighten the nuts to specification."]) {
      assert.ok(torqueOnPage(page), page);
    }
    for (const page of [STATOR, OWNER_STEPS, WIRING, "BATTERY SERVICE . . . . 10.40\nSTARTER SOLENOID SERVICE . . . . 10.62", "Fuel pressure: 58 psi (400 kPa)", "Torx T25 screwdriver", "See the specifications table."]) {
      assert.ok(!torqueOnPage(page), page);
    }
  });

  test("TORQUE and its units as OCR garbles them past the tokeniser are still seen, and a number beside a label never shows", () => {
    const headings = ["TORQUE", "TOROUE", "T0RQUE", "TORGUE", "TORQIJE", "TORQLJE", "TCRQUE", "TQRQUE", "IORQUE", "T ORQUE", "TOR QUE", "TORQ UE", "T O R Q U E", "TOR-\nQUE", "ТORQUE", ""];
    const values = ["97 in-lbs (11 N·m)", "97 in-Ihs (11 N·rri)", "97 in-lhs (11 Ν·m)", "97 ln-Ihs (11 Hm)", "97 in-Ihs (11 N·in)", "97 in-Ihs (11 Nin)", "97 in-Ilbs (11 N m)", "97 in-Ib (11 N-n)"];
    for (const heading of headings) {
      for (const value of values) {
        const page = `${OWNER_STEPS}\n${heading}\nStarter Solenoid Fastener:\n${value}\n${FOOT}`;
        assert.ok(torqueOnPage(page) && readOnPage(page), `${heading} | ${value}`);
        const result = kept({ title: "Starter Solenoid Fastener 97", tools: ["Starter Solenoid Fastener: 97"] }, `${page}\nStarter Solenoid Fastener 97`);
        assert.deepEqual([result.title, result.tools], ["", []], `${heading} | ${value}`);
      }
      if (heading) assert.ok(torqueOnPage(`${OWNER_STEPS}\n${heading}\nStarter Solenoid Fastener:\n97\n${FOOT}`), heading);
    }
    for (const value of ["8 pound-force feet", "8 lb·ft", "1.1 kg-rn", "11 Nem", "97 in-Ihs", "110 kgf-cm"]) {
      assert.ok(torqueOnPage(`${OWNER_STEPS}\nStarter Solenoid Fastener: ${value}\n${FOOT}`), value);
    }
  });

  test("a title on a page without torque specs: a number only as the page prints it, in a unit that isn't a torque's; a part number only there", () => {
    const page = `${STATOR}\nSTATOR OUTPUT 12 V\nSTATOR TEST 13\nSTATOR TEST PU-50638`;
    assert.equal(kept({ title: "STATOR OUTPUT 12 V" }, page).title, "STATOR OUTPUT 12 V");
    assert.equal(kept({ title: "STATOR TEST 13" }, page).title, "");
    assert.equal(kept({ title: "STATOR TEST PU-50638" }, page).title, "STATOR TEST PU-50638");
    // The same on a page with torque specs: no number, no part number.
    const torqued = `${page}\nTORQUE\nStator Bolts:\n8 ft-lbs (11 N·m)`;
    assert.deepEqual([kept({ title: "STATOR OUTPUT 12 V" }, torqued).title, kept({ title: "STATOR TEST PU-50638" }, torqued).title, kept({ title: "STATOR TEST" }, torqued).title], ["", "", "STATOR TEST"]);
  });
});

describe("checking a reading against the page", () => {
  test("a card saved in an earlier shape: its steps, cautions, torque list, notes and lines are left out, its tools shown as the page prints them, read again the same card", () => {
    const old = {
      title: "STARTER SOLENOID REPLACEMENT",
      steps: [...OWNER_LIST, { n: 8, text: "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m)." }],
      torques: [{ item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }],
      tools: [],
      cautions: [],
      notes: ["Starter Solenoid Cable Fastener: 35 in-lbs (4 N·m)"],
      moreTorques: false,
    };
    const { facts, dropped } = checkFacts(old, OWNER);
    assert.deepEqual([facts, dropped], [OWNER_CARD, 0]);
    assert.deepEqual(checkFacts(facts, OWNER), { facts, dropped: 0 });
    // A tool in an earlier card's own words: the page's line now; one with no part number, gone.
    const stator = checkFacts({ title: "STATOR TEST", steps: [{ n: 1, text: "Disconnect the stator connector." }], tools: ["Digital Multimeter PU-50638", "Multimeter"], cautions: ["Turn the key OFF before you unplug the stator connector."], torqueOnPage: false }, STATOR);
    assert.deepEqual(stator, { facts: { title: "STATOR TEST", tools: ["Use Digital Multimeter PU-50638."], readOnPage: true, torqueOnPage: false }, dropped: 1 });
    assert.deepEqual(checkFacts(stator.facts, STATOR), { facts: stator.facts, dropped: 0 });
  });

  test("whatever shape the input has, the result has the card's shape", () => {
    for (const input of [null, undefined, "text", 42, [], { title: 5, tools: "PU-50638" }, { steps: "no", tools: [5, null, {}], cautions: {}, torques: [null, 1, "x"], notes: [{}], torqueOnPage: false }]) {
      assert.deepEqual(checkFacts(input, OWNER).facts, { title: "", tools: [], readOnPage: true, torqueOnPage: true }, JSON.stringify(input));
    }
  });

  test("a long title is cut to the card's length at a word's end, which isn't the page's heading", () => {
    const heading = `STARTER SOLENOID ${"REPLACEMENT AND INSPECTION ".repeat(6).trim()}`;
    assert.ok(heading.length > FACTS_LIMITS.title);
    assert.equal(kept({ title: heading }, `${OWNER}\n${heading}`).title, "");
  });
});

describe("the request and the answer", () => {
  test("one plain request to the reading model: no thinking, a small answer, the strict tool, nothing forced", () => {
    const params = factsRequest({ manualTitle: "2024 RANGER XD 1500 Service Manual", page: 62, text: OWNER });
    assert.equal(params.model, PAGE_FACTS_MODEL);
    assert.equal(PAGE_FACTS_MODEL, "claude-sonnet-5-5");
    assert.deepEqual(params.thinking, { type: "between_tools" });
    assert.ok(params.max_tokens <= 4000);
    assert.equal(params.tool_choice, undefined, "forced tool use is refused by this model");
    assert.equal("stream" in params, false);
    assert.deepEqual(params.tools, [FACTS_TOOL]);
    assert.equal(FACTS_TOOL.strict, true);
    const text = JSON.stringify(params.messages);
    assert.match(text, /record_page_facts/);
    assert.match(text, /Page 62/);
    assert.match(text, /STARTER SOLENOID REPLACEMENT/);
    assert.match(String(params.system), /record_page_facts/);
  });

  test("the tool asks for the title and the tools' part numbers only, and the prompt says the steps, torque specs and cautions are read on the page", () => {
    assert.deepEqual(Object.keys(FACTS_TOOL.input_schema.properties), ["title", "tools"]);
    assert.doesNotMatch(JSON.stringify(FACTS_TOOL.input_schema), /steps|cautions|torques|notes/);
    assert.match(FACTS_TOOL.input_schema.properties.tools.description, /part number/);
    assert.match(FACTS_SYSTEM, /Leave out everything else: the technician reads the steps, torque specs and cautions on the page itself/);
  });

  test("the tool's schema is one strict mode takes: every object closed, every field required, no number or length limits", () => {
    const visit = (schema: Record<string, unknown>, path: string) => {
      for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "multipleOf"]) {
        assert.ok(!(key in schema), `${path} has ${key}`);
      }
      if (schema.type === "object") {
        assert.equal(schema.additionalProperties, false, path);
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        assert.deepEqual([...(schema.required as string[])].sort(), Object.keys(properties).sort(), path);
        for (const [name, child] of Object.entries(properties)) visit(child, `${path}.${name}`);
      }
      if (schema.type === "array") visit(schema.items as Record<string, unknown>, `${path}[]`);
    };
    visit(FACTS_TOOL.input_schema as Record<string, unknown>, "input");
    assert.equal(FACTS_TOOL.name, FACTS_TOOL_NAME);
  });

  test("a long page is cut to what's sent", () => {
    const params = factsRequest({ manualTitle: "M", page: 1, text: "x".repeat(50_000) });
    assert.ok(JSON.stringify(params.messages).length < FACTS_LIMITS.pageText + 500);
  });

  test("the answer: the tool's input, or why there's none", () => {
    const call = { type: "tool_use", id: "toolu_1", name: FACTS_TOOL_NAME, input: OWNER_READING };
    const thinking = { type: "thinking", thinking: "Reading the page.", signature: "sig" };
    const reply = (content: unknown[], stop: string) => ({ content, stop_reason: stop }) as unknown as Parameters<typeof factsInReply>[0];
    assert.deepEqual(factsInReply(reply([thinking, call], "tool_use")), { input: OWNER_READING });
    assert.deepEqual(factsInReply(reply([{ type: "text", text: "Here you go." }], "end_turn")), { problem: "no_call" });
    assert.deepEqual(factsInReply(reply([{ ...call, name: "other_tool" }], "tool_use")), { problem: "no_call" });
    assert.deepEqual(factsInReply(reply([call], "max_tokens")), { problem: "max_tokens" });
    assert.deepEqual(factsInReply(reply([], "refusal")), { problem: "refusal" });
  });
});
