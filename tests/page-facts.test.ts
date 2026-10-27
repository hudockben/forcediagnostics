// Reading a manual page once for the part sheet's card: what Claude records
// is checked against the page's own text, and nothing on the card says
// anything of a torque. On the owner's starter-solenoid page the card has
// the procedure's title, steps 1 to 7 as the page words them, no tools, and
// the line saying the page has torque specs; every way a torque reached the
// card in earlier checks (a value, a number with no unit or in words, a unit
// as OCR misreads it, wording that hands one fastener's value to another,
// "Torque the cable fastener to 97…", two columns read across, values
// before their labels, a table row wrapped under its value), and every way
// the next checks found (a leading "97." waived as the step's own number, a
// step numbered 97 or 4 beside a fastener's name, hand-ons in words or
// marks no list had, "overtighten" and "retighten", TORQUE and its units
// garbled past reading, "90 deg", digits and letters of other scripts), is
// dropped from the title, the steps, the tools and the cautions, copied
// from the page word for word or not. A page without torque specs has no
// such line, and a number on it needs a unit that isn't a torque's. A card
// saved in an earlier shape (a torque list, notes) is read without them.
// Also the request itself (the model, no thinking, the strict tool with no
// torques, nothing forced) and reading the answer. Pure: no database.
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
const OWNER_LIST = OWNER_STEPS.split("\n")
  .slice(3)
  .map((line) => ({ n: Number(line[0]), text: line.slice(3) }));
// What Claude records for it, word for word from the page.
const OWNER_READING = { title: "STARTER SOLENOID REPLACEMENT", steps: OWNER_LIST, tools: [], cautions: [] };

// The same page scanned and read by OCR: misread letters, other marks for
// the N·m dot, a word and a sentence broken over lines, Ibs for lbs, an l
// for a 1, and a step whose one long word OCR misread.
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

// A test page with no torque spec on it.
const STATOR = `CHARGING SYSTEM
STATOR TEST
CAUTION: Turn the key OFF before you unplug the stator connector.
Use Digital Multimeter PU-50638.
1. Disconnect the stator connector.
2. Measure the resistance across the stator leads, 0.2 to 0.4 ohms.
3. Measure the resistance between pins 1 and 2: 0.2 to 0.4 ohms.
4. Check each pin to ground for continuity.
5. Replace the stator if a reading is out of range.`;
const STATOR_READING = {
  title: "STATOR TEST",
  steps: STATOR.split("\n")
    .slice(4)
    .map((line) => ({ n: Number(line[0]), text: line.slice(3) })),
  tools: ["Digital Multimeter PU-50638"],
  cautions: ["Turn the key OFF before you unplug the stator connector."],
};

// What a reading keeps, with nothing else in it.
const kept = (input: Record<string, unknown>, page: string) => {
  const { facts, dropped } = checkFacts({ title: "", steps: [], tools: [], cautions: [], ...input }, page);
  return { ...facts, dropped };
};
// The card's lines, as the card shows them (the torque line aside).
const card = (input: Record<string, unknown>, page: string) => {
  const facts = kept(input, page);
  return [...(facts.title ? [`title ${facts.title}`] : []), ...facts.steps.map((s) => `step ${s.text}`), ...facts.tools.map((s) => `tool ${s}`), ...facts.cautions.map((s) => `caution ${s}`)];
};
// An entry Claude writes in every list and as the title, the page not
// printing it.
function byClaude(entry: string, page: string) {
  return [...card({ steps: [6, 8].map((n) => ({ n, text: entry })), tools: [entry], cautions: [entry] }, page), ...card({ title: entry }, page)];
}
// The same, and the page printing it too, word for word: as its step 8, as
// a CAUTION, as a line of its own and as a heading (in capitals too, but
// where that would change what it says: "Il" for 11 isn't "IL").
function everywhere(entry: string, page: string, capitals = true) {
  const heading = entry.replace(/[.:]$/, "");
  return [heading, ...(capitals ? [heading.toUpperCase()] : [])].flatMap((title) => {
    const printed = `${page}\n8. ${entry}\nCAUTION: ${entry}\n${entry}\n${title}`;
    return [...byClaude(entry, page), ...card({ steps: [{ n: 8, text: entry }], tools: [entry], cautions: [entry], title }, printed)];
  });
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
  test("the title, steps 1 to 7 as the page words them, no tools, and the line saying the page has torque specs", () => {
    const { facts, dropped } = checkFacts(OWNER_READING, OWNER);
    assert.equal(dropped, 0);
    assert.deepEqual(facts, { ...OWNER_READING, torqueOnPage: true });
    assert.ok(hasFacts(facts));
    // Nothing of the TORQUE boxes is on the card.
    assert.doesNotMatch(JSON.stringify(facts), /97|35|106|62|in-lbs|N·m|torque\b/i);
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

  test("the same page from OCR: what OCR read right is kept, a step with a misread word among few isn't; the torque line still shows", () => {
    const { facts, dropped } = checkFacts(OWNER_READING, OWNER_OCR);
    assert.equal(facts.title, "STARTER SOLENOID REPLACEMENT");
    // Step 7's "lnstallation" and "rernoval" leave too few of its words on the page.
    assert.deepEqual(
      facts.steps.map((step) => step.n),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(dropped, 1);
    assert.equal(facts.torqueOnPage, true);
  });

  test("Claude's own steps: shortened is fine; reworded past the page's words, made up, or with a number not on the page isn't", () => {
    const result = kept(
      {
        steps: [
          { n: 2, text: "Remove the battery access panel." },
          { n: 3, text: "Disconnect the positive battery terminal." },
          { n: 4, text: "Unplug the solenoid's harness plug." },
          { n: 5, text: "Remove start solenoid cable nuts ②." },
          { n: 6, text: "Remove starter solenoid by removing fasteners ④." },
          { n: 7, text: "Install in reverse order of removal." },
        ],
      },
      OWNER,
    );
    assert.deepEqual(
      result.steps.map((step) => step.n),
      [2, 3, 5],
    );
    assert.equal(result.dropped, 3);
  });
});

// Every way a torque could reach the card in the earlier checks, written
// as Claude might put it in a step, a tool, a caution or the title.
const LEAKS = {
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
    "CYLINDER HEAD RETIGHTENING",
    "OVERTORQUE PROTECTION",
  ],
  "a torque's angle": ["Turn head bolts an additional 90 deg.", "Turn head bolts an additional 90°.", "Starter solenoid fastener plus 90 degrees"],
  "digits and letters of another script, or letters for a number": [
    "Starter Solenoid Fastener \u0669\u0667",
    "Starter Solenoid Fastener \u096f\u096d",
    "Starter Solenoid Fastener \uff19\uff17",
    "Starter Solenoid Fastener \u2079\u2077",
    "Starter Solenoid Cable Fastener \u216b",
    "Starter Solenoid Cable Fastener thirtyfive",
    "Starter Solenoid Fastener ninetyseven",
    "Starter Solenoid Fastener: ll",
    "Starter Solenoid Fastener Il",
    "Starter Solenoid Fastener lO",
    "T\u043erque the starter solenoid cable fastener.",
    "Starter Solenoid Cable Fastener s\u0430me Starter Solenoid Fastener",
    "Starter Solenoid Cable Fastener = s\u200bame Starter Solenoid Fastener",
    "Tor\u200bque the starter solenoid cable fastener.",
    "Tor\u00adque the starter solenoid cable fastener.",
    "Starter Solenoid Fastener 9\u200b7",
  ],
};
// Words that are only Claude's: what the page prints as its own word is
// its own ("XXXV" in a part's name), but these the owner's page doesn't.
const CLAUDES_WORDS = ["Starter Solenoid Cable Fastener XXXV", "Starter Solenoid Fastener IV", "Starter Solenoid Cable Fastener treintaicinco", "Cable Fastener sa me Solenoid", "Battery Terminal Fastener (Negative) (Positive)"];

describe("nothing on the card says anything of a torque", () => {
  for (const [kind, entries] of Object.entries(LEAKS)) {
    test(`${kind}: dropped from the steps, tools, cautions and title, and counted`, () => {
      for (const entry of entries) {
        for (const page of [OWNER, OWNER_OCR]) assert.deepEqual(everywhere(entry, page, !kind.startsWith("digits and letters")), [], entry);
        const result = kept({ steps: [{ n: 8, text: entry }], tools: [entry], cautions: [entry] }, OWNER);
        assert.equal(result.dropped, 3, entry);
      }
    });
  }

  test("words only Claude writes, beside a fastener's name: dropped, the page not having them", () => {
    for (const entry of CLAUDES_WORDS) {
      for (const page of [OWNER, OWNER_OCR]) assert.deepEqual(byClaude(entry, page), [], entry);
    }
  });

  test("a torque the page itself prints in a step, a notice or a note is dropped too, copied word for word", () => {
    const page = `${OWNER_STEPS}
8. Torque the starter solenoid fasteners to 97 in-lbs (11 N·m).
9. Starter Solenoid Cable Fastener: as for the Starter Solenoid Fastener.
CAUTION: Tighten the battery terminals to 106 in-lbs (12 N·m) only.
NOTE: Cable nuts: ninety-seven.
${FOOT}`;
    const said = ["Torque the starter solenoid fasteners to 97 in-lbs (11 N·m).", "Starter Solenoid Cable Fastener: as for the Starter Solenoid Fastener.", "Tighten the battery terminals to 106 in-lbs (12 N·m) only.", "Cable nuts: ninety-seven."];
    const result = kept({ ...OWNER_READING, steps: [...OWNER_LIST, ...said.slice(0, 2).map((text, i) => ({ n: 8 + i, text }))], cautions: said.slice(2) }, page);
    assert.deepEqual(result.steps, OWNER_LIST);
    assert.deepEqual([result.cautions, result.torqueOnPage, result.dropped], [[], true, 4]);
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
    };
    const paired = [
      "Positive cable: 62 in-lbs (7 N·m)",
      "Disconnect the battery positive cable 62 in-lbs (7 N·m).",
      "Remove the start solenoid cable nuts 97 in-lbs (11 N·m).",
      "Starter Solenoid Fastener: 35 in-lbs (4 N·m)",
      "Starter Solenoid Cable Fastener: 106",
      "Starter Solenoid Fastener 97",
      "Starter Solenoid Cable Fastener 97 11",
      "Starter solenoid cable fastener: 97",
      "Starter Solenoid Fastener: 97 in-lbs",
      "Solenoid Fastener 35",
    ];
    for (const [name, page] of Object.entries(pages)) {
      const result = kept({ steps: paired.map((text, i) => ({ n: 8 + i, text })), tools: paired, cautions: paired }, page);
      assert.deepEqual([result.steps, result.tools, result.cautions], [[], [], []], name);
      assert.equal(result.torqueOnPage, true, name);
      // The page's own steps with nothing of a torque in them stay.
      assert.ok(kept({ steps: [{ n: 1, text: "Raise dump bed." }] }, page).steps.length === 1, name);
    }
  });

  test("on a page with torque specs no number stays, in any unit, but a step's callouts and a tool's part number; no tool or caution names a fastener", () => {
    const lines = `8. Check for 12 V at the solenoid connector ① with the key on.
9. Check the terminal gap is 0.7 mm.
CAUTION: Disconnect the battery negative cable first to prevent sparks.
CAUTION: Do not reuse the cable nuts.
Use Battery Terminal Wrench PU-50964 on the terminal fasteners.`;
    const reading = {
      steps: [
        { n: 5, text: "Remove start solenoid cable nuts ②." },
        { n: 6, text: "Remove starter solenoid by removing fasteners ③." },
        { n: 8, text: "Check for 12 V at the solenoid connector ① with the key on." },
        { n: 9, text: "Check the terminal gap is 0.7 mm." },
      ],
      tools: ["Battery Terminal Wrench PU-50964", "Battery Terminal Wrench PU-50965", "Battery Terminal Wrench PU 50964", "Battery Terminal Wrench", "Battery Terminal Wrench PU-50964 on the terminal fasteners", "Battery Terminal Wrench ①"],
      cautions: ["Disconnect the battery negative cable first to prevent sparks.", "Do not reuse the cable nuts.", "Disconnect the battery negative cable first ①."],
    };
    const torqued = kept(reading, `${OWNER_STEPS}\n${lines}\n${OWNER_BOXES}`);
    assert.deepEqual(
      torqued.steps.map((step) => step.n),
      [5, 6],
    );
    assert.deepEqual(torqued.tools, ["Battery Terminal Wrench PU-50964", "Battery Terminal Wrench"]);
    assert.deepEqual(torqued.cautions, ["Disconnect the battery negative cable first to prevent sparks."]);
    assert.equal(torqued.dropped, 8);
    // The same page without its TORQUE boxes: a number in another unit as
    // the page prints it, a fastener named, a tool's callout.
    const plain = kept(reading, `${OWNER_STEPS}\n${lines}\n${FOOT}`);
    assert.deepEqual(
      plain.steps.map((step) => step.n),
      [5, 6, 8, 9],
    );
    assert.deepEqual(plain.tools, ["Battery Terminal Wrench PU-50964", "Battery Terminal Wrench", "Battery Terminal Wrench PU-50964 on the terminal fasteners", "Battery Terminal Wrench ①"]);
    assert.deepEqual(plain.cautions, ["Disconnect the battery negative cable first to prevent sparks.", "Do not reuse the cable nuts."]);
  });

  test("a torque's angle is dropped, in degrees or deg, on a page with torque specs or not", () => {
    const angle = `ENGINE\nCYLINDER HEAD INSTALLATION\n1. Install head bolts ①.\n2. Torque head bolts to 30 ft-lbs (41 N·m).\n3. Turn head bolts an additional 90 deg.\nTORQUE\nHead Bolts:\n30 ft-lbs (41 N·m) + 90 deg\n${FOOT}`;
    for (const page of [angle, angle.replace(/\nTORQUE[\s\S]*$/, "").replace(/\n2\..*/, "")]) {
      for (const text of ["Turn head bolts an additional 90 deg.", "Turn head bolts an additional 90°."]) {
        assert.deepEqual(kept({ steps: [{ n: 3, text }] }, page).steps, [], text);
      }
      assert.equal(kept({ steps: [{ n: 1, text: "Install head bolts ①." }] }, page).steps.length, 1);
    }
  });
});

describe("a step's number", () => {
  // The owner's page as a PDF's text can come out.
  const LAYOUTS = {
    "the owner's page": OWNER,
    "the owner's page from OCR": OWNER_OCR,
    "values before their labels": `${OWNER_STEPS}\nTORQUE\n97 in-lbs (11 N·m)\nStarter Solenoid Fastener:\nTORQUE\n35 in-lbs (4 N·m)\nStarter Solenoid Cable Fastener:\n${FOOT}`,
    "two columns read across": `${OWNER_STEPS}\nTORQUE TORQUE\nStarter Solenoid Fastener: Starter Solenoid Cable Fastener:\n97 in-lbs (11 N·m) 35 in-lbs (4 N·m)\n${FOOT}`,
  };

  test("a number at the start of an entry's text is the step's own only when it's that step's number, shown once; any other is a number on the card, and dropped", () => {
    for (const [name, page] of Object.entries(LAYOUTS)) {
      for (const step of [
        { n: 6, text: "97. Starter Solenoid Fastener" },
        { n: 6, text: "35) Starter Solenoid Cable Fastener" },
        { n: 6, text: "62. Battery Terminal Fastener (Negative)" },
        { n: 6, text: "97. Remove starter solenoid by removing fasteners ③." },
        { n: 6, text: "6) 11. Remove starter solenoid by removing fasteners ③." },
      ]) {
        assert.deepEqual(kept({ steps: [step] }, page).steps, [], `${name}: ${step.text}`);
      }
      const result = kept({ tools: ["11. Starter Solenoid Fastener"], cautions: ["35) Starter Solenoid Cable Fastener", "97. Starter Solenoid Fastener"] }, page);
      assert.deepEqual([result.tools, result.cautions, result.dropped], [[], [], 3], name);
    }
    // The step's own number in its text: the card shows it once.
    const numbered = OWNER_LIST.map((step) => ({ n: step.n, text: `${step.n}. ${step.text}` }));
    assert.deepEqual(kept({ steps: numbered }, OWNER).steps, OWNER_LIST);
    assert.deepEqual(kept({ steps: [{ n: 1, text: "1. Disconnect the stator connector." }] }, STATOR).steps, [{ n: 1, text: "Disconnect the stator connector." }]);
    // Off a page with torque specs another number with no unit is dropped too.
    assert.deepEqual(kept({ steps: [{ n: 1, text: "13. Disconnect the stator connector." }] }, STATOR).steps, []);
  });

  test("a step has to be one the page numbers so, after the one before, in the words of its own lines and starting as they do: a step's number never puts a torque beside a fastener", () => {
    const steps = [
      // The TORQUE boxes rebuilt from step numbers.
      { n: 97, text: "Starter Solenoid Fastener" },
      { n: 35, text: "Starter Solenoid Cable Fastener" },
      { n: 62, text: "Battery Terminal Fastener (Negative)" },
      // A real step under a fastener's N·m.
      { n: 11, text: "Remove starter solenoid by removing fasteners ③." },
      { n: 12, text: "Disconnect battery positive by loosening the terminal." },
      // A step number that's a torque's too (4 N·m, 7 N·m, 12 N·m), with a label or another step's words.
      { n: 4, text: "Starter Solenoid Cable Fastener" },
      { n: 4, text: "Disconnect starter solenoid cable fastener" },
      { n: 4, text: "Disconnect battery positive by loosening the terminal." },
      { n: 7, text: "Battery Terminal Fastener (Negative)" },
      { n: 1, text: "Battery Terminal Fastener (Positive)" },
      { n: 6, text: "Starter Solenoid Fastener" },
    ];
    for (const [name, page] of Object.entries(LAYOUTS)) {
      for (const step of steps) assert.deepEqual(kept({ steps: [step] }, page).steps, [], `${name}: ${step.n}. ${step.text}`);
    }
    // Out of order or twice: only rising ones.
    const result = kept({ steps: [OWNER_LIST[0], OWNER_LIST[2], OWNER_LIST[1], OWNER_LIST[2], OWNER_LIST[3]] }, OWNER);
    assert.deepEqual(
      result.steps.map((step) => step.n),
      [1, 3, 4],
    );
    assert.equal(result.dropped, 2);
    // No number, or one that isn't a step's.
    assert.deepEqual(kept({ steps: [{ text: "Raise dump bed." }, { n: 0, text: "Raise dump bed." }, { n: 1.5, text: "Raise dump bed." }, { n: "one", text: "Raise dump bed." }] }, OWNER).steps, []);
  });

  test("two columns read across: a step whose own line holds a TORQUE box's text too isn't one", () => {
    const across = `CHASSIS / BODY ELECTRICAL
STARTER SOLENOID REPLACEMENT
1. Raise dump bed. TORQUE
2. Remove battery access panel. Starter Solenoid Cable Fastener:
3. Disconnect battery positive by loosening the terminal. 35 in-lbs (4 N·m)
4. Disconnect starter solenoid electrical connector ① Starter Solenoid Cable Fastener
5. Remove start solenoid cable nuts ②.
${FOOT}`;
    const result = kept({ steps: [...OWNER_LIST.slice(0, 3), { n: 4, text: "Starter Solenoid Cable Fastener" }, OWNER_LIST[4]] }, across);
    assert.deepEqual(result.steps, [OWNER_LIST[4]]);
    assert.equal(result.dropped, 4);
  });
});

describe("a page without torque specs", () => {
  test("no torque line; a number needs a unit that isn't a torque's and has to be on the page; tools need their part numbers exactly as printed", () => {
    const { facts, dropped } = checkFacts(
      {
        ...STATOR_READING,
        steps: [...STATOR_READING.steps, { n: 6, text: "Measure the resistance across the stator leads, 0.2 to 0.5 ohms." }],
        tools: [...STATOR_READING.tools, "Digital Multimeter PU-50639", "Digital Multimeter PU 50638"],
        cautions: [...STATOR_READING.cautions, "Wear eye protection and keep a fire extinguisher nearby."],
      },
      STATOR,
    );
    // Step 3's pin numbers have no unit (and it has a colon); step 5's
    // "reading" can hand a value on.
    assert.deepEqual(facts, { ...STATOR_READING, steps: STATOR_READING.steps.filter((step) => [1, 2, 4].includes(step.n)), torqueOnPage: false });
    assert.equal(dropped, 6);
    assert.ok(hasFacts(facts));
  });

  test("the same steps on a page that has a torque spec: no number at all, so step 2's ohms go too", () => {
    const torqued = `${STATOR}\nTORQUE\nStator Bolts:\n8 ft-lbs (11 N·m)`;
    const result = kept(STATOR_READING, torqued);
    assert.deepEqual(
      result.steps.map((step) => step.n),
      [1, 4],
    );
    assert.deepEqual([result.tools, result.cautions, result.torqueOnPage], [STATOR_READING.tools, STATOR_READING.cautions, true]);
  });

  test("a page whose torque specs can't be seen (no TORQUE, no unit): a number with no unit is dropped all the same", () => {
    const page = `${OWNER_STEPS}\nFASTENER SPECIFICATIONS\nStarter Solenoid Fastener 97\nStarter Solenoid Cable Fastener 35\n${FOOT}`;
    assert.equal(torqueOnPage(page), false);
    const result = kept({ steps: [{ n: 6, text: "Remove starter solenoid by removing fasteners ③ 97." }], tools: ["Starter Solenoid Fastener 97", "Starter Solenoid Cable Fastener 35"], cautions: ["Starter Solenoid Fastener 97"] }, page);
    assert.deepEqual([result.steps, result.tools, result.cautions], [[], [], []]);
  });

  test("a torque or hand-on is dropped there too", () => {
    for (const entry of [...LEAKS["a torque value, the right one too"], ...LEAKS["words for torquing or tightening, with no number"], ...LEAKS["a number in words"], "Measure pin 2 the same as pin 1."]) {
      assert.deepEqual(everywhere(entry, STATOR), [], entry);
    }
  });

  test("which pages have torque specs: the word TORQUE as OCR reads it, or a torque unit in any spelling, with or without a number", () => {
    for (const page of [OWNER, OWNER_OCR, "T0RQUE\nCable Nut:", "TOROUE SPECIFICATIONS", "Tighten the axle nut to 110 ft-lbs (149 N·m).", "Axle nut 110 ft-1bs", "Cable nut 4 N-rn", "Cable nut 35 in#", "FASTENER FT-LBS N·M\nAxle Nut 110 149"]) {
      assert.ok(torqueOnPage(page), page);
    }
    for (const page of [STATOR, OWNER_STEPS, "STARTING SYSTEM WIRING DIAGRAM\nRD/WH\nBK\nStarter Solenoid\n10.60", "BATTERY SERVICE . . . . 10.40\nSTARTER SOLENOID SERVICE . . . . 10.62", "Fuel pressure: 58 psi (400 kPa)", "Torx T25 screwdriver"]) {
      assert.ok(!torqueOnPage(page), page);
    }
  });

  test("TORQUE and its units as OCR garbles them past the tokeniser are still seen, and a bare number beside a label never shows", () => {
    const headings = ["TORQUE", "TOROUE", "T0RQUE", "TORGUE", "TORQIJE", "TORQLJE", "TCRQUE", "TQRQUE", "IORQUE", "T ORQUE", "TOR QUE", "TORQ UE", "T O R Q U E", "TOR-\nQUE", "\u0422ORQUE", ""];
    const values = ["97 in-lbs (11 N·m)", "97 in-Ihs (11 N·rri)", "97 in-lhs (11 \u039d·m)", "97 ln-Ihs (11 Hm)", "97 in-Ihs (11 N·in)", "97 in-Ihs (11 Nin)", "97 in-Ilbs (11 N m)", "97 in-Ib (11 N-n)"];
    for (const heading of headings) {
      for (const value of values) {
        const page = `${OWNER_STEPS}\n${heading}\nStarter Solenoid Fastener:\n${value}\n${FOOT}`;
        assert.ok(torqueOnPage(page), `${heading} | ${value}`);
        const result = kept({ steps: [{ n: 6, text: "Remove starter solenoid by removing fasteners ③ 97." }], tools: ["Starter Solenoid Fastener: 97", "Starter Solenoid Fastener 11"] }, page);
        assert.deepEqual([result.steps, result.tools], [[], []], `${heading} | ${value}`);
      }
      if (heading) assert.ok(torqueOnPage(`${OWNER_STEPS}\n${heading}\nStarter Solenoid Fastener:\n97\n${FOOT}`), heading);
    }
    for (const value of ["8 pound-force feet", "8 lb·ft", "1.1 kg-rn", "11 Nem", "97 in-Ihs", "110 kgf-cm"]) {
      assert.ok(torqueOnPage(`${OWNER_STEPS}\nStarter Solenoid Fastener: ${value}\n${FOOT}`), value);
    }
  });
});

describe("checking a reading against the page", () => {
  test("a title alone isn't anything to show; a page's torque specs are", () => {
    assert.ok(!hasFacts(kept({ title: "STATOR TEST" }, STATOR)));
    const torqued = kept({ title: "STARTER SOLENOID SERVICE" }, OWNER);
    assert.equal(torqued.title, "STARTER SOLENOID SERVICE");
    assert.ok(hasFacts(torqued));
    // A wiring diagram with nothing recorded: nothing.
    const diagram = "STARTING SYSTEM WIRING DIAGRAM\nRD/WH\nBK\nStarter Solenoid\nBattery\nKey Switch\nECU\n10.60";
    assert.ok(!hasFacts(kept({ title: "STARTING SYSTEM WIRING DIAGRAM" }, diagram)));
  });

  test("a card saved in an earlier shape: its torque list, notes and more-torques line are left out, the rest checked again", () => {
    const old = {
      title: "STARTER SOLENOID REPLACEMENT",
      steps: [
        ...OWNER_LIST,
        { n: 8, text: "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m)." },
        { n: 97, text: "Starter Solenoid Fastener" },
        { n: 6, text: "35) Starter Solenoid Cable Fastener" },
      ],
      torques: [{ item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }],
      tools: [],
      cautions: [],
      notes: ["Starter Solenoid Cable Fastener: 35 in-lbs (4 N·m)"],
      moreTorques: false,
    };
    const { facts, dropped } = checkFacts(old, OWNER);
    assert.deepEqual(facts, { ...OWNER_READING, torqueOnPage: true });
    assert.equal(dropped, 3);
    // Read again, a card is the same card.
    assert.deepEqual(checkFacts(facts, OWNER), { facts, dropped: 0 });
  });

  test("whatever shape the input has, the result has the card's shape", () => {
    for (const input of [null, undefined, "text", 42, [], { steps: "no", tools: [5, null], cautions: {}, torques: [null, 1, "x"], notes: [{}], torqueOnPage: false }]) {
      assert.deepEqual(checkFacts(input, OWNER).facts, { title: "", steps: [], tools: [], cautions: [], torqueOnPage: true }, JSON.stringify(input));
    }
  });

  test("a step is kept only under a number the page gives a step, after the one before; each tool and caution once; lists capped", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Inspect the stator connector seal ${"abcdefghijklmnopqrst"[i]}`);
    const { facts } = checkFacts(
      {
        steps: [
          { n: 0, text: "Disconnect the stator connector." },
          { n: "two", text: "Disconnect the stator connector." },
          { text: "Disconnect the stator connector." },
          { n: 1, text: "Disconnect the stator connector." },
          { n: 4, text: "Check each pin to ground for continuity." },
          { n: 2, text: "Measure the resistance across the stator leads, 0.2 to 0.4 ohms." },
          { n: 4, text: "Check each pin to ground for continuity." },
          { n: 9, text: "Check each pin to ground for continuity." },
        ],
        tools: ["Digital Multimeter PU-50638", "digital multimeter PU-50638"],
        cautions: lines,
      },
      `${STATOR}\n${lines.map((line) => `CAUTION: ${line}`).join("\n")}`,
    );
    assert.deepEqual(facts.steps, [
      { n: 1, text: "Disconnect the stator connector." },
      { n: 4, text: "Check each pin to ground for continuity." },
    ]);
    assert.deepEqual(facts.tools, ["Digital Multimeter PU-50638"]);
    assert.equal(facts.cautions.length, FACTS_LIMITS.cautions);
  });

  test("long text is cut to the card's lengths, at a word's end", () => {
    const long = `Inspect the harness connector body terminal pins seal locking tab wire insulation ground strap flywheel magnet stator winding mounting boss cover gasket grommet clip routing channel sheath tape loom bracket shield coil lead plug socket housing latch cable tie guide rail spacer bushing collar sleeve ring cap`;
    assert.ok(long.length > FACTS_LIMITS.text);
    const { facts } = checkFacts({ steps: [{ n: 6, text: long }] }, `${STATOR}\n6. ${long}`);
    const shown = facts.steps[0].text;
    assert.ok(shown.length <= FACTS_LIMITS.text);
    assert.ok(long.startsWith(shown) && long[shown.length] === " ", shown);
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

  test("the tool asks for the title, steps, tools and cautions only, and the prompt says to leave every torque out", () => {
    assert.deepEqual(Object.keys(FACTS_TOOL.input_schema.properties), ["title", "steps", "tools", "cautions"]);
    assert.doesNotMatch(JSON.stringify(FACTS_TOOL.input_schema), /torques|notes/);
    assert.match(FACTS_SYSTEM, /Leave out every torque value and every torque or tightening instruction/);
    assert.match(FACTS_SYSTEM, /never say that one fastener takes the same as another/);
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
