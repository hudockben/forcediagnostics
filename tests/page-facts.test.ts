// Reading a manual page once for the part sheet's card: what Claude records
// is checked against the page's own text (torque values as written, with
// their units and close together, and the value of the box whose label
// their item names, in its words; steps, tools, cautions and notes mostly
// in the page's words, any number in them on the page, and any torque in
// them beside the fastener the page gives it for, with nothing said after
// it passing it on; the title and items with no torque of their own), on
// realistic Polaris page text from the text layer and from OCR, with
// TORQUE boxes stacked, side by side, wrapped and missing, and spec tables
// read row by row and column by column. Also the request itself (the
// model, no thinking, the strict tool, nothing forced) and reading the
// answer. Pure: no database.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FACTS_LIMITS,
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
  wordsOf,
} from "../src/lib/manual-facts-rules";

// The page the shop owner showed, as a PDF's text layer gives it (a line
// per text run).
const SOLENOID_PAGE = `ELECTRICAL
STARTER SOLENOID SERVICE
STARTER SOLENOID REPLACEMENT
1. Raise dump bed.
2. Remove battery access panel.
3. Disconnect battery positive (+) and negative (-) cables.
4. Remove the cable fasteners from the starter solenoid terminals.
5. Remove the two fasteners securing the starter solenoid to the frame.
6. Remove the starter solenoid.
7. Installation is performed by reversing the removal procedure.
TORQUE
Starter Solenoid Fastener:
97 in-lbs (11 N·m)
TORQUE
Starter Solenoid Cable Fastener:
35 in-lbs (4 N·m)
TORQUE
Battery Terminal Fastener (Positive):
106 in-lbs (12 N·m)
Battery Terminal Fastener (Negative):
62 in-lbs (7 N·m)
10.62
9940020 R01 - 2024 RANGER XP 1500 Service Manual
© Copyright Polaris Inc.`;

// The same page scanned and read by OCR: misread letters, other marks for
// the N·m dot, a line broken in a word and in a sentence, Ibs for lbs, an
// l for a 1.
const SOLENOID_OCR = `ELECTRlCAL
STARTER SOLENOID SERVlCE
STARTER SOLENOlD REPLACEMENT
1. Raise dump bed.
2. Rernove battery access panel.
3. Disconnect battery positive (+) and negative (-)
cables.
4. Remove the cable fasteners from the starter sole-
noid terminals.
5. Remove the two fasteners securing the starter solenoid to the frame.
6. Remove the starter solenoid.
7. lnstallation is performed by reversing the removal procedure.
TORQUE
Starter Solenoid Fastener:
97 in-Ibs (11 N•m)
TORQUE
Starter Solenoid Cable Fastener:
35 in-Ibs (4 N-m)
TORQUE
Battery Terminal Fastener (Positive):
l06 in-lbs (12 N m)
Battery Terminal Fastener (Negative):
62 in-lbs (7 Nm)`;

// What Claude would record for it, word for word from the page.
const READING = {
  title: "STARTER SOLENOID REPLACEMENT",
  steps: [
    { n: 1, text: "Raise dump bed." },
    { n: 2, text: "Remove battery access panel." },
    { n: 3, text: "Disconnect battery positive (+) and negative (-) cables." },
    { n: 4, text: "Remove the cable fasteners from the starter solenoid terminals." },
    { n: 5, text: "Remove the two fasteners securing the starter solenoid to the frame." },
    { n: 6, text: "Remove the starter solenoid." },
    { n: 7, text: "Installation is performed by reversing the removal procedure." },
  ],
  torques: [
    { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" },
    { item: "Starter Solenoid Cable Fastener", value: "35 in-lbs (4 N·m)" },
    { item: "Battery Terminal Fastener (Positive)", value: "106 in-lbs (12 N·m)" },
    { item: "Battery Terminal Fastener (Negative)", value: "62 in-lbs (7 N·m)" },
  ],
  tools: [],
  cautions: [],
  notes: [],
};

const torque = (item: string, value: string) => ({ ...READING, torques: [{ item, value }], steps: [] });
const keptTorques = (input: unknown, page = SOLENOID_PAGE) => checkFacts(input, page).facts.torques.map((t) => t.value);

describe("comparing specs", () => {
  test("units are spelled one way, and N·m's dot and its stand-ins don't matter", () => {
    for (const written of ["97 in-lbs (11 N·m)", "97 in. lbs. (11 Nm)", "97 inch-pounds (11 N-m)", "97 lb-in (11 N m)", "97 IN-LBS (11 N•M)", "97 in-Ibs (11 N∙m)"]) {
      assert.deepEqual(specTokens(written), ["97", "inlb", "11", "nm"], written);
    }
    assert.deepEqual(specTokens("18 ft-lbs (24 N·m)"), ["18", "ftlb", "24", "nm"]);
    assert.deepEqual(specTokens("18 lb-ft"), ["18", "ftlb"]);
    assert.deepEqual(specTokens("9.5 to 10.5 kΩ"), ["9.5|10.5", "kohm"]);
  });

  test("a range is one token, so a value inside it never matches", () => {
    assert.deepEqual(specTokens("6-8 ft-lbs"), ["6|8", "ftlb"]);
    assert.deepEqual(specTokens("0.6 to 0.8 ohms"), ["0.6|0.8", "ohm"]);
    assert.ok(numbersOnPage("6-8 ft-lbs", specTokens("Tighten to 6-8 ft-lbs")));
    assert.ok(!numbersOnPage("8 ft-lbs", specTokens("Tighten to 6-8 ft-lbs")));
    assert.ok(!numbersOnPage("6 ft-lbs", specTokens("Tighten to 6-8 ft-lbs")));
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
    assert.deepEqual(specTokens("1l ft-lbs"), ["11", "ftlb"]);
    // Words with those letters stay words.
    assert.deepEqual(specTokens("coil oil lid"), ["coil", "oil", "lid"]);
  });

  test("quantities: each number with the units right after it", () => {
    assert.deepEqual(quantities(specTokens("97 in-lbs (11 N·m)")), [["97", "inlb"], ["11", "nm"]]);
    assert.deepEqual(quantities(specTokens("Torque to 20 Nm in a star pattern")), [["20", "nm"]]);
    assert.deepEqual(quantities(specTokens("0.6 to 0.8 ohms at 20 C")), [["0.6|0.8", "ohm"], ["20"]]);
  });

  test("a number has to be the page's number, not part of a bigger one or a decimal", () => {
    const page = specTokens(SOLENOID_PAGE);
    assert.ok(numbersOnPage("11 N·m", page));
    assert.ok(!numbersOnPage("1 N·m", page), "1 inside 11");
    assert.ok(!numbersOnPage("06 in-lbs", page), "06 inside 106");
    assert.ok(!numbersOnPage("9.7 in-lbs", page));
    assert.ok(!numbersOnPage("97 ft-lbs", page), "the wrong unit");
    assert.ok(numbersOnPage("no numbers at all", page));
  });

  test("a number given in two units has to be given so on the page, as in one TORQUE box", () => {
    const page = specTokens(SOLENOID_PAGE);
    assert.ok(numbersOnPage("97 in-lbs (11 N·m)", page));
    assert.ok(numbersOnPage("97 in-lbs / 11 N·m", page));
    // The other order is the same box.
    assert.ok(numbersOnPage("11 N·m (97 in-lbs)", page));
    // The positive fastener's in-lbs with the negative one's N·m.
    assert.ok(!numbersOnPage("106 in-lbs (7 N·m)", page));
    // The first box's in-lbs with the second box's N·m.
    assert.ok(!numbersOnPage("97 in-lbs (4 N·m)", page));
    // Specs apart in a sentence can be apart on the page.
    const steps = specTokens("Tighten the fasteners to 10 N·m (89 in-lbs). Loosen each a quarter turn, then tighten them to 25 N·m (18 ft-lbs) in a cross pattern.");
    assert.ok(numbersOnPage("Tighten to 10 N·m (89 in-lbs), then to 25 N·m (18 ft-lbs).", steps));
    assert.ok(!numbersOnPage("Tighten to 10 N·m (18 ft-lbs), then to 25 N·m.", steps));
  });

  test("words: lower case, small ones out, a light stem the same on both sides", () => {
    assert.deepEqual(wordsOf("Disconnect the battery CABLES"), wordsOf("disconnect battery cable"));
    assert.equal(stem("removed"), stem("remove"));
    assert.equal(stem("batteries"), stem("battery"));
    assert.equal(stem("switches"), stem("switch"));
    assert.equal(stem("springs"), stem("spring"));
    assert.equal(stem("bearings"), stem("bearing"));
    assert.equal(stem("speed"), "speed");
    assert.equal(stem("chassis"), "chassis");
    // A word broken over a line is one word.
    assert.ok(wordsOf("starter sole-\nnoid").includes(stem("solenoid")));
  });
});

describe("checking a reading against the page", () => {
  test("the starter-solenoid page: everything on it is kept as Claude wrote it", () => {
    const { facts, dropped } = checkFacts(READING, SOLENOID_PAGE);
    assert.equal(dropped, 0);
    assert.deepEqual(facts, READING);
    assert.ok(hasFacts(facts));
  });

  test("the same page from OCR: misread letters, other dots, Ibs and l06 still check out", () => {
    const { facts, dropped } = checkFacts(READING, SOLENOID_OCR);
    assert.equal(dropped, 0, JSON.stringify(facts));
    assert.equal(facts.torques.length, 4);
    assert.equal(facts.steps.length, 7);
    assert.equal(facts.title, "STARTER SOLENOID REPLACEMENT");
  });

  test("a torque value the page doesn't have is dropped and counted", () => {
    const made = {
      ...READING,
      torques: [
        ...READING.torques,
        // Not on this page at all.
        { item: "Starter Motor Mounting Bolt", value: "18 ft-lbs (24 N·m)" },
        // The page's number with the wrong unit.
        { item: "Starter Solenoid Fastener", value: "97 ft-lbs (11 N·m)" },
        // Two boxes' numbers mixed.
        { item: "Battery Terminal Fastener (Positive)", value: "106 in-lbs (7 N·m)" },
        // Part of a bigger number.
        { item: "Starter Solenoid Cable Fastener", value: "5 in-lbs" },
        // A decimal the page doesn't have.
        { item: "Starter Solenoid Fastener", value: "9.7 in-lbs (1.1 N·m)" },
      ],
    };
    const { facts, dropped } = checkFacts(made, SOLENOID_PAGE);
    assert.equal(dropped, 5);
    assert.deepEqual(facts.torques, READING.torques);
  });

  test("a value written another way still counts: other order, unit spelling, missing second unit", () => {
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "11 N·m (97 in-lbs)")), ["11 N·m (97 in-lbs)"]);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in. lb. (11 Nm)")), ["97 in. lb. (11 Nm)"]);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in-lbs")), ["97 in-lbs"]);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "11 N·m")), ["11 N·m"]);
  });

  test("a torque needs a number and an item the page names", () => {
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "Hand tight")), []);
    assert.deepEqual(keptTorques(torque("", "97 in-lbs (11 N·m)")), []);
    // An item made up around a real value.
    assert.deepEqual(keptTorques(torque("Rear Differential Drain Plug", "97 in-lbs (11 N·m)")), []);
    // The item shortened, or in other case, is still the page's.
    assert.deepEqual(keptTorques(torque("solenoid fastener", "97 in-lbs (11 N·m)")), ["97 in-lbs (11 N·m)"]);
    // A number with no torque unit isn't a torque.
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97")), []);
  });

  test("a torque has to be its own item's: a value from the box beside it is dropped", () => {
    // Each box's value under the wrong fastener.
    assert.deepEqual(keptTorques(torque("Starter Solenoid Cable Fastener", "97 in-lbs (11 N·m)")), []);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "35 in-lbs (4 N·m)")), []);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "7 N·m")), []);
    // The positive terminal with the negative's value, and the other way round.
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Positive)", "62 in-lbs (7 N·m)")), []);
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Negative)", "106 in-lbs (12 N·m)")), []);
    // A label made from the page's words that two boxes fit as well as each other.
    assert.deepEqual(keptTorques(torque("Battery Cable Fastener", "35 in-lbs (4 N·m)")), []);
    // The same from OCR.
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "35 in-lbs (4 N·m)"), SOLENOID_OCR), []);
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Negative)", "62 in-lbs (7 N·m)"), SOLENOID_OCR), ["62 in-lbs (7 N·m)"]);
  });

  test("the box's label: on the line above or before it, a parenthesis read with the box above, a step's own words", () => {
    // The owner's page: the negative terminal's box says only "(Negative):".
    const boxed = `TORQUE
Battery Terminal Fastener (Positive):
106 in-lbs (12 N·m)
(Negative):
62 in-lbs (7 N·m)`;
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Negative)", "62 in-lbs (7 N·m)"), boxed), ["62 in-lbs (7 N·m)"]);
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Positive)", "106 in-lbs (12 N·m)"), boxed), ["106 in-lbs (12 N·m)"]);
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Positive)", "62 in-lbs (7 N·m)"), boxed), []);
    // On one line, as some text layers give a box.
    const inline = "Battery Terminal Fastener (Positive): 106 in-lbs (12 N·m) / (Negative): 62 in-lbs (7 N·m)";
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Negative)", "62 in-lbs (7 N·m)"), inline), ["62 in-lbs (7 N·m)"]);
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Positive)", "62 in-lbs (7 N·m)"), inline), []);
    // A spec in a step, labelled by the step's words; the other unit on the next line.
    const steps = "4. Install the drain plug and torque to 18 ft-lbs\n(24 N·m).\n5. Torque the fill plug to 30 ft-lbs (41 N·m).";
    assert.deepEqual(keptTorques(torque("Drain Plug", "18 ft-lbs (24 N·m)"), steps), ["18 ft-lbs (24 N·m)"]);
    assert.deepEqual(keptTorques(torque("Drain Plug", "24 N·m"), steps), ["24 N·m"]);
    assert.deepEqual(keptTorques(torque("Fill Plug", "30 ft-lbs (41 N·m)"), steps), ["30 ft-lbs (41 N·m)"]);
    assert.deepEqual(keptTorques(torque("Drain Plug", "30 ft-lbs (41 N·m)"), steps), []);
    // Two boxes labelled alike: kept only when both have the value.
    const twice = "FRONT\nMounting Bolt: 30 ft-lbs (41 N·m)\nREAR\nMounting Bolt: 30 ft-lbs (41 N·m)\nSKID PLATE\nMounting Bolt: 8 ft-lbs (11 N·m)";
    assert.deepEqual(keptTorques(torque("Mounting Bolt", "30 ft-lbs (41 N·m)"), twice), []);
    const same = "FRONT\nMounting Bolt: 30 ft-lbs (41 N·m)\nREAR\nMounting Bolt: 30 ft-lbs (41 N·m)";
    assert.deepEqual(keptTorques(torque("Mounting Bolt", "30 ft-lbs (41 N·m)"), same), ["30 ft-lbs (41 N·m)"]);
    // A label a text layer ran onto the end of the step before it.
    const runOn = "4. Remove the cable nuts and label each cable. Starter Solenoid Fastener: 97 in-lbs (11 N·m)\nStarter Solenoid Cable Fastener: 35 in-lbs (4 N·m)";
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in-lbs (11 N·m)"), runOn), ["97 in-lbs (11 N·m)"]);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "35 in-lbs (4 N·m)"), runOn), []);
    // A unit's abbreviation isn't a sentence's end.
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in-lbs (11 N·m)"), "Starter Solenoid Fastener: 97 IN. LBS. (11 N·m)"), ["97 in-lbs (11 N·m)"]);
    // OCR's 1l for 11 in a box.
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in-lbs (11 N·m)"), "Starter Solenoid Fastener:\n97 in-lbs (1l N·m)"), ["97 in-lbs (11 N·m)"]);
  });

  test("steps: shortened or reworded is fine, made up or with a number not on the page isn't", () => {
    const { facts, dropped } = checkFacts(
      {
        ...READING,
        torques: [],
        steps: [
          { n: 3, text: "Disconnect the battery cables (positive and negative)." },
          { n: 4, text: "Check the starter relay with a multimeter for continuity." },
          { n: 5, text: "Torque the solenoid fasteners to 79 in-lbs." },
          { n: 6, text: "Torque the solenoid fasteners to 97 in-lbs (11 N·m)." },
          { n: 7, text: "Install in reverse order of removal." },
        ],
      },
      SOLENOID_PAGE,
    );
    assert.deepEqual(
      facts.steps.map((step) => step.n),
      [3, 6],
    );
    // "Install in reverse order of removal" shares too few of its words.
    assert.equal(dropped, 3);
  });

  test("tools, cautions and notes: only what the page says", () => {
    const page = `FUEL SYSTEM
FUEL PRESSURE TEST
Fuel Pressure Gauge Kit: PU-43506-A
CAUTION
Gasoline is extremely flammable. Relieve fuel system pressure before you disconnect a fuel line.
1. Connect the gauge at the fuel rail test port.
2. Run the engine at idle.
NOTE: Fuel pressure with the engine running is 58 psi (400 kPa).`;
    const { facts, dropped } = checkFacts(
      {
        title: "FUEL PRESSURE TEST",
        steps: [{ n: 1, text: "Connect the gauge at the fuel rail test port." }, { n: 2, text: "Run the engine at idle." }],
        torques: [],
        tools: ["Fuel Pressure Gauge Kit PU-43506-A", "Digital Wrench diagnostic software", "Fuel Pressure Gauge Kit PU-43509-A"],
        cautions: ["Gasoline is extremely flammable. Relieve fuel system pressure before you disconnect a fuel line.", "Wear eye protection when working on the fuel system and keep a fire extinguisher nearby."],
        notes: ["Fuel pressure with the engine running is 58 psi (400 kPa).", "Fuel pressure with the engine running is 43 psi (296 kPa)."],
      },
      page,
    );
    assert.deepEqual(facts.tools, ["Fuel Pressure Gauge Kit PU-43506-A"]);
    assert.equal(facts.cautions.length, 1);
    assert.deepEqual(facts.notes, ["Fuel pressure with the engine running is 58 psi (400 kPa)."]);
    assert.equal(dropped, 4);
  });

  test("a title the page doesn't have is blanked; a reading with nothing but a title is nothing", () => {
    const { facts, dropped } = checkFacts({ title: "CLUTCH ALIGNMENT", steps: [], torques: [], tools: [], cautions: [], notes: [] }, SOLENOID_PAGE);
    assert.equal(facts.title, "");
    assert.equal(dropped, 1);
    const titled = checkFacts({ title: "STARTER SOLENOID SERVICE", steps: [], torques: [], tools: [], cautions: [], notes: [] }, SOLENOID_PAGE).facts;
    assert.equal(titled.title, "STARTER SOLENOID SERVICE");
    assert.ok(!hasFacts(titled));
  });

  test("a wiring diagram's or contents page's text gives nothing a card shows when Claude records nothing", () => {
    const diagram = "STARTING SYSTEM WIRING DIAGRAM\nRD/WH\nBK\nStarter Solenoid\nBattery\nKey Switch\nECU\n10.60";
    const { facts } = checkFacts({ title: "STARTING SYSTEM WIRING DIAGRAM", steps: [], torques: [], tools: [], cautions: [], notes: [] }, diagram);
    assert.ok(!hasFacts(facts));
  });

  test("whatever shape the input has, the result has the card's shape", () => {
    for (const input of [null, undefined, "text", 42, [], { steps: "no", torques: [null, 1, "x"], tools: [5, null], cautions: {}, notes: [{}] }]) {
      const { facts } = checkFacts(input, SOLENOID_PAGE);
      assert.deepEqual(facts, { title: "", steps: [], torques: [], tools: [], cautions: [], notes: [] }, JSON.stringify(input));
    }
  });

  test("steps get a number when theirs isn't one, each entry is kept once, and lists are capped", () => {
    const { facts } = checkFacts(
      {
        ...READING,
        steps: [
          { n: 0, text: "Raise dump bed." },
          { n: "two", text: "Remove battery access panel." },
          { n: 2, text: "Remove battery access panel." },
        ],
        torques: [...READING.torques, ...READING.torques],
        notes: Array.from({ length: 20 }, (_, i) => `Starter solenoid terminals ${["one", "two", "three"][i % 3]} cable fastener ${i}`),
      },
      SOLENOID_PAGE + "\n" + Array.from({ length: 20 }, (_, i) => `Starter solenoid terminals ${["one", "two", "three"][i % 3]} cable fastener ${i}`).join("\n"),
    );
    assert.deepEqual(facts.steps, [
      { n: 1, text: "Raise dump bed." },
      { n: 2, text: "Remove battery access panel." },
    ]);
    assert.equal(facts.torques.length, 4);
    assert.equal(facts.notes.length, FACTS_LIMITS.notes);
  });

  test("long text is cut to the card's lengths", () => {
    const long = `${"Remove the starter solenoid. ".repeat(30)}`;
    const { facts } = checkFacts({ ...READING, steps: [{ n: 1, text: long }], torques: [] }, SOLENOID_PAGE);
    assert.ok(facts.steps[0].text.length <= FACTS_LIMITS.text);
  });
});

// The owner's page's procedure, before its TORQUE boxes.
const SOLENOID_STEPS = SOLENOID_PAGE.slice(0, SOLENOID_PAGE.indexOf("\nTORQUE"));

// What a reading keeps of each list, with nothing else in it.
const kept = (input: Record<string, unknown>, page: string) => {
  const { facts, dropped } = checkFacts({ title: "", steps: [], torques: [], tools: [], cautions: [], notes: [], ...input }, page);
  return { ...facts, dropped };
};
// Each box's value under the next box's fastener, and the other way round.
const SWAPPED = READING.torques.map((t, i, all) => ({ item: t.item, value: all[(i + 1) % all.length].value }));

describe("a torque only beside the fastener the page gives it for", () => {
  test("the owner's page: a torque in a note, step, caution or tool under another fastener drops the whole entry", () => {
    for (const page of [SOLENOID_PAGE, SOLENOID_OCR]) {
      const result = kept(
        {
          steps: [
            { n: 7, text: "Torque the starter solenoid cable fasteners to 97 in-lbs (11 N·m)." },
            { n: 6, text: "Torque the solenoid fasteners to 97 in-lbs (11 N·m)." },
          ],
          notes: ["Starter Solenoid Cable Fastener: 97 in-lbs (11 N·m)", "Starter Solenoid Fastener: 97 in-lbs (11 N·m)"],
          cautions: ["Torque the battery terminal fastener (negative) to 106 in-lbs (12 N·m)", "Torque the battery terminal fastener (negative) to 62 in-lbs (7 N·m)"],
          // A word the label hasn't ("socket") makes it not the label's.
          tools: [
            "Starter solenoid fastener socket, 35 in-lbs (4 N·m)",
            "Battery terminal fastener (positive) socket, 106 in-lbs (12 N·m)",
            "Torque the battery terminal fastener (positive) to 106 in-lbs (12 N·m) with a torque wrench",
          ],
        },
        page,
      );
      assert.deepEqual(result.steps, [{ n: 6, text: "Torque the solenoid fasteners to 97 in-lbs (11 N·m)." }]);
      assert.deepEqual(result.notes, ["Starter Solenoid Fastener: 97 in-lbs (11 N·m)"]);
      assert.deepEqual(result.cautions, ["Torque the battery terminal fastener (negative) to 62 in-lbs (7 N·m)"]);
      assert.deepEqual(result.tools, ["Torque the battery terminal fastener (positive) to 106 in-lbs (12 N·m) with a torque wrench"]);
      assert.equal(result.dropped, 5);
    }
  });

  test("in an entry, a torque needs the entry's own words for its fastener, and one value for them", () => {
    const result = kept(
      {
        notes: [
          // No fastener named.
          "Torque to 97 in-lbs (11 N·m).",
          // The fastener named after the value, not before it.
          "97 in-lbs (11 N·m) for the starter solenoid fastener.",
          // Named before it, then another named after it on its line.
          "Starter solenoid: 97 in-lbs (11 N·m) for the cable fasteners.",
          // Words after it that name no other fastener, or on a line of their own.
          "Torque the solenoid fasteners to 97 in-lbs (11 N·m) in a cross pattern.",
          "Torque the solenoid fasteners to 97 in-lbs (11 N·m). Reconnect the battery cables.",
          // Two values in one unit for one fastener: which is it?
          "Torque the starter solenoid fastener to 97 in-lbs, then 35 in-lbs.",
          // Each with its own: both the page's.
          "Starter solenoid fastener 97 in-lbs (11 N·m), cable fastener 35 in-lbs (4 N·m).",
          // The second one the other box's.
          "Starter solenoid fastener 97 in-lbs (11 N·m), cable fastener 62 in-lbs (7 N·m).",
          // A box's two terminals on one line, the second by its one word.
          "Battery Terminal Fastener (Positive): 106 in-lbs (12 N·m) / (Negative): 62 in-lbs (7 N·m)",
          "Battery Terminal Fastener (Positive): 62 in-lbs (7 N·m) / (Negative): 106 in-lbs (12 N·m)",
        ],
      },
      SOLENOID_PAGE,
    );
    assert.deepEqual(result.notes, [
      "Torque the solenoid fasteners to 97 in-lbs (11 N·m) in a cross pattern.",
      "Torque the solenoid fasteners to 97 in-lbs (11 N·m). Reconnect the battery cables.",
      "Starter solenoid fastener 97 in-lbs (11 N·m), cable fastener 35 in-lbs (4 N·m).",
      "Battery Terminal Fastener (Positive): 106 in-lbs (12 N·m) / (Negative): 62 in-lbs (7 N·m)",
    ]);
    assert.equal(result.dropped, 6);
  });

  test("other numbers in an entry only have to be on the page", () => {
    const page = `${SOLENOID_STEPS}\nNOTE: With the key on, there should be 12 V at pin 13 of the solenoid connector.\nThe terminal gap is 0.7 mm.`;
    const result = kept(
      {
        steps: [
          { n: 1, text: "Check for 12 V at pin 13 of the solenoid connector." },
          { n: 2, text: "Check for 12 V at pin 14 of the solenoid connector." },
        ],
        notes: ["The terminal gap is 0.7 mm.", "The terminal gap is 0.8 mm."],
      },
      page,
    );
    assert.deepEqual(result.steps.map((step) => step.n), [1]);
    assert.deepEqual(result.notes, ["The terminal gap is 0.7 mm."]);
    assert.equal(result.dropped, 2);
  });

  test("TORQUE boxes side by side (the labels on one line, the values on the next): each value is its own box's", () => {
    const side = `${SOLENOID_STEPS}
TORQUE TORQUE TORQUE
Starter Solenoid Fastener: Starter Solenoid Cable Fastener: Battery Terminal Fastener (Positive):
97 in-lbs (11 N·m) 35 in-lbs (4 N·m) 106 in-lbs (12 N·m)
Battery Terminal Fastener (Negative):
62 in-lbs (7 N·m)`;
    assert.deepEqual(kept({ torques: READING.torques }, side).torques, READING.torques);
    const swapped = kept({ torques: SWAPPED }, side);
    assert.deepEqual(swapped.torques, []);
    assert.equal(swapped.dropped, 4);
    const notes = kept({ notes: ["Starter Solenoid Cable Fastener: 97 in-lbs (11 N·m)", "Starter Solenoid Cable Fastener: 35 in-lbs (4 N·m)"] }, side).notes;
    assert.deepEqual(notes, ["Starter Solenoid Cable Fastener: 35 in-lbs (4 N·m)"]);
    // OCR's spacing: a space before a colon, none around the units, runs of spaces.
    const ocr = `TORQUE    TORQUE
Starter  Solenoid  Fastener :     Starter Solenoid Cable Fastener :
97in-lbs(11N·m)      35 in -Ibs ( 4 N • m )`;
    assert.deepEqual(kept({ torques: READING.torques.slice(0, 2) }, ocr).torques, READING.torques.slice(0, 2));
    assert.deepEqual(kept({ torques: SWAPPED.slice(0, 1) }, ocr).torques, []);
    assert.deepEqual(kept({ torques: [{ item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" }] }, ocr).torques, []);
  });

  test("TORQUE boxes read column by column (all the labels, then all the values): paired in order", () => {
    const columns = `${SOLENOID_STEPS}
TORQUE
TORQUE
Starter Solenoid Fastener:
Starter Solenoid Cable Fastener:
97 in-lbs (11 N·m)
35 in-lbs (4 N·m)
TORQUE
Battery Terminal Fastener (Positive):
106 in-lbs (12 N·m)
Battery Terminal Fastener (Negative):
62 in-lbs (7 N·m)`;
    assert.deepEqual(kept({ torques: READING.torques }, columns).torques, READING.torques);
    assert.deepEqual(kept({ torques: SWAPPED }, columns).torques, []);
  });

  test("labels and values that don't pair up one for one: none of that block's values is taken", () => {
    const cases = [
      // Two labels, one value: whose is it?
      "Starter Solenoid Fastener:\nStarter Solenoid Cable Fastener:\n97 in-lbs (11 N·m)",
      // One label, two values.
      "Starter Solenoid Fastener:\n97 in-lbs (11 N·m)\n35 in-lbs (4 N·m)",
      // Each box's second unit on a line of its own: three values for two labels.
      "Starter Solenoid Fastener: Starter Solenoid Cable Fastener:\n97 in-lbs 35 in-lbs\n(11 N·m) (4 N·m)",
      // Values not given alike.
      "Starter Solenoid Fastener: Starter Solenoid Cable Fastener:\n97 in-lbs (11 N·m) 35 in-lbs",
    ];
    for (const page of cases) {
      const wanted = [
        { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" },
        { item: "Starter Solenoid Fastener", value: "97 in-lbs" },
        { item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" },
        { item: "Starter Solenoid Cable Fastener", value: "35 in-lbs" },
      ];
      assert.deepEqual(kept({ torques: wanted }, page).torques, [], page);
      assert.deepEqual(kept({ notes: ["Starter Solenoid Fastener: 97 in-lbs (11 N·m)"] }, page).notes, [], page);
    }
    // OCR kept only "Fastener:" of the second box's label and lost the first box's value:
    // the label still holds its place, so the 35 in-lbs isn't the first box's.
    const lost = "TORQUE\nStarter Solenoid Fastener:\nTORQUE\nFastener:\n35 in-lbs (4 N·m)";
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "35 in-lbs (4 N·m)"), lost), []);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Cable Fastener", "35 in-lbs (4 N·m)"), lost), []);
    // A tool's line above a box ("Name: part number") had its value: it doesn't wait for this one.
    const tool = "Battery Terminal Wrench: PU-50964\nTORQUE\nStarter Solenoid Fastener:\n97 in-lbs (11 N·m)";
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in-lbs (11 N·m)"), tool), ["97 in-lbs (11 N·m)"]);
    const tools = "Battery Terminal Wrench:\nPU-50964\nStarter Solenoid Fastener:\n97 in-lbs (11 N·m)";
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in-lbs (11 N·m)"), tools), ["97 in-lbs (11 N·m)"]);
    // The boxes around such a block still count.
    const mixed = `Starter Solenoid Fastener:\nStarter Solenoid Cable Fastener:\n97 in-lbs (11 N·m)\nTORQUE\nBattery Terminal Fastener (Positive):\n106 in-lbs (12 N·m)`;
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Positive)", "106 in-lbs (12 N·m)"), mixed), ["106 in-lbs (12 N·m)"]);
    // A two-stage torque in a step: two values after one label, so neither is taken.
    const twoStage = "5. Torque the cylinder head bolts to 10 N·m, then to 25 N·m.";
    assert.deepEqual(keptTorques(torque("Cylinder Head Bolts", "25 N·m"), twoStage), []);
    assert.deepEqual(kept({ steps: [{ n: 5, text: "Torque the cylinder head bolts to 10 N·m, then to 25 N·m." }] }, twoStage).steps, []);
  });

  test("a spec table read column by column: its rows paired in order when they line up, none when they don't", () => {
    const rows = ["Upper A-Arm Pivot Bolt", "Lower A-Arm Pivot Bolt", "Shock Mounting Bolt"];
    const values = ["40 ft-lbs (54 N·m)", "45 ft-lbs (61 N·m)", "30 ft-lbs (41 N·m)"];
    const table = `FRONT SUSPENSION\nTORQUE SPECIFICATIONS\nFastener\nTorque\n${rows.join("\n")}\n${values.join("\n")}`;
    const right = rows.map((item, i) => ({ item, value: values[i] }));
    assert.deepEqual(kept({ torques: right }, table).torques, right);
    assert.deepEqual(kept({ torques: rows.map((item, i) => ({ item, value: values[(i + 1) % 3] })) }, table).torques, []);
    assert.deepEqual(kept({ notes: ["Shock Mounting Bolt: 30 ft-lbs (41 N·m)", "Shock Mounting Bolt: 45 ft-lbs (61 N·m)"] }, table).notes, ["Shock Mounting Bolt: 30 ft-lbs (41 N·m)"]);
    // Read row by row, the same.
    const byRow = `FRONT SUSPENSION\nTORQUE SPECIFICATIONS\n${rows.map((item, i) => `${item} ${values[i]}`).join("\n")}`;
    assert.deepEqual(kept({ torques: right }, byRow).torques, right);
    // A row whose value isn't a torque ("Hand tight") leaves three rows for two values.
    const handTight = `FRONT SUSPENSION\nTORQUE SPECIFICATIONS\n${rows.join("\n")}\nSway Bar Link\n${values.join("\n")}\nHand tight`;
    assert.deepEqual(kept({ torques: right }, handTight).torques, []);
    // A line above the rows that could be a row too: where do they start?
    const unsure = `Use new lock nuts\n${rows.slice(1).join("\n")}\n${values.slice(1).join("\n")}`;
    assert.deepEqual(kept({ torques: right.slice(1) }, unsure).torques, []);
    // Units as column headings: no value has its unit, so none is taken.
    const headed = `TORQUE SPECIFICATIONS\nFastener\nft-lbs\nN·m\nShock Mounting Bolt\n30\n41`;
    assert.deepEqual(kept({ torques: [right[2]] }, headed).torques, []);
  });
});

// The owner's page's TORQUE boxes, each label given as a function so a test
// can wrap it the way a narrow box or OCR does.
const solenoidBoxes = (label: (text: string) => string = (text) => text, keep = [0, 1, 2, 3]) =>
  `${SOLENOID_STEPS}\n${keep.map((i) => `TORQUE\n${label(READING.torques[i].item)}:\n${READING.torques[i].value}`).join("\n")}`;
const wrapLast = (text: string) => text.replace(/ (\S+)$/, "\n$1");
const wrapFirst = (text: string) => text.replace(/^(\S+) /, "$1\n");
const torques = (input: Record<string, unknown>, page: string) => kept(input, page).torques.map((t) => `${t.item}: ${t.value}`);

describe("what a torque is said to be for", () => {
  test("an item may leave out its label's first words, never add a word or leave one out after them", () => {
    // Shortened from the start: still the label.
    assert.deepEqual(
      torques({ torques: [{ item: "solenoid fastener", value: "97 in-lbs (11 N·m)" }, { item: "Cable Fastener", value: "35 in-lbs (4 N·m)" }, { item: "Positive terminal", value: "106 in-lbs (12 N·m)" }] }, SOLENOID_PAGE),
      ["solenoid fastener: 97 in-lbs (11 N·m)", "Cable Fastener: 35 in-lbs (4 N·m)", "Positive terminal: 106 in-lbs (12 N·m)"],
    );
    // Both terminals' boxes are battery terminal fasteners.
    assert.deepEqual(torques({ torques: [{ item: "Battery Terminal Fastener", value: "106 in-lbs (12 N·m)" }] }, SOLENOID_PAGE), []);
    // The cable box on the next page: the solenoid's value isn't the cable fasteners', nor a terminal fastener's.
    const noCable = solenoidBoxes(undefined, [0, 2, 3]);
    const result = kept(
      {
        torques: [
          { item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" },
          { item: "Starter Solenoid Terminal Fastener", value: "97 in-lbs (11 N·m)" },
          { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" },
        ],
        steps: [{ n: 7, text: "7. Torque the starter solenoid cable fasteners to 97 in-lbs (11 N·m)." }],
        notes: ["Starter Solenoid Cable Fastener: 97 in-lbs (11 N·m)"],
      },
      noCable,
    );
    assert.deepEqual(result.torques, [{ item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }]);
    assert.deepEqual([result.steps, result.notes, result.dropped], [[], [], 4]);
    // The solenoid's box on the next page: "Starter Solenoid Fastener" leaves out the cable box's "Cable".
    const noSolenoid = solenoidBoxes(undefined, [1, 2, 3]);
    assert.deepEqual(torques({ torques: [{ item: "Starter Solenoid Fastener", value: "35 in-lbs (4 N·m)" }] }, noSolenoid), []);
    assert.deepEqual(kept({ steps: [{ n: 7, text: "Torque the starter solenoid fastener to 35 in-lbs (4 N·m)." }] }, noSolenoid).steps, []);
    assert.deepEqual(torques({ torques: [{ item: "Cable fastener", value: "35 in-lbs (4 N·m)" }] }, noSolenoid), ["Cable fastener: 35 in-lbs (4 N·m)"]);
    // Only the positive terminal's box on the page: the negative one may be different.
    const positiveOnly = `TORQUE\nBattery Terminal Fastener (Positive):\n106 in-lbs (12 N·m)`;
    assert.deepEqual(torques({ torques: [{ item: "Battery Terminal Fastener", value: "106 in-lbs (12 N·m)" }] }, positiveOnly), []);
    // A starter motor page with one box: a nut the steps name isn't its bolts.
    const motor = `ELECTRICAL
STARTER MOTOR REPLACEMENT
1. Disconnect the battery negative (-) cable.
2. Remove the nut securing the positive cable to the starter motor terminal.
3. Remove the two starter motor mounting bolts.
TORQUE
Starter Motor Mounting Bolts:
18 ft-lbs (24 N·m)`;
    const onMotor = kept(
      {
        torques: [
          { item: "Starter Motor Terminal Nut", value: "18 ft-lbs (24 N·m)" },
          { item: "Starter Motor Mounting Bolts", value: "18 ft-lbs (24 N·m)" },
          { item: "Mounting bolts", value: "18 ft-lbs (24 N·m)" },
        ],
        notes: ["Starter motor terminal nut: 18 ft-lbs (24 N·m)"],
      },
      motor,
    );
    assert.deepEqual(onMotor.torques.map((t) => t.item), ["Starter Motor Mounting Bolts", "Mounting bolts"]);
    assert.deepEqual(onMotor.notes, []);
    // A spec table's rows: "Lower" is the lower bolt's name, not a verb, so "A-Arm Pivot Bolt" is either one's.
    const arms = "FRONT SUSPENSION\nTORQUE SPECIFICATIONS\nUpper A-Arm Pivot Bolt 40 ft-lbs (54 N·m)\nLower A-Arm Pivot Bolt 45 ft-lbs (61 N·m)";
    assert.deepEqual(
      torques({ torques: [{ item: "A-Arm Pivot Bolt", value: "45 ft-lbs (61 N·m)" }, { item: "Lower A-Arm Pivot Bolt", value: "45 ft-lbs (61 N·m)" }] }, arms),
      ["Lower A-Arm Pivot Bolt: 45 ft-lbs (61 N·m)"],
    );
    assert.equal(kept({ steps: [{ n: 1, text: "Torque the lower A-arm pivot bolt to 45 ft-lbs (61 N·m)." }] }, arms).steps.length, 1);
  });

  test("a label wrapped over lines is put back together, and the line it wrapped from still names only what it says", () => {
    const right = READING.torques;
    for (const wrap of [wrapLast, wrapFirst, (text: string) => (text.includes("Cable") ? wrapLast(text) : text), (text: string) => text.replace("Solenoid ", "Solenoid\n")]) {
      const page = solenoidBoxes(wrap);
      assert.deepEqual(kept({ torques: right }, page).torques, right, page);
      assert.deepEqual(kept({ torques: SWAPPED }, page).torques, [], page);
      // The finding's own example on the owner's page with the cable box's label wrapped.
      const wrong = kept(
        {
          torques: [{ item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" }],
          notes: ["Starter Solenoid Cable Fastener: 97 in-lbs (11 N·m)"],
          steps: [{ n: 7, text: "7. Torque the starter solenoid cable fasteners to 97 in-lbs (11 N·m)." }],
        },
        page,
      );
      assert.equal(wrong.dropped, 3, page);
    }
    // A narrow box wraps the terminals' "(Positive):" and "(Negative):" onto lines of their own.
    const terminals = solenoidBoxes((text) => text.replace(" (", "\n("));
    assert.deepEqual(kept({ torques: right }, terminals).torques, right);
    const swapped = kept(
      {
        torques: [
          { item: "Starter Solenoid Positive Cable Fastener", value: "106 in-lbs (12 N·m)" },
          { item: "Starter Solenoid Cable Fastener (Negative)", value: "62 in-lbs (7 N·m)" },
        ],
        notes: ["Positive starter solenoid cable fastener: 106 in-lbs (12 N·m)"],
      },
      terminals,
    );
    assert.deepEqual([swapped.torques, swapped.notes, swapped.dropped], [[], [], 3]);
    // A brake page: the front caliper's label wrapped, the rear's value not the front's.
    const brakes = `BRAKES
FRONT BRAKE CALIPER REPLACEMENT
1. Remove the brake line banjo bolt and sealing washers.
TORQUE
Front Brake Caliper
Mounting Bolts:
30 ft-lbs (41 N·m)
TORQUE
Rear Caliper Mounting Bolts:
25 ft-lbs (34 N·m)
TORQUE
Brake Line Banjo Bolt:
15 ft-lbs (20 N·m)`;
    const front = (value: string) => ({ item: "Front Brake Caliper Mounting Bolts", value });
    assert.deepEqual(torques({ torques: [front("30 ft-lbs (41 N·m)"), front("25 ft-lbs (34 N·m)")] }, brakes), ["Front Brake Caliper Mounting Bolts: 30 ft-lbs (41 N·m)"]);
    assert.deepEqual(kept({ notes: ["Front Brake Caliper Mounting Bolts: 25 ft-lbs (34 N·m)"] }, brakes).notes, []);
    // Which caliper's? Both boxes have caliper mounting bolts.
    assert.deepEqual(torques({ torques: [{ item: "Caliper Mounting Bolts", value: "30 ft-lbs (41 N·m)" }, { item: "Caliper Mounting Bolts", value: "25 ft-lbs (34 N·m)" }] }, brakes), []);
    // The same as a spec table read row by row, the first row's label wrapped.
    const rows = "TORQUE SPECIFICATIONS\nFASTENER TORQUE\nFront Brake Caliper\nMounting Bolts 30 ft-lbs (41 N·m)\nRear Caliper Mounting Bolts 25 ft-lbs (34 N·m)";
    assert.deepEqual(torques({ torques: [front("30 ft-lbs (41 N·m)"), front("25 ft-lbs (34 N·m)")] }, rows), ["Front Brake Caliper Mounting Bolts: 30 ft-lbs (41 N·m)"]);
    // A table's group heading above its rows: "Wheel Nuts" alone says neither which wheels nor which value.
    const wheels = "WHEELS AND TIRES\nTORQUE SPECIFICATIONS\nWheel Nuts\nSteel Wheels 30 ft-lbs (41 N·m)\nAluminum Wheels 90 ft-lbs (122 N·m)";
    assert.deepEqual(
      torques({ torques: [{ item: "Wheel Nuts", value: "30 ft-lbs (41 N·m)" }, { item: "Steel Wheels", value: "30 ft-lbs (41 N·m)" }, { item: "Aluminum Wheel Nuts", value: "30 ft-lbs (41 N·m)" }] }, wheels),
      ["Steel Wheels: 30 ft-lbs (41 N·m)"],
    );
    // A line above a box that says some of its words again isn't the same label wrapped.
    const repeated = "TORQUE\nStarter Solenoid Cable\nStarter Solenoid Fastener:\n97 in-lbs (11 N·m)";
    assert.deepEqual(
      torques({ torques: [{ item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" }, { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }] }, repeated),
      ["Starter Solenoid Fastener: 97 in-lbs (11 N·m)"],
    );
    // A spec table read column by column, "(Rear)" a row of its own under "(Front)".
    const arms = "REAR SUSPENSION\nTORQUE SPECIFICATIONS\nFASTENER\nTORQUE\nTrailing Arm Pivot Bolt (Front)\n(Rear)\nShock Mounting Bolt\n50 ft-lbs (68 N·m)\n40 ft-lbs (54 N·m)\n30 ft-lbs (41 N·m)";
    const arm = (item: string, value: string) => ({ item, value });
    assert.deepEqual(
      torques(
        {
          torques: [
            arm("Trailing Arm Pivot Bolt (Front)", "50 ft-lbs (68 N·m)"),
            arm("Trailing Arm Pivot Bolt (Rear)", "40 ft-lbs (54 N·m)"),
            arm("Trailing Arm Pivot Bolt (Rear)", "50 ft-lbs (68 N·m)"),
            arm("Trailing Arm Pivot Bolt", "50 ft-lbs (68 N·m)"),
          ],
        },
        arms,
      ),
      ["Trailing Arm Pivot Bolt (Front): 50 ft-lbs (68 N·m)", "Trailing Arm Pivot Bolt (Rear): 40 ft-lbs (54 N·m)"],
    );
    assert.deepEqual(kept({ notes: ["Rear trailing arm pivot bolt: 50 ft-lbs (68 N·m)"] }, arms).notes, []);
  });

  test("in an entry, a torque is for what the clause right before it names, not something named earlier in the sentence", () => {
    const owner = kept(
      {
        steps: [
          { n: 7, text: "7. Install the cables and torque the starter solenoid fasteners to 35 in-lbs (4 N·m)." },
          { n: 7, text: "7. Install the cables and torque the starter solenoid fasteners to 97 in-lbs (11 N·m)." },
          { n: 7, text: "7. Install the starter solenoid to the frame, then install the cable and torque the solenoid fasteners to 35 in-lbs (4 N·m)." },
          { n: 7, text: "7. Install the starter solenoid to the frame, then install the cable and torque the solenoid fasteners to 97 in-lbs (11 N·m)." },
          // What the verb before is done to, when the last has nothing after it.
          { n: 7, text: "Install the cable fasteners at the starter solenoid and tighten to 35 in-lbs (4 N·m)." },
          { n: 7, text: "Install the cable fasteners at the starter solenoid and tighten to 97 in-lbs (11 N·m)." },
          // Two fasteners for one value, or one said not to be: whose is it?
          { n: 7, text: "Torque the starter solenoid fasteners and the cable fasteners to 35 in-lbs (4 N·m)." },
          { n: 7, text: "Torque the solenoid fasteners (not the cable fasteners) to 35 in-lbs (4 N·m)." },
          // Each its own.
          { n: 7, text: "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m) and the cable fasteners to 35 in-lbs (4 N·m)." },
        ],
        notes: ["Reconnect the cable, then tighten the starter solenoid fastener to 35 in-lbs (4 N·m).", "Reconnect the cable, then tighten the starter solenoid fastener to 97 in-lbs (11 N·m)."],
        cautions: ["With the cable removed, torque the starter solenoid fastener to 35 in-lbs (4 N·m)", "With the cable removed, torque the starter solenoid fastener to 97 in-lbs (11 N·m)"],
      },
      SOLENOID_PAGE,
    );
    assert.deepEqual(
      owner.steps.map((step) => step.text),
      [
        "7. Install the cables and torque the starter solenoid fasteners to 97 in-lbs (11 N·m).",
        "7. Install the starter solenoid to the frame, then install the cable and torque the solenoid fasteners to 97 in-lbs (11 N·m).",
        "Install the cable fasteners at the starter solenoid and tighten to 35 in-lbs (4 N·m).",
        "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m) and the cable fasteners to 35 in-lbs (4 N·m).",
      ],
    );
    assert.deepEqual(owner.notes, ["Reconnect the cable, then tighten the starter solenoid fastener to 97 in-lbs (11 N·m)."]);
    assert.deepEqual(owner.cautions, ["With the cable removed, torque the starter solenoid fastener to 97 in-lbs (11 N·m)"]);
    assert.equal(owner.dropped, 7);
    // A brake page: the banjo bolt and brake line named first, the caliper bolts' value wanted.
    const brakes = `BRAKES\nTORQUE\nFront Brake Caliper Mounting Bolts: 30 ft-lbs (41 N·m)\nTORQUE\nBrake Line Banjo Bolt: 15 ft-lbs (20 N·m)\n1. Install the banjo bolt and brake line.\n2. Route the brake line clear of the wheel.\n3. Use new sealing washers.`;
    const onBrakes = kept(
      {
        steps: [
          { n: 4, text: "Install the banjo bolt and brake line, then torque the caliper mounting bolts to 15 ft-lbs (20 N·m)." },
          { n: 4, text: "Install the banjo bolt and brake line, then torque the caliper mounting bolts to 30 ft-lbs (41 N·m)." },
        ],
        notes: ["With new sealing washers on the brake line banjo, torque the caliper mounting bolts to 15 ft-lbs (20 N·m)."],
        cautions: ["Route the brake line banjo clear of the wheel and torque the caliper bolts to 15 ft-lbs (20 N·m)"],
      },
      brakes,
    );
    assert.deepEqual(onBrakes.steps.map((step) => step.text), ["Install the banjo bolt and brake line, then torque the caliper mounting bolts to 30 ft-lbs (41 N·m)."]);
    assert.deepEqual([onBrakes.notes, onBrakes.cautions], [[], []]);
    // A head page: the tensioner named first, the head bolts' value is in the steps.
    const head = "ENGINE\n4. Tighten the cylinder head bolts to 35 ft-lbs (47 N·m).\n5. Torque the cam chain tensioner bolts to 8 ft-lbs (11 N·m).";
    const onHead = kept(
      {
        steps: [
          { n: 6, text: "Lubricate the cam chain tensioner and torque the cylinder head bolts to 8 ft-lbs (11 N·m)." },
          { n: 6, text: "Lubricate the cam chain tensioner and torque the cylinder head bolts to 35 ft-lbs (47 N·m)." },
        ],
      },
      head,
    );
    assert.deepEqual(onHead.steps.map((step) => step.text), ["Lubricate the cam chain tensioner and torque the cylinder head bolts to 35 ft-lbs (47 N·m)."]);
    // A clutch page in ft-lbs only: the inner cover named first, the outer cover bolts are 8.
    const clutch = "DRIVE CLUTCH\nTORQUE\nClutch Cover Bolts:\n8 ft-lbs\nTORQUE\nClutch Inner Cover Bolts:\n12 ft-lbs";
    const onClutch = kept(
      {
        steps: [
          { n: 3, text: "Install the inner cover and torque the clutch cover bolts to 12 ft-lbs." },
          { n: 3, text: "Install the inner cover and torque the clutch cover bolts to 8 ft-lbs." },
        ],
        notes: ["Clutch cover bolts (outer, over the inner cover): 12 ft-lbs", "Clutch inner cover bolts: 12 ft-lbs"],
      },
      clutch,
    );
    assert.deepEqual(onClutch.steps.map((step) => step.text), ["Install the inner cover and torque the clutch cover bolts to 8 ft-lbs."]);
    assert.deepEqual(onClutch.notes, ["Clutch inner cover bolts: 12 ft-lbs"]);
  });

  test("what an entry says after a torque, in any of its sentences, mustn't pass it to another fastener", () => {
    const result = kept(
      {
        notes: [
          "Starter Solenoid Fastener: 97 in-lbs (11 N·m). Use the same torque on the cable fasteners.",
          "Starter Solenoid Fastener: 97 in-lbs (11 N·m). Use the same torque on the remaining fasteners.",
          "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m), and the battery terminal fastener (negative).",
          "Starter Solenoid Fastener: 97 in-lbs (11 N·m). Install the battery access panel.",
          // Said in passing, any box with all its words counts: both terminals'.
          "Starter Solenoid Fastener: 97 in-lbs (11 N·m). Then the terminal fasteners.",
        ],
        steps: [{ n: 7, text: "7. Torque the starter solenoid fasteners to 97 in-lbs (11 N·m). Repeat for the cable fasteners." }],
        cautions: ["Torque the battery terminal fastener (positive) to 106 in-lbs (12 N·m). Do the same for the negative terminal fastener."],
      },
      SOLENOID_PAGE,
    );
    assert.deepEqual(result.notes, ["Starter Solenoid Fastener: 97 in-lbs (11 N·m). Install the battery access panel."]);
    assert.deepEqual([result.steps, result.cautions, result.dropped], [[], [], 6]);
  });

  test("OCR's slips in a torque unit are read as the unit, so the fastener check sees the torque", () => {
    for (const [written, unit] of [
      ["35 ft-1bs", "ftlb"],
      ["35 ft-|bs", "ftlb"],
      ["35 ft-lb5", "ftlb"],
      ["35 in-1bs", "inlb"],
      ["35 1n-lbs", "inlb"],
      ["35 lbf-ft", "ftlb"],
      ["35 ft·lbf", "ftlb"],
      ["35 N-rn", "nm"],
      ["35 Nrn", "nm"],
      ["35 N·rn", "nm"],
      ["35 daN·m", "danm"],
    ]) {
      assert.deepEqual(quantities(specTokens(written)), [["35", unit]], written);
    }
    // "1l N-rn" is 11 N·m, and words with those letters stay words.
    assert.deepEqual(specTokens("97 in-1bs (1l N-rn)"), ["97", "inlb", "11", "nm"]);
    assert.deepEqual(specTokens("turn the inner bolt 1 bolt"), ["turn", "the", "inner", "bolt", "1", "bolt"]);
    // A clutch page in ft-lbs whose OCR read the l of lbs as 1 and |.
    const clutch = "DRIVE CLUTCH\nTORQUE\nDrive Clutch Retaining Bolt:\n40 ft-1bs\nTORQUE\nClutch Cover Bolts:\n8 ft-lbs\nTORQUE\nClutch Inner Cover Bolts:\n12 ft-|bs";
    const onClutch = kept(
      {
        torques: [
          { item: "Drive Clutch Retaining Bolt", value: "40 ft-1bs" },
          { item: "Drive Clutch Retaining Bolt", value: "40 ft-lbs" },
        ],
        notes: ["Clutch Cover Bolts: 40 ft-1bs"],
        steps: [{ n: 2, text: "2. Torque the clutch cover bolts to 12 ft-|bs." }],
      },
      clutch,
    );
    assert.equal(onClutch.torques.length, 2);
    assert.deepEqual([onClutch.notes, onClutch.steps], [[], []]);
    // The owner's page with in-1bs and N-rn: copied as printed, the wrong box's value still drops.
    const ocr = "TORQUE\nStarter Solenoid Fastener:\n97 in-1bs (11 N-rn)\nTORQUE\nStarter Solenoid Cable Fastener:\n35 in-1bs (4 N-rn)";
    const onOcr = kept(
      {
        torques: [{ item: "Starter Solenoid Fastener", value: "97 in-1bs (11 N-rn)" }],
        notes: ["Starter Solenoid Fastener: 35 in-1bs (4 N-rn)"],
        steps: [{ n: 2, text: "2. Torque the starter solenoid fasteners to 35 in-1bs (4 N-rn)." }],
        cautions: ["Torque the starter solenoid cable fasteners to 97 in-1bs (11 N-rn)"],
      },
      ocr,
    );
    assert.equal(onOcr.torques.length, 1);
    assert.deepEqual([onOcr.notes, onOcr.steps, onOcr.cautions], [[], [], []]);
    // A number before what's left of a unit OCR couldn't read is checked as a torque too.
    assert.deepEqual(kept({ notes: ["Starter Solenoid Fastener: 35 ft."] }, SOLENOID_PAGE).notes, []);
  });

  test("a number with no unit where a torque would be gets the fastener check", () => {
    // Units only in the table's heading: no value on the page has its unit, so none is taken anywhere.
    const table = "FRONT SUSPENSION\nTORQUE SPECIFICATIONS\nFASTENER FT-LBS N·M\nUpper A-Arm Pivot Bolt 40 54\nLower A-Arm Pivot Bolt 45 61\nShock Mounting Bolt 30 41";
    const onTable = kept(
      {
        steps: [{ n: 1, text: "Torque the upper a-arm pivot bolt to 45." }],
        notes: ["Upper A-Arm Pivot Bolt torque: 45 (61)", "Upper A-Arm Pivot Bolt: 45 (61)", "Upper A-Arm Pivot Bolt: 40 (54)"],
      },
      table,
    );
    assert.deepEqual([onTable.steps, onTable.notes, onTable.dropped], [[], [], 4]);
    // On the owner's page, the number of the right box passes, another box's doesn't.
    const owner = kept({ steps: [{ n: 7, text: "Torque the starter solenoid fasteners to 97." }, { n: 7, text: "Torque the starter solenoid fasteners to 35." }] }, SOLENOID_PAGE);
    assert.deepEqual(owner.steps.map((step) => step.text), ["Torque the starter solenoid fasteners to 97."]);
    // A number that isn't where a torque would be keeps the on-the-page check.
    const flywheel = "ENGINE\n5. Tighten the flywheel nut to 120 N·m (89 ft-lbs), then an additional 90°.";
    assert.equal(kept({ steps: [{ n: 5, text: "5. Tighten the flywheel nut to 120 N·m (89 ft-lbs), then an additional 90°." }] }, flywheel).steps.length, 1);
  });

  test("the title and a torque's item get the same checks: no torque of their own, every number on the page", () => {
    for (const title of ["Starter Solenoid Fastener: 150 in-lbs (17 N·m)", "Starter Solenoid Cable Fastener: 97 in-lbs (11 N·m)"]) {
      const result = kept({ title, notes: [] }, SOLENOID_PAGE);
      assert.equal(result.title, "", title);
      assert.equal(result.dropped, 1, title);
    }
    assert.equal(kept({ title: "STARTER SOLENOID REPLACEMENT" }, SOLENOID_PAGE).title, "STARTER SOLENOID REPLACEMENT");
    for (const item of ["Starter Solenoid Cable Fastener, max 150 in-lbs (17 N·m)", "Starter Solenoid Cable Fastener (or 97 in-lbs (11 N·m) for the solenoid)", "M10 Starter Solenoid Cable Fastener"]) {
      assert.deepEqual(torques({ torques: [{ item, value: "35 in-lbs (4 N·m)" }] }, SOLENOID_PAGE), [], item);
    }
  });

  test("boxes labelled alike have to agree: a step's value in fewer units does, a second pass doesn't", () => {
    // The step and the box give the wheel nuts 120 ft-lbs, the box its N·m too.
    const wheels = "WHEELS\n1. Install the wheel nuts and torque to 120 ft-lbs.\nTORQUE\nWheel Nuts:\n120 ft-lbs (163 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Wheel Nuts", value: "120 ft-lbs (163 N·m)" }] }, wheels), ["Wheel Nuts: 120 ft-lbs (163 N·m)"]);
    assert.equal(kept({ steps: [{ n: 1, text: "1. Install the wheel nuts and torque to 120 ft-lbs." }] }, wheels).steps.length, 1);
    // Head bolts torqued in two passes, each step naming them alike: which pass is which can't be read
    // from the words, so neither value is taken (the page shows both).
    const head = "ENGINE\n4. Tighten the cylinder head bolts in sequence to 22 ft-lbs (30 N·m).\n5. Tighten the cylinder head bolts in sequence to 35 ft-lbs (47 N·m), then an additional 90°.";
    assert.deepEqual(torques({ torques: [{ item: "Cylinder Head Bolts", value: "22 ft-lbs (30 N·m)" }, { item: "Cylinder Head Bolts", value: "35 ft-lbs (47 N·m)" }] }, head), []);
  });
});

describe("the request and the answer", () => {
  test("one plain request to the reading model: no thinking, a small answer, the strict tool, nothing forced", () => {
    const params = factsRequest({ manualTitle: "2024 RANGER XP 1500 Service Manual", page: 62, text: SOLENOID_PAGE });
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
    const call = { type: "tool_use", id: "toolu_1", name: FACTS_TOOL_NAME, input: READING };
    const thinking = { type: "thinking", thinking: "Reading the page.", signature: "sig" };
    const reply = (content: unknown[], stop: string) => ({ content, stop_reason: stop }) as unknown as Parameters<typeof factsInReply>[0];
    assert.deepEqual(factsInReply(reply([thinking, call], "tool_use")), { input: READING });
    assert.deepEqual(factsInReply(reply([{ type: "text", text: "Here you go." }], "end_turn")), { problem: "no_call" });
    assert.deepEqual(factsInReply(reply([{ ...call, name: "other_tool" }], "tool_use")), { problem: "no_call" });
    assert.deepEqual(factsInReply(reply([call], "max_tokens")), { problem: "max_tokens" });
    assert.deepEqual(factsInReply(reply([], "refusal")), { problem: "refusal" });
  });
});
