// Reading a manual page once for the part sheet's card: what Claude records
// is checked against the page's own text (torque values as written, with
// their units and close together, and the value of the box labelled like
// their item; steps, tools, cautions and notes mostly in the page's words,
// any number in them on the page, and any torque in them beside the
// fastener the page gives it for), on realistic Polaris page text from the
// text layer and from OCR, with TORQUE boxes stacked and side by side and
// spec tables read row by row and column by column. Also the request
// itself (the model, no thinking, the strict tool, nothing forced) and
// reading the answer. Pure: no database.
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

  test("the box's label: on the line above or before it, one word read with the box above, a step's own words", () => {
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
          tools: ["Starter solenoid fastener socket, 35 in-lbs (4 N·m)", "Battery terminal fastener (positive) socket, 106 in-lbs (12 N·m)"],
        },
        page,
      );
      assert.deepEqual(result.steps, [{ n: 6, text: "Torque the solenoid fasteners to 97 in-lbs (11 N·m)." }]);
      assert.deepEqual(result.notes, ["Starter Solenoid Fastener: 97 in-lbs (11 N·m)"]);
      assert.deepEqual(result.cautions, ["Torque the battery terminal fastener (negative) to 62 in-lbs (7 N·m)"]);
      assert.deepEqual(result.tools, ["Battery terminal fastener (positive) socket, 106 in-lbs (12 N·m)"]);
      assert.equal(result.dropped, 4);
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
