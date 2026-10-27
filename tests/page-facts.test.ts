// Reading a manual page once for the part sheet's card: what Claude records
// is checked against the page's own text. A torque is listed only as the
// page prints it, its label then its value in every unit given, and only
// where the page's text leaves no doubt which label a value is printed
// with: on the owner's starter-solenoid page (as its text layer and as OCR
// give it) every box is listed and every other pairing dropped, TORQUE
// boxes side by side, tables read column by column, labels wrapped or
// with a callout above them and values before their labels list nothing
// and say the page has more. Steps, tools, cautions and notes never give a
// torque, in any spelling, and are mostly in the page's words with any
// other number on the page. Every case the earlier pairing let a wrong
// value through is here, dropped. Also the request itself (the model, no
// thinking, the strict tool, nothing forced) and reading the answer. Pure:
// no database.
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

// The owner's own page as they gave it: the Ranger XD 1500's starter
// solenoid service, steps 1 to 7 and a TORQUE box for each of four
// fasteners, then the page's foot.
const OWNER_STEPS = `ELECTRICAL
STARTER SOLENOID SERVICE
STARTER SOLENOID REPLACEMENT
1. Raise dump bed.
2. Remove battery access panel.
3. Disconnect battery positive by loosening the terminal.
4. Disconnect starter solenoid electrical connector.
5. Remove start solenoid cable nuts.
6. Remove starter solenoid by removing fasteners.
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
const OWNER = `${OWNER_STEPS}\n${OWNER_BOXES}\n10.62\n9940020 R01 - 2024 RANGER XD 1500 Service Manual\n© Copyright Polaris Inc.`;
const OWNER_READING = {
  title: "STARTER SOLENOID REPLACEMENT",
  steps: OWNER_STEPS.split("\n")
    .slice(3)
    .map((line) => ({ n: Number(line[0]), text: line.slice(3) })),
  torques: READING.torques,
  tools: [],
  cautions: [],
  notes: [],
};

// What a reading keeps of each list, with nothing else in it.
const kept = (input: Record<string, unknown>, page: string) => {
  const { facts, dropped } = checkFacts({ title: "", steps: [], torques: [], tools: [], cautions: [], notes: [], ...input }, page);
  return { ...facts, dropped };
};
// The card's lines, as the card shows them.
const card = (input: Record<string, unknown>, page: string) => {
  const facts = kept(input, page);
  return [
    ...(facts.title ? [`title ${facts.title}`] : []),
    ...facts.torques.map((t) => `${t.item}: ${t.value}`),
    ...facts.steps.map((s) => `step ${s.text}`),
    ...facts.tools.map((s) => `tool ${s}`),
    ...facts.cautions.map((s) => `caution ${s}`),
    ...facts.notes.map((s) => `note ${s}`),
  ];
};
const torques = (input: Record<string, unknown>, page: string) => kept(input, page).torques.map((t) => `${t.item}: ${t.value}`);
// Each box's value under the next box's fastener, and the other way round.
const SWAPPED = READING.torques.map((t, i, all) => ({ item: t.item, value: all[(i + 1) % all.length].value }));
// Every box's value under every other box's label, in each way of writing it.
const EVERY_WRONG = READING.torques.flatMap((own, i) =>
  READING.torques.flatMap((other, k) => (i === k ? [] : [other.value, other.value.split(" (")[0], other.value.replace(/^.*\((.*)\)$/, "$1")].map((value) => ({ item: own.item, value })))),
);

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
  test("the starter-solenoid page: everything on it is kept as Claude wrote it, and the list has every torque the page prints", () => {
    const { facts, dropped } = checkFacts(READING, SOLENOID_PAGE);
    assert.equal(dropped, 0);
    assert.deepEqual(facts, { ...READING, moreTorques: false });
    assert.ok(hasFacts(facts));
  });

  test("the same page from OCR: misread letters, other dots, Ibs and l06 still check out", () => {
    const { facts, dropped } = checkFacts(READING, SOLENOID_OCR);
    assert.equal(dropped, 0, JSON.stringify(facts));
    assert.equal(facts.torques.length, 4);
    assert.equal(facts.steps.length, 7);
    assert.equal(facts.title, "STARTER SOLENOID REPLACEMENT");
    assert.equal(facts.moreTorques, false);
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
        { item: "Starter Solenoid Cable Fastener", value: "5 in-lbs (4 N·m)" },
        // A decimal the page doesn't have.
        { item: "Starter Solenoid Fastener", value: "9.7 in-lbs (1.1 N·m)" },
      ],
    };
    const { facts, dropped } = checkFacts(made, SOLENOID_PAGE);
    assert.equal(dropped, 5);
    assert.deepEqual(facts.torques, READING.torques);
  });

  test("a value in every unit the page gives it: another order or spelling still counts, one unit alone doesn't", () => {
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "11 N·m (97 in-lbs)")), ["11 N·m (97 in-lbs)"]);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in. lb. (11 Nm)")), ["97 in. lb. (11 Nm)"]);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in-lbs / 11 N·m")), ["97 in-lbs / 11 N·m"]);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 in-lbs")), []);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "11 N·m")), []);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97 inch-pounds")), []);
  });

  test("a torque needs a value and the label printed right before it, word for word; it's listed as the page prints it", () => {
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "Hand tight")), []);
    assert.deepEqual(keptTorques(torque("", "97 in-lbs (11 N·m)")), []);
    // An item made up around a real value.
    assert.deepEqual(keptTorques(torque("Rear Differential Drain Plug", "97 in-lbs (11 N·m)")), []);
    // A number with no torque unit isn't a torque.
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "97")), []);
    // Other case, other spaces, the colon: the page's label, shown as the page prints it.
    for (const item of ["starter solenoid fastener", "STARTER SOLENOID FASTENER", "Starter  Solenoid Fastener:", "Starter Solenoid Fastener :"]) {
      assert.deepEqual(torques({ torques: [{ item, value: "97 in-lbs (11 N·m)" }] }, SOLENOID_PAGE), ["Starter Solenoid Fastener: 97 in-lbs (11 N·m)"], item);
    }
    assert.deepEqual(torques({ torques: [{ item: "Battery Terminal Fastener ( positive )", value: "106 in-lbs (12 N·m)" }] }, SOLENOID_PAGE), ["Battery Terminal Fastener (Positive): 106 in-lbs (12 N·m)"]);
    // Shortened, a word added, plural, reordered, the qualifier moved: not the page's label.
    for (const item of [
      "Solenoid Fastener",
      "Cable Fastener",
      "Starter Solenoid",
      "Starter Solenoid Fasteners",
      "Starter Solenoid Mounting Fastener",
      "Solenoid Starter Fastener",
      "Battery Terminal Fastener",
      "Positive Battery Terminal Fastener",
      "Battery Terminal Fastener Positive",
      "Battery Terminal Fastener (+)",
    ]) {
      const value = item.includes("Cable") ? "35 in-lbs (4 N·m)" : item.includes("Battery") ? "106 in-lbs (12 N·m)" : "97 in-lbs (11 N·m)";
      assert.deepEqual(torques({ torques: [{ item, value }] }, SOLENOID_PAGE), [], item);
    }
  });

  test("a torque has to be its own label's: a value from the box beside it is dropped", () => {
    assert.deepEqual(keptTorques(torque("Starter Solenoid Cable Fastener", "97 in-lbs (11 N·m)")), []);
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "35 in-lbs (4 N·m)")), []);
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Positive)", "62 in-lbs (7 N·m)")), []);
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Negative)", "106 in-lbs (12 N·m)")), []);
    // The same from OCR.
    assert.deepEqual(keptTorques(torque("Starter Solenoid Fastener", "35 in-lbs (4 N·m)"), SOLENOID_OCR), []);
    assert.deepEqual(keptTorques(torque("Battery Terminal Fastener (Negative)", "62 in-lbs (7 N·m)"), SOLENOID_OCR), ["62 in-lbs (7 N·m)"]);
  });

  test("steps: shortened or reworded is fine; made up, with a number not on the page, or with a torque in it isn't", () => {
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
      [3],
    );
    // "Install in reverse order of removal" shares too few of its words.
    assert.equal(dropped, 4);
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
      // Nothing listed, so the page's torques are all still on the page.
      assert.deepEqual(facts, { title: "", steps: [], torques: [], tools: [], cautions: [], notes: [], moreTorques: true }, JSON.stringify(input));
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


describe("a torque only as the page prints it: its label, then its value", () => {
  test("the owner's page: all four boxes listed under their labels as printed, and no line saying the page has more", () => {
    const { facts, dropped } = checkFacts(OWNER_READING, OWNER);
    assert.equal(dropped, 0);
    assert.deepEqual(facts, { ...OWNER_READING, moreTorques: false });
    // Claude's own wording of a label isn't what's shown: the page's is.
    const lower = READING.torques.map(({ item, value }) => ({ item: item.toLowerCase(), value }));
    assert.deepEqual(torques({ torques: lower }, OWNER), READING.torques.map((t) => `${t.item}: ${t.value}`));
    // One box left out of the reading: the page has more than the list.
    assert.equal(kept({ torques: READING.torques.slice(1) }, OWNER).moreTorques, true);
  });

  test("the owner's page: every value under every other box's label is dropped", () => {
    for (const page of [OWNER, SOLENOID_PAGE, SOLENOID_OCR]) {
      const result = kept({ torques: [...EVERY_WRONG, ...SWAPPED] }, page);
      assert.deepEqual(result.torques, [], page);
      assert.equal(result.dropped, EVERY_WRONG.length + SWAPPED.length);
    }
  });

  test("the owner's page: a step, note, caution or tool that gives a torque is dropped, the right one too, in any spelling", () => {
    const giving = [
      "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m).",
      "Starter Solenoid Fastener: 97 in-lbs (11 N·m)",
      "Torque the battery terminal fastener (negative) to 62 in-lbs (7 N·m)",
      "Starter solenoid fastener socket, 35 in-lbs (4 N·m)",
      // OCR's spellings and scraps of a unit.
      "Starter Solenoid Fastener: 97 in-1bs (11 N-rn)",
      "Starter Solenoid Fastener: 35 ft.",
      "Tighten starter solenoid fastener 35 in.",
      "Cable fastener: 11 Nmm",
      "Starter Solenoid Fastener: 35 in#",
      "Starter Solenoid Fastener: 35 ins-lbs",
      "Starter Solenoid Fastener: 35 pound-inches",
      "Starter Solenoid Fastener: 35 in-oz",
      "Starter Solenoid Fastener: thirty-five in-lbs",
      // A number a box has, with no unit or what isn't one.
      "Starter solenoid fastener: 35",
      "Starter solenoid fastener 35",
      "Cable fastener = 97",
      "Battery terminal fastener (negative): 106",
      "Starter Solenoid Fastener: 35 (4)",
      "Starter Solenoid Fastener (35)",
    ];
    const talking = [
      // Torquing without a number, or handing a value on.
      "Torque the cable fasteners to specification.",
      "Tighten the battery terminal securely.",
      "Use the same torque on the cable fasteners.",
      "Repeat for the cable fasteners.",
      "The cable fastener too.",
      "Cable fasteners: as above.",
    ];
    const entries = [...giving, ...talking];
    const result = kept({ steps: entries.map((text, i) => ({ n: (i % 7) + 1, text })), notes: entries, cautions: entries, tools: entries }, OWNER);
    assert.deepEqual([result.steps, result.notes, result.cautions, result.tools], [[], [], [], []]);
    assert.equal(result.dropped, entries.length * 4);
    // The page's own steps, with nothing of a torque in them, stay.
    assert.equal(kept({ steps: OWNER_READING.steps }, OWNER).steps.length, 7);
    // A title with a torque in it is blanked; one about torques is a title.
    assert.equal(kept({ title: "STARTER SOLENOID FASTENER: 35" }, OWNER).title, "");
    assert.equal(kept({ title: "TORQUE SPECIFICATIONS" }, `${OWNER}\nTORQUE SPECIFICATIONS`).title, "TORQUE SPECIFICATIONS");
  });

  test("other numbers in an entry only have to be on the page", () => {
    const page = `${OWNER_STEPS}\nNOTE: With the key on, there should be 12 V at pin 13 of the solenoid connector.\nThe terminal gap is 0.7 mm.\n${OWNER_BOXES}`;
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

  test("TORQUE boxes side by side, labels on one line and values on the next: none listed, and the card says the page has more", () => {
    const sides = [
      // All four in a row.
      `${OWNER_STEPS}\nTORQUE TORQUE TORQUE TORQUE\nStarter Solenoid Fastener: Starter Solenoid Cable Fastener: Battery Terminal Fastener (Positive): Battery Terminal Fastener (Negative):\n97 in-lbs (11 N·m) 35 in-lbs (4 N·m) 106 in-lbs (12 N·m) 62 in-lbs (7 N·m)`,
      // Two in a row, two stacked under them.
      `${OWNER_STEPS}\nTORQUE TORQUE\nStarter Solenoid Fastener: Starter Solenoid Cable Fastener:\n97 in-lbs (11 N·m) 35 in-lbs (4 N·m)\nTORQUE\nBattery Terminal Fastener (Positive):\n106 in-lbs (12 N·m)\nTORQUE\nBattery Terminal Fastener (Negative):\n62 in-lbs (7 N·m)`,
      // Labels wrapped, read row by row across both boxes.
      `${OWNER_STEPS}\nTORQUE TORQUE\nStarter Solenoid Starter Solenoid Cable\nFastener: Fastener:\n97 in-lbs (11 N·m) 35 in-lbs (4 N·m)\nTORQUE\nBattery Terminal Fastener (Positive):\n106 in-lbs (12 N·m)\nTORQUE\nBattery Terminal Fastener (Negative):\n62 in-lbs (7 N·m)`,
      // Labels of different heights.
      `${OWNER_STEPS}\nTORQUE TORQUE\nBattery Battery Terminal Fastener (Positive):\nTerminal Fastener (Negative):\n62 in-lbs (7 N·m) 106 in-lbs (12 N·m)`,
      // OCR's spacing.
      `TORQUE    TORQUE\nStarter  Solenoid  Fastener :     Starter Solenoid Cable Fastener :\n97in-lbs(11N·m)      35 in -Ibs ( 4 N • m )`,
      // Each box's second unit on a line of its own.
      `${OWNER_STEPS}\nTORQUE TORQUE\nStarter Solenoid Fastener: Starter Solenoid Cable Fastener:\n97 in-lbs 35 in-lbs\n(11 N·m) (4 N·m)`,
    ];
    for (const page of sides) {
      const result = kept({ torques: [...READING.torques, ...SWAPPED, { item: "Cable Fastener", value: "97 in-lbs (11 N·m)" }] }, page);
      assert.deepEqual(result.torques, [], page);
      assert.equal(result.moreTorques, true, page);
      assert.deepEqual(card({ notes: ["Starter Solenoid Cable Fastener: 97 in-lbs (11 N·m)"], steps: [{ n: 7, text: "Torque the starter solenoid cable fasteners to 97 in-lbs (11 N·m)." }] }, page), [], page);
    }
  });

  test("a box as OCR spaces and misreads it is listed: the label as printed, spaces evened out", () => {
    const ocr = `${OWNER_STEPS}\nTORQUE\nStarter  Solenoid  Fastener :\n97in-lbs(11N·m)\nTORQUE\nStarter Solenoid Cable Fastener :\n35 in -Ibs ( 4 N • m )\nTORQUE\nBattery Terminal Fastener (Positive):\nl06 in-1bs (12 N-rn)\nTORQUE\nBattery Terminal Fastener (Negative):\n62 in-lbs (7 Nm)`;
    assert.deepEqual(torques({ torques: READING.torques }, ocr), READING.torques.map((t) => `${t.item}: ${t.value}`));
    assert.deepEqual(torques({ torques: SWAPPED }, ocr), []);
    // Copied as OCR printed it, the value still is the box's.
    assert.deepEqual(torques({ torques: [{ item: "Battery Terminal Fastener (Positive)", value: "l06 in-1bs (12 N-rn)" }] }, ocr), ["Battery Terminal Fastener (Positive): l06 in-1bs (12 N-rn)"]);
    // A label and its value on one line, and a value's other unit on the next.
    const lines = `TORQUE\nStarter Solenoid Fastener: 97 in-lbs (11 N·m)\nTORQUE\nStarter Solenoid Cable Fastener:\n35 in-lbs\n(4 N·m)`;
    assert.deepEqual(torques({ torques: READING.torques.slice(0, 2) }, lines), READING.torques.slice(0, 2).map((t) => `${t.item}: ${t.value}`));
    assert.deepEqual(torques({ torques: SWAPPED.slice(0, 2) }, lines), []);
  });

  test("a label that may be wrapped, or have a callout or part of it above it: that box isn't listed, the others are", () => {
    const right = READING.torques.map((t) => `${t.item}: ${t.value}`);
    const wrap = (at: number, how: (label: string) => string) => OWNER_BOXES.split("\n").map((line, i) => (i === 1 + at * 3 ? how(line) : line)).join("\n");
    for (const [i, box] of READING.torques.entries()) {
      for (const how of [(label: string) => label.replace(/ (\S+)$/, "\n$1"), (label: string) => label.replace(/^(\S+) /, "$1\n"), (label: string) => `Cable\n${label}`, (label: string) => `STARTER SOLENOID\n${label}`]) {
        const page = `${OWNER_STEPS}\n${wrap(i, how)}`;
        const items = [...READING.torques, { item: `Cable ${box.item}`, value: box.value }, { item: box.item.split(" ").slice(1).join(" "), value: box.value }];
        assert.deepEqual(torques({ torques: items }, page), right.filter((_, k) => k !== i), page);
      }
    }
    // The owner's figure callout over a wrapped label.
    const callout = `${OWNER_STEPS}\nTORQUE\nCable\nStarter Solenoid\nFastener:\n97 in-lbs (11 N·m)`;
    assert.deepEqual(torques({ torques: [{ item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" }, { item: "Cable Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }, { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }] }, callout), []);
    // A part number or a line in capitals right above a label may be part of it ("M8 Flange / Bolt:").
    assert.deepEqual(torques({ torques: [{ item: "Bolt", value: "25 N·m" }] }, "M8 Flange\nBolt:\n25 N·m"), []);
    assert.deepEqual(torques({ torques: [{ item: "Cable Fastener", value: "35 in-lbs (4 N·m)" }] }, "STARTER SOLENOID\nCable Fastener:\n35 in-lbs (4 N·m)"), []);
    assert.deepEqual(torques({ torques: [{ item: "Cable Fastener", value: "35 in-lbs (4 N·m)" }] }, "STARTER SOLENOID\nTORQUE\nCable Fastener:\n35 in-lbs (4 N·m)"), ["Cable Fastener: 35 in-lbs (4 N·m)"]);
  });

  test("a value printed before its label, or with no label, leaves every box near it in doubt: none listed", () => {
    const pages = [
      // The text layer gives each box's value first.
      `${OWNER_STEPS}\n` + READING.torques.map((t) => `TORQUE\n${t.value}\n${t.item}:`).join("\n"),
      // And with no TORQUE headings, and without colons.
      `${OWNER_STEPS}\n` + READING.torques.map((t) => `${t.value}\n${t.item}:`).join("\n"),
      `${OWNER_STEPS}\n` + READING.torques.map((t) => `${t.value}\n${t.item}`).join("\n"),
      // The values row, then the labels row.
      `${OWNER_STEPS}\n97 in-lbs (11 N·m) 35 in-lbs (4 N·m)\nStarter Solenoid Fastener: Starter Solenoid Cable Fastener:\n106 in-lbs (12 N·m) 62 in-lbs (7 N·m)\nBattery Terminal Fastener (Positive): Battery Terminal Fastener (Negative):`,
      // Read column by column: the labels, then the values.
      `${OWNER_STEPS}\nTORQUE\nTORQUE\nStarter Solenoid Fastener:\nStarter Solenoid Cable Fastener:\n97 in-lbs (11 N·m)\n35 in-lbs (4 N·m)`,
      `${OWNER_STEPS}\n` + READING.torques.map((t) => `TORQUE\n${t.item}:`).join("\n") + "\n" + READING.torques.map((t) => t.value).join("\n"),
    ];
    for (const page of pages) {
      const result = kept({ torques: [...READING.torques, ...SWAPPED] }, page);
      assert.deepEqual(result.torques, [], page);
      assert.equal(result.moreTorques, true);
    }
    // OCR lost a box's label: its value isn't the step's above it, nor the box's below.
    const lost = `${OWNER_STEPS.split("\n6.")[0]}\nTORQUE\n97 in-lbs (11 N·m)\n6. Remove starter solenoid by removing fasteners.\n7. Installation is performed by reversing the removal procedure.\n${OWNER_BOXES.split("\n").slice(3).join("\n")}`;
    assert.deepEqual(
      card({ torques: [{ item: "Solenoid Cable Nuts", value: "97 in-lbs (11 N·m)" }, { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }, ...READING.torques.slice(1)], notes: ["Start solenoid cable nuts: 97 in-lbs (11 N·m)"] }, lost),
      READING.torques.slice(1).map((t) => `${t.item}: ${t.value}`),
    );
    const lostLast = "STARTER SOLENOID REPLACEMENT\n5. Remove start solenoid cable nuts.\n6. Remove starter solenoid.\nTORQUE\n35 in-lbs (4 N·m)";
    assert.deepEqual(card({ torques: [{ item: "Starter Solenoid Fastener", value: "35 in-lbs (4 N·m)" }], steps: [{ n: 7, text: "Install the starter solenoid and torque to 35 in-lbs (4 N·m)." }] }, lostLast), []);
    // A value of the run's left on a line of its own with a stray mark: the boxes around it aren't sure either.
    assert.deepEqual(torques({ torques: READING.torques }, `TORQUE\nStarter Solenoid Fastener:\n97 in-lbs (11 N·m)\n35 in-lbs (4 N·m) |\nTORQUE\nBattery Terminal Fastener (Positive):\n106 in-lbs (12 N·m)`), []);
  });

  test("spec tables: rows listed as their labels are printed; read by column, wrapped or with leaders, none; units only in the heading say the page has more", () => {
    const rows = ["Upper A-Arm Pivot Bolt", "Lower A-Arm Pivot Bolt", "Shock Mounting Bolt"];
    const values = ["40 ft-lbs (54 N·m)", "45 ft-lbs (61 N·m)", "30 ft-lbs (41 N·m)"];
    const right = rows.map((item, i) => ({ item, value: values[i] }));
    const wrong = rows.map((item, i) => ({ item, value: values[(i + 1) % 3] }));
    const shownRight = right.map((t) => `${t.item}: ${t.value}`);
    for (const heading of ["TORQUE SPECIFICATIONS\nFASTENER TORQUE", "TORQUE SPECIFICATIONS\nItem Torque", "TORQUE SPECIFICATIONS"]) {
      const table = `FRONT SUSPENSION\n${heading}\n${rows.map((item, i) => `${item} ${values[i]}`).join("\n")}`;
      assert.deepEqual(torques({ torques: [...right, ...wrong] }, table), shownRight, table);
      // "A-Arm Pivot Bolt" is either arm's.
      assert.deepEqual(torques({ torques: [{ item: "A-Arm Pivot Bolt", value: values[1] }, { item: "Pivot Bolt", value: values[0] }] }, table), []);
    }
    for (const table of [
      `TORQUE SPECIFICATIONS\nItem\n${rows.join("\n")}\nTorque\n${values.join("\n")}`,
      `TORQUE SPECIFICATIONS\n${rows.join("\n")}\n${values.join("\n")}`,
      `${rows.map((item) => `${item}:`).join("\n")}\n${values.join("\n")}`,
      `TORQUE SPECIFICATIONS\n${rows.map((item, i) => `${item} .......... ${values[i]}`).join("\n")}`,
      // Labels wrapped before their values, or onto the line after.
      `TORQUE SPECIFICATIONS\n${rows.map((item, i) => `${item.replace(" ", "\n")} ${values[i]}`).join("\n")}`,
      `TORQUE SPECIFICATIONS\n${rows.map((item, i) => `${item.split(" ")[0]} ${values[i]}\n${item.split(" ").slice(1).join(" ")}`).join("\n")}`,
    ]) {
      assert.deepEqual(torques({ torques: [...right, ...wrong, { item: "Upper", value: values[0] }, { item: "Upper A-Arm", value: values[0] }] }, table), [], table);
    }
    // The owner's solenoid table with its labels wrapped under their values.
    const under = `${OWNER_STEPS}\nTORQUE SPECIFICATIONS\nStarter 97 in-lbs (11 N·m)\nSolenoid Fastener\nStarter 35 in-lbs (4 N·m)\nSolenoid Cable Fastener`;
    assert.deepEqual(
      card({ torques: [{ item: "Starter Solenoid Fastener", value: "35 in-lbs (4 N·m)" }, { item: "Starter Solenoid Fastener", value: "35 in-lbs" }, { item: "Starter", value: "97 in-lbs (11 N·m)" }], steps: [{ n: 7, text: "Torque the starter solenoid fastener to 35 in-lbs." }] }, under),
      [],
    );
    // Units only in the heading: no value has a unit of its own, so none is listed, nor a number from it anywhere.
    const headed = `FRONT SUSPENSION\nTORQUE SPECIFICATIONS\nFASTENER FT-LBS N·M\n${rows.map((item, i) => `${item} ${values[i].replace(/ ft-lbs \((\d+) N·m\)/, " $1")}`).join("\n")}`;
    const onHeaded = kept({ torques: right, steps: [{ n: 1, text: "Torque the upper a-arm pivot bolt to 45." }], notes: ["Upper A-Arm Pivot Bolt: 45 (61)", "Upper A-Arm Pivot Bolt: 40 (54)"] }, headed);
    assert.deepEqual([onHeaded.torques, onHeaded.steps, onHeaded.notes, onHeaded.moreTorques], [[], [], [], true]);
  });

  test("a label has to be the page's word for word: qualifiers before or after, symbols and short words tell boxes apart", () => {
    const wheels = "WHEELS\nTORQUE\nSteel Wheel Nuts:\n30 ft-lbs (41 N·m)\nTORQUE\nWheel Nuts (Aluminum):\n90 ft-lbs (122 N·m)";
    assert.deepEqual(card({ torques: [{ item: "Wheel Nuts", value: "30 ft-lbs (41 N·m)" }], steps: [{ n: 3, text: "Torque the wheel nuts to 30 ft-lbs (41 N·m) in a cross pattern." }] }, wheels), []);
    assert.deepEqual(torques({ torques: [{ item: "Steel Wheel Nuts", value: "30 ft-lbs (41 N·m)" }, { item: "Wheel Nuts (Aluminum)", value: "90 ft-lbs (122 N·m)" }] }, wheels), ["Steel Wheel Nuts: 30 ft-lbs (41 N·m)", "Wheel Nuts (Aluminum): 90 ft-lbs (122 N·m)"]);
    const calipers = "BRAKES\nTORQUE\nFront Caliper Mounting Bolt:\n30 ft-lbs (41 N·m)\nTORQUE\nCaliper Mounting Bolt (Rear):\n25 ft-lbs (34 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Caliper Mounting Bolt", value: "30 ft-lbs (41 N·m)" }, { item: "Caliper Mounting Bolt", value: "25 ft-lbs (34 N·m)" }] }, calipers), []);
    const arms = "SUSPENSION\nTORQUE\nUpper A-Arm Pivot Bolt:\n45 ft-lbs (61 N·m)\nTORQUE\nA-Arm Pivot Bolt (Lower):\n40 ft-lbs (54 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Pivot Bolt", value: "45 ft-lbs (61 N·m)" }, { item: "A-Arm Pivot Bolt", value: "45 ft-lbs (61 N·m)" }] }, arms), []);
    // (+) and (-), New and Reused, LH and RH, Pass One and Two, Two- and Four-Bolt.
    const marks = "TORQUE\nBattery Terminal Fastener (+):\n106 in-lbs (12 N·m)\nTORQUE\nAxle Nut (New):\n110 ft-lbs (149 N·m)\nTORQUE\nAxle Nut (Reused):\n80 ft-lbs (108 N·m)\nTORQUE\nRH Footrest Bolt:\n30 ft-lbs (41 N·m)\nTORQUE\nHead Bolt Pass One:\n15 ft-lbs (20 N·m)\nTORQUE\nTwo-Bolt Flange Fastener:\n20 ft-lbs (27 N·m)";
    assert.deepEqual(
      torques(
        {
          torques: [
            { item: "Battery Terminal Fastener (-)", value: "106 in-lbs (12 N·m)" },
            { item: "Axle Nut", value: "110 ft-lbs (149 N·m)" },
            { item: "LH Footrest Bolt", value: "30 ft-lbs (41 N·m)" },
            { item: "Head Bolt Pass Two", value: "15 ft-lbs (20 N·m)" },
            { item: "Four-Bolt Flange Fastener", value: "20 ft-lbs (27 N·m)" },
          ],
        },
        marks,
      ),
      [],
    );
    assert.deepEqual(
      torques({ torques: [{ item: "Battery Terminal Fastener (+)", value: "106 in-lbs (12 N·m)" }, { item: "Axle Nut (New)", value: "110 ft-lbs (149 N·m)" }, { item: "Axle Nut (Reused)", value: "80 ft-lbs (108 N·m)" }, { item: "RH Footrest Bolt", value: "30 ft-lbs (41 N·m)" }] }, marks),
      ["Battery Terminal Fastener (+): 106 in-lbs (12 N·m)", "Axle Nut (New): 110 ft-lbs (149 N·m)", "Axle Nut (Reused): 80 ft-lbs (108 N·m)", "RH Footrest Bolt: 30 ft-lbs (41 N·m)"],
    );
    // Both terminals' boxes, told apart by their sign only: each its own.
    const signs = "TORQUE\nBattery Terminal Fastener (+):\n106 in-lbs (12 N·m)\nTORQUE\nBattery Terminal Fastener (-):\n62 in-lbs (7 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Battery Terminal Fastener (+)", value: "106 in-lbs (12 N·m)" }, { item: "Battery Terminal Fastener (-)", value: "62 in-lbs (7 N·m)" }, { item: "Battery Terminal Fastener (-)", value: "106 in-lbs (12 N·m)" }] }, signs), ["Battery Terminal Fastener (+): 106 in-lbs (12 N·m)", "Battery Terminal Fastener (-): 62 in-lbs (7 N·m)"]);
    // The qualifier first, its other polarity on another page.
    const prefix = "ELECTRICAL\nBATTERY TERMINALS\nTORQUE\nPositive Battery Terminal Fastener:\n106 in-lbs (12 N·m)";
    assert.deepEqual(card({ torques: [{ item: "Battery Terminal Fastener", value: "106 in-lbs (12 N·m)" }], steps: [{ n: 3, text: "Torque the battery terminal fasteners to 106 in-lbs (12 N·m)." }] }, prefix), []);
    assert.deepEqual(torques({ torques: [{ item: "Positive Battery Terminal Fastener", value: "106 in-lbs (12 N·m)" }] }, prefix), ["Positive Battery Terminal Fastener: 106 in-lbs (12 N·m)"]);
    const clutch = "DRIVE CLUTCH\nTORQUE\nDrive Clutch Retaining Bolt (New):\n40 ft-lbs (54 N·m)\nTORQUE\nDrive Clutch Retaining Bolt (Reused):\n35 ft-lbs (47 N·m)";
    assert.deepEqual(card({ torques: [{ item: "Drive Clutch Retaining Bolt", value: "40 ft-lbs (54 N·m)" }], steps: [{ n: 4, text: "Torque the drive clutch retaining bolt to 40 ft-lbs (54 N·m)." }] }, clutch), []);
  });

  test("a label the page also prints with another value, or that a longer label has all of, isn't listed", () => {
    const twice = "FRONT\nTORQUE\nMounting Bolt: 30 ft-lbs (41 N·m)\nREAR\nTORQUE\nMounting Bolt: 30 ft-lbs (41 N·m)\nSKID PLATE\nTORQUE\nMounting Bolt: 8 ft-lbs (11 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Mounting Bolt", value: "30 ft-lbs (41 N·m)" }, { item: "Mounting Bolt", value: "8 ft-lbs (11 N·m)" }] }, twice), []);
    const same = "FRONT\nTORQUE\nMounting Bolt: 30 ft-lbs (41 N·m)\nREAR\nTORQUE\nMounting Bolt: 30 ft-lbs (41 N·m)";
    const onSame = kept({ torques: [{ item: "Mounting Bolt", value: "30 ft-lbs (41 N·m)" }] }, same);
    assert.deepEqual([onSame.torques.length, onSame.moreTorques], [1, false]);
    const nuts = "WHEELS\nTORQUE\nWheel Nuts:\n30 ft-lbs (41 N·m)\nTORQUE\nWheel Nuts (Aluminum):\n90 ft-lbs (122 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Wheel Nuts", value: "30 ft-lbs (41 N·m)" }, { item: "Wheel Nuts (Aluminum)", value: "90 ft-lbs (122 N·m)" }] }, nuts), ["Wheel Nuts (Aluminum): 90 ft-lbs (122 N·m)"]);
    // A label shortened by its wrap or by OCR, beside the whole one of another box.
    const short = "BRAKES\nTORQUE\nMounting Bolt:\n30 ft-lbs (41 N·m)\nTORQUE\nRear Caliper Mounting Bolt:\n25 ft-lbs (34 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Mounting Bolt", value: "30 ft-lbs (41 N·m)" }, { item: "Rear Caliper Mounting Bolt", value: "25 ft-lbs (34 N·m)" }] }, short), ["Rear Caliper Mounting Bolt: 25 ft-lbs (34 N·m)"]);
    const wrapped = "BRAKES\n1. Remove the wheel.\nTORQUE\nFront Caliper\nMounting Bolt:\n30 ft-lbs (41 N·m)\nTORQUE\nCaliper Mounting Bolt:\n25 ft-lbs (34 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Caliper Mounting Bolt", value: "25 ft-lbs (34 N·m)" }, { item: "Mounting Bolt", value: "30 ft-lbs (41 N·m)" }] }, wrapped), []);
    // A step on the page with another value for the same words: which is the box's? The same value is.
    const passes = "ENGINE\n4. Tighten the cylinder head bolts to 22 ft-lbs (30 N·m).\nTORQUE\nCylinder Head Bolts:\n35 ft-lbs (47 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Cylinder Head Bolts", value: "35 ft-lbs (47 N·m)" }] }, passes), []);
    const agreeing = "WHEELS\n1. Install the wheel nuts and torque the wheel nuts to 120 ft-lbs (163 N·m).\nTORQUE\nWheel Nuts:\n120 ft-lbs (163 N·m)";
    assert.deepEqual(torques({ torques: [{ item: "Wheel Nuts", value: "120 ft-lbs (163 N·m)" }] }, agreeing), ["Wheel Nuts: 120 ft-lbs (163 N·m)"]);
  });

  test("a torque list value is only a value, and an item only a label: anything else in either drops it", () => {
    for (const value of [
      "97 in-lbs (11 N·m), also cable fasteners",
      "97 in-lbs (11 N·m); cable fastener 35",
      "Cable fastener: 97 in-lbs (11 N·m)",
      "97 in-lbs (11 N·m) (cable: same)",
      "97 in-lbs (11 N·m), max 106",
      "97 in-lbs then 35 in.",
      "97 in-lbs 35 in-lbs",
      "97 in-lbs (11 N·m) x2",
    ]) {
      assert.deepEqual(torques({ torques: [{ item: "Starter Solenoid Fastener", value }] }, OWNER), [], value);
    }
    for (const value of ["106 in-lbs (12 N·m) both terminals", "negative: 106 in-lbs (12 N·m)"]) {
      assert.deepEqual(torques({ torques: [{ item: "Battery Terminal Fastener (Positive)", value }] }, OWNER), [], value);
    }
    assert.deepEqual(torques({ torques: [{ item: "Battery Terminal Fastener (Negative)", value: "62 in-lbs (7 N·m), not to exceed 106" }] }, OWNER), []);
    const split = "BRAKES\nTORQUE\nFront Caliper Mounting Bolts: 30 ft-lbs\nTORQUE\nRear Caliper Mounting Bolts: 25 N·m";
    assert.deepEqual(torques({ torques: [{ item: "Caliper Mounting Bolts", value: "30 ft-lbs or 25 N·m" }, { item: "Front Caliper Mounting Bolts", value: "30 ft-lbs or 25 N·m" }] }, split), []);
    for (const item of [
      "Starter Solenoid Cable Fastener, then torque the starter solenoid fastener",
      "Negative Terminal: torque the positive terminal fastener",
      "Cable Fastener (use the solenoid fastener value)",
      "All but Starter Solenoid Fastener",
      "Starter Solenoid and All Fasteners",
      "Starter Solenoid Fastener, All Fasteners",
      "Starter Solenoid Fastener & Each Fastener",
      "Starter Solenoid Fastener / Both Fasteners",
      "Starter Solenoid Fastener (and the cable fastener)",
      "Starter Solenoid Fastener: Starter Solenoid Fastener",
      "Starter Solenoid Fastener 97 in-lbs",
    ]) {
      assert.deepEqual(torques({ torques: [{ item, value: "97 in-lbs (11 N·m)" }] }, OWNER), [], item);
    }
  });

  test("the card says the page has more when it prints a torque the list doesn't have, in a step too", () => {
    const step = "ELECTRICAL\nSTARTER SOLENOID REPLACEMENT\n6. Install starter solenoid and cables. Torque fasteners to 97 in-lbs (11 N·m).\nTORQUE\nStarter Solenoid Cable Fastener:\n35 in-lbs (4 N·m)";
    const onStep = kept(
      {
        torques: [
          { item: "Cable Fastener", value: "97 in-lbs (11 N·m)" },
          { item: "Cable Fastener", value: "35 in-lbs (4 N·m)" },
          { item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" },
          { item: "Starter Solenoid Cable Fastener", value: "35 in-lbs (4 N·m)" },
        ],
        steps: [{ n: 6, text: "Install starter solenoid and cables. Torque fasteners to 97 in-lbs (11 N·m)." }, { n: 6, text: "Torque the cable fasteners to 97 in-lbs (11 N·m)." }],
      },
      step,
    );
    assert.deepEqual(onStep.torques, [{ item: "Starter Solenoid Cable Fastener", value: "35 in-lbs (4 N·m)" }]);
    assert.deepEqual([onStep.steps, onStep.moreTorques, onStep.dropped], [[], true, 5]);
    // Every value the page prints listed: nothing more.
    assert.equal(kept({ torques: READING.torques }, SOLENOID_PAGE).moreTorques, false);
    // A page with no torque at all.
    assert.equal(kept({ steps: [{ n: 1, text: "Raise dump bed." }] }, OWNER_STEPS).moreTorques, false);
  });
});

// Every case the label pairing let a wrong value through, on the owner's
// page unless it says otherwise: the card has none of it (only what was
// right in the same reading, where there was some).
const step = (text: string, n = 7) => ({ n, text });
const HEAD = OWNER_STEPS;
const CASES: { name: string; page?: string; input: Record<string, unknown>; card?: string[] }[] = [
  {
    name: "another box's number with no unit, or a unit the rules didn't read",
    input: {
      notes: ["Starter solenoid fastener: 35", "Battery terminal fastener (negative): 106", "Cable fastener: 97 in.", "Cable fastener: 11 Nmm"],
      tools: ["Cable fastener = 97"],
      steps: [step("Starter solenoid fastener 35")],
    },
  },
  {
    name: "side-by-side boxes with labels of different heights",
    page: `${HEAD}\nTORQUE TORQUE\nBattery Battery Terminal Fastener (Positive):\nTerminal Fastener (Negative):\n62 in-lbs (7 N·m) 106 in-lbs (12 N·m)`,
    input: { torques: [{ item: "Battery Terminal Fastener (Positive)", value: "62 in-lbs (7 N·m)" }, { item: "Battery Terminal Fastener (Positive)", value: "106 in-lbs (12 N·m)" }] },
  },
  {
    name: "side-by-side boxes with wrapped labels, the first row joined onto the left box",
    page: `${HEAD}\nTORQUE TORQUE\nStarter Solenoid Starter Solenoid Cable\nFastener: Fastener:\n97 in-lbs (11 N·m) 35 in-lbs (4 N·m)`,
    input: { torques: [{ item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" }, { item: "Cable Fastener", value: "97 in-lbs (11 N·m)" }] },
  },
  {
    name: "a spec table whose label wraps under its value",
    page: `${HEAD}\nTORQUE SPECIFICATIONS\nStarter 97 in-lbs (11 N·m)\nSolenoid Fastener\nStarter 35 in-lbs (4 N·m)\nSolenoid Cable Fastener`,
    input: { torques: [{ item: "Starter Solenoid Fastener", value: "35 in-lbs (4 N·m)" }, { item: "Starter Solenoid Fastener", value: "35 in-lbs" }], steps: [step("Torque the starter solenoid fastener to 35 in-lbs.")] },
  },
  {
    name: "a pass-on after the value in words the rules didn't list",
    input: {
      steps: [
        step("Torque the starter solenoid fastener to 97 in-lbs (11 N·m), as well as the cable fastener."),
        step("Torque the starter solenoid fastener to 97 in-lbs (11 N·m). Starter solenoid cable fastener too."),
        step("Torque the starter solenoid fastener to 97 in-lbs (11 N·m), including the starter solenoid cable fastener."),
        step("Torque the starter solenoid fastener to 97 in-lbs (11 N·m). The starter solenoid cable fastener takes this torque too."),
        step("Torque the starter solenoid fastener to 97 in-lbs (11 N·m). Torque the starter solenoid cable fastener equally."),
        step("Torque the positive terminal fastener to 106 in-lbs (12 N·m). Negative terminal fastener too."),
      ],
      notes: ["Starter solenoid fastener: 97 in-lbs (11 N·m) (applies to starter solenoid cable fastener too)"],
      cautions: ["Torque the starter solenoid fastener to 97 in-lbs (11 N·m). Starter solenoid cable fastener too."],
    },
  },
  {
    name: "a hand-on after the value: paraphrases, and a word more in what it's handed to",
    input: {
      notes: [
        "Starter Solenoid Fastener: 97 in-lbs (11 N·m). Use this value for the cable nuts.",
        "Starter Solenoid Fastener: 97 in-lbs (11 N·m). The cable fastener too.",
        "Starter Solenoid Fastener: 97 in-lbs (11 N·m). Torque the cable fastener as above.",
        "Starter Solenoid Fastener: 97 in-lbs (11 N·m). Torque the cable fastener identically.",
        "Starter Solenoid Fastener: 97 in-lbs (11 N·m). This applies to the cable nuts.",
        "Starter Solenoid Fastener: 97 in-lbs (11 N·m). Matches the cable fasteners.",
        "Starter solenoid fasteners: 97 in-lbs (11 N·m), cable nuts too",
      ],
      steps: [
        step("Torque the starter solenoid fasteners to 97 in-lbs (11 N·m), and the cable nuts as well."),
        step("Torque the starter solenoid fasteners to 97 in-lbs (11 N·m), then the cable nuts."),
        step("Torque the starter solenoid fasteners to 97 in-lbs (11 N·m), cable nuts included."),
        step("Torque the starter solenoid fasteners to 97 in-lbs (11 N·m) for the cable nuts."),
        step("Torque the starter solenoid fasteners to 97 in-lbs (11 N·m) and the negative terminal bolt."),
        step("Torque the battery terminal fastener (positive) to 106 in-lbs (12 N·m). Negative as well."),
        step("Torque the battery terminal fastener (positive) to 106 in-lbs (12 N·m), then the negative side."),
        step("Torque the battery terminal fastener (positive) to 106 in-lbs (12 N·m). The negative terminal gets this too."),
        step("Torque the battery terminal fastener (positive) to 106 in-lbs (12 N·m). Both sides."),
        step("Torque the battery terminal fastener (positive) to 106 in-lbs (12 N·m). Either terminal."),
      ],
    },
  },
  {
    name: "what comes before the item in an entry: a lead-in, an earlier sentence, an earlier label",
    input: {
      steps: [step("For the cable fastener, torque the starter solenoid to 97 in-lbs (11 N·m)."), step("For the cable fasteners, torque the starter solenoid fasteners to 97 in-lbs (11 N·m).")],
      notes: [
        "Starter solenoid cable fastener: torque the starter solenoid fastener to 97 in-lbs (11 N·m).",
        "The cable fastener uses the same torque. Torque the starter solenoid fastener to 97 in-lbs (11 N·m).",
        "Both battery terminals: torque the positive terminal fastener to 106 in-lbs (12 N·m).",
        "Cable fasteners use the same. Starter Solenoid Fastener: 97 in-lbs (11 N·m).",
        "Cable nuts: same as the solenoid. Starter Solenoid Fastener: 97 in-lbs (11 N·m).",
        "Starter Solenoid Cable Fastener: Starter Solenoid Fastener: 97 in-lbs (11 N·m)",
      ],
    },
  },
  { name: "a list inside brackets", input: { steps: [step("Torque the starter solenoid fastener (and the cable fastener) to 35 in-lbs (4 N·m).")] } },
  {
    name: "a torque item with a clause in it",
    input: {
      torques: [
        { item: "Starter Solenoid Cable Fastener, then torque the starter solenoid fastener", value: "97 in-lbs (11 N·m)" },
        { item: "Negative Terminal: torque the positive terminal fastener", value: "106 in-lbs (12 N·m)" },
        { item: "Cable Fastener (use the solenoid fastener value)", value: "97 in-lbs (11 N·m)" },
      ],
    },
  },
  {
    name: "words in a torque's value",
    input: {
      torques: [
        { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m), also cable fasteners" },
        { item: "Starter Solenoid Fastener", value: "Cable fastener: 97 in-lbs (11 N·m)" },
        { item: "Battery Terminal Fastener (Positive)", value: "106 in-lbs (12 N·m) both terminals" },
        { item: "Battery Terminal Fastener (Positive)", value: "negative: 106 in-lbs (12 N·m)" },
        { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m); cable fastener 35" },
        { item: "Battery Terminal Fastener (Negative)", value: "62 in-lbs (7 N·m), not to exceed 106" },
      ],
    },
  },
  {
    name: "a two-column page that OCR read across both columns",
    page: "STARTER SOLENOID REPLACEMENT\n1. Raise dump bed. TORQUE\n2. Remove battery access panel. Starter Solenoid Fastener:\n3. Disconnect battery positive by 97 in-lbs (11 N·m)\nloosening the terminal. TORQUE",
    input: {
      torques: ["Battery Positive", "Terminal Fastener", "Electrical Connector", "Battery Access Panel", "Starter Solenoid Fastener"].map((item) => ({ item, value: "97 in-lbs (11 N·m)" })),
      steps: [step("Torque the terminal fastener to 97 in-lbs.")],
    },
  },
  {
    name: "a qualifier at the front of one label and at the end of the other",
    page: "WHEELS\nTORQUE\nSteel Wheel Nuts:\n30 ft-lbs (41 N·m)\nTORQUE\nWheel Nuts (Aluminum):\n90 ft-lbs (122 N·m)",
    input: { torques: [{ item: "Wheel Nuts", value: "30 ft-lbs (41 N·m)" }], steps: [step("Torque the wheel nuts to 30 ft-lbs (41 N·m) in a cross pattern.", 3)] },
  },
  {
    name: "(+) and (-), LH and RH, New, One and Two",
    page: "TORQUE\nBattery Terminal Fastener (+):\n106 in-lbs (12 N·m)\nTORQUE\nAxle Nut (New):\n110 ft-lbs (149 N·m)\nTORQUE\nAxle Nut (Reused):\n80 ft-lbs (108 N·m)\nTORQUE\nRH Footrest Bolt:\n30 ft-lbs (41 N·m)\nTORQUE\nHead Bolt Pass One:\n15 ft-lbs (20 N·m)",
    input: {
      torques: [
        { item: "Battery Terminal Fastener (-)", value: "106 in-lbs (12 N·m)" },
        { item: "Axle Nut", value: "110 ft-lbs (149 N·m)" },
        { item: "LH Footrest Bolt", value: "30 ft-lbs (41 N·m)" },
        { item: "Head Bolt Pass Two", value: "15 ft-lbs (20 N·m)" },
      ],
    },
  },
  {
    name: "a wrapped label with no TORQUE heading, shortened in the item",
    page: "BRAKES\n1. Remove the wheel.\nFront Caliper\nMounting Bolt:\n30 ft-lbs (41 N·m)\nRear Caliper Mounting Bolt:\n25 ft-lbs (34 N·m)",
    input: { torques: [{ item: "Caliper Mounting Bolt", value: "25 ft-lbs (34 N·m)" }, { item: "Mounting Bolt", value: "30 ft-lbs (41 N·m)" }] },
  },
  {
    name: "the same with the A-arm's Upper wrapped",
    page: "SUSPENSION\n1. Remove the wheel.\nUpper\nA-Arm Pivot Bolt:\n45 ft-lbs (61 N·m)\nLower A-Arm Pivot Bolt:\n40 ft-lbs (54 N·m)",
    input: { torques: [{ item: "A-Arm Pivot Bolt", value: "45 ft-lbs (61 N·m)" }] },
  },
  {
    name: "each value printed before its label",
    page: `${HEAD}\n` + READING.torques.map((t) => `TORQUE\n${t.value}\n${t.item}:`).join("\n"),
    input: { torques: [{ item: "Starter Solenoid Fastener", value: "35 in-lbs (4 N·m)" }, { item: "Battery Terminal Fastener (Positive)", value: "62 in-lbs (7 N·m)" }, { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }] },
  },
  {
    name: "a figure callout over a wrapped label",
    page: `${HEAD}\nTORQUE\nCable\nStarter Solenoid\nFastener:\n97 in-lbs (11 N·m)`,
    input: { torques: [{ item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" }] },
  },
  { name: "an N·m number given bare", input: { steps: [step("Torque the starter solenoid fasteners to 11."), step("Torque the cable fasteners to 4.")] } },
  {
    name: "a lost label: the value paired with the step above, across the TORQUE heading",
    page: "STARTER SOLENOID REPLACEMENT\n5. Remove start solenoid cable nuts.\n6. Remove starter solenoid.\nTORQUE\n35 in-lbs (4 N·m)",
    input: { torques: [{ item: "Starter Solenoid Fastener", value: "35 in-lbs (4 N·m)" }], steps: [step("Install the starter solenoid and torque to 35 in-lbs (4 N·m).")] },
  },
  {
    name: "side-by-side wrapped boxes over stacked ones: the owner's own failure",
    page: `${HEAD}\nTORQUE TORQUE\nStarter Solenoid Starter Solenoid Cable\nFastener: Fastener:\n97 in-lbs (11 N·m) 35 in-lbs (4 N·m)\nTORQUE\nBattery Terminal Fastener (Positive):\n106 in-lbs (12 N·m)\nTORQUE\nBattery Terminal Fastener (Negative):\n62 in-lbs (7 N·m)`,
    input: {
      torques: [
        { item: "Starter Solenoid Cable Fastener", value: "97 in-lbs (11 N·m)" },
        { item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" },
        { item: "Starter Solenoid Cable Fastener", value: "35 in-lbs (4 N·m)" },
      ],
      notes: ["Starter Solenoid Cable Fastener: 97 in-lbs (11 N·m)"],
      steps: [step("Torque the starter solenoid cable fasteners to 97 in-lbs (11 N·m).")],
    },
  },
  {
    name: "a box whose label OCR lost, under step 5's cable nuts",
    page: `${HEAD.split("\n6.")[0]}\nTORQUE\n97 in-lbs (11 N·m)\n6. Remove starter solenoid by removing fasteners.\n7. Installation is performed by reversing the removal procedure.\n${OWNER_BOXES.split("\n").slice(3).join("\n")}`,
    input: { torques: [{ item: "Solenoid Cable Nuts", value: "97 in-lbs (11 N·m)" }, { item: "Cable Nuts", value: "97 in-lbs (11 N·m)" }], notes: ["Start solenoid cable nuts: 97 in-lbs (11 N·m)"] },
  },
  {
    name: "a box made of a page's step picked over the TORQUE box",
    page: "ELECTRICAL\nSTARTER SOLENOID REPLACEMENT\n6. Install starter solenoid and cables. Torque fasteners to 97 in-lbs (11 N·m).\nTORQUE\nStarter Solenoid Cable Fastener:\n35 in-lbs (4 N·m)",
    input: { torques: [{ item: "Cable Fastener", value: "97 in-lbs (11 N·m)" }, { item: "Cables", value: "97 in-lbs (11 N·m)" }], steps: [step("Torque the cable fasteners to 97 in-lbs (11 N·m).", 6)] },
  },
  {
    name: "'but' meaning except",
    input: {
      torques: [{ item: "All but Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }, { item: "All Fasteners but Starter Solenoid Cable Fastener", value: "35 in-lbs (4 N·m)" }],
      steps: [step("Torque all but the starter solenoid fastener to 97 in-lbs (11 N·m)."), step("Torque every fastener but the starter solenoid cable fastener to 35 in-lbs (4 N·m).")],
      notes: ["Torque each fastener but the battery terminal fastener (positive) to 106 in-lbs (12 N·m)."],
    },
  },
  {
    name: "a part of a list that names nothing",
    input: {
      torques: ["Starter Solenoid and All Fasteners", "Starter Solenoid Fastener, All Fasteners", "Starter Solenoid Fastener & Each Fastener", "Starter Solenoid Fastener / Both Fasteners"]
        .map((item) => ({ item, value: "97 in-lbs (11 N·m)" }))
        .concat([{ item: "Battery Terminal Fastener (Positive) & Each", value: "106 in-lbs (12 N·m)" }]),
      steps: [step("Torque each fastener and the starter solenoid fastener to 97 in-lbs (11 N·m)."), step("Torque the starter solenoid fastener to 97 in-lbs (11 N·m), and all fasteners.")],
      notes: ["Starter solenoid fastener and every fastener: 97 in-lbs (11 N·m)"],
    },
  },
  {
    name: "a hand-on across entries (the torque list's own line stays)",
    input: {
      torques: [{ item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }, { item: "Battery Terminal Fastener (Positive)", value: "106 in-lbs (12 N·m)" }],
      steps: [step("Torque the starter solenoid fasteners to 97 in-lbs (11 N·m)."), step("Repeat for the cable fasteners.", 8), step("Torque the cable fasteners to the same torque as the starter solenoid fasteners.", 8)],
      notes: ["Cable fasteners: same torque as the starter solenoid fastener.", "Starter Solenoid Fastener: 97 in-lbs (11 N·m).", "Use the same torque on the cable fasteners."],
      cautions: ["Torque the negative terminal fastener the same as the positive."],
    },
    card: ["Starter Solenoid Fastener: 97 in-lbs (11 N·m)", "Battery Terminal Fastener (Positive): 106 in-lbs (12 N·m)"],
  },
  {
    name: "bare numbers and unit spellings, in every kind of entry and the title",
    input: {
      title: "STARTER SOLENOID FASTENER: 35",
      notes: [
        "Starter Solenoid Fastener: 35",
        "Starter Solenoid Fastener 35",
        "Starter Solenoid Fastener = 35",
        "Starter Solenoid Fastener - 35",
        "Starter Solenoid Fastener torque 35",
        "Starter Solenoid Fastener torque is 35",
        "Starter Solenoid Fastener: 35 (4)",
        "Starter Solenoid Fastener (in-lbs): 35",
        "Starter Solenoid Fastener: 35 pound-inches",
        "Starter Solenoid Fastener: 35 in-oz",
        "Starter Solenoid Fastener: 35 in#",
        "Starter Solenoid Fastener: 35 ins-lbs",
        "Starter Solenoid Fastener: thirty-five in-lbs",
      ],
      steps: [
        step("Torque the starter solenoid fastener (35)."),
        step("Torque the starter solenoid fastener at 35."),
        step("Torque the starter solenoid fastener, 35."),
        step("Tighten starter solenoid fastener 35 in."),
        step("Torquing the starter solenoid fastener to 35."),
        step("Tightening the starter solenoid fastener to 35."),
        step("Snug the starter solenoid fastener to 35."),
        step("Torque value for the starter solenoid fastener is 35."),
      ],
      tools: ["Inch-pound torque wrench: starter solenoid fastener 35"],
    },
  },
  {
    name: "a qualifier at the front of the only label",
    page: "ELECTRICAL\nBATTERY TERMINALS\nTORQUE\nPositive Battery Terminal Fastener:\n106 in-lbs (12 N·m)",
    input: { torques: [{ item: "Battery Terminal Fastener", value: "106 in-lbs (12 N·m)" }], steps: [step("Torque the battery terminal fasteners to 106 in-lbs (12 N·m).", 3)] },
  },
  {
    name: "the same for the upper A-arm alone",
    page: "SUSPENSION\nTORQUE\nUpper A-Arm Pivot Bolt:\n45 ft-lbs (61 N·m)",
    input: { torques: [{ item: "A-Arm Pivot Bolt", value: "45 ft-lbs (61 N·m)" }, { item: "Pivot Bolt", value: "45 ft-lbs (61 N·m)" }] },
  },
  {
    name: "New and Reused, Two- and Four-Bolt",
    page: "DRIVE CLUTCH\nTORQUE\nDrive Clutch Retaining Bolt (New):\n40 ft-lbs (54 N·m)\nTORQUE\nDrive Clutch Retaining Bolt (Reused):\n35 ft-lbs (47 N·m)\nTORQUE\nTwo-Bolt Flange Fastener:\n20 ft-lbs (27 N·m)",
    input: { torques: [{ item: "Drive Clutch Retaining Bolt", value: "40 ft-lbs (54 N·m)" }, { item: "Four-Bolt Flange Fastener", value: "20 ft-lbs (27 N·m)" }], steps: [step("Torque the drive clutch retaining bolt to 40 ft-lbs (54 N·m).", 4)] },
  },
  {
    name: "several boxes that fit, in different units",
    page: "BRAKES\nTORQUE\nFront Caliper Mounting Bolts: 30 ft-lbs\nTORQUE\nRear Caliper Mounting Bolts: 25 N·m",
    input: { torques: [{ item: "Caliper Mounting Bolts", value: "30 ft-lbs or 25 N·m" }] },
  },
];

describe("the cases the label pairing let a wrong value through", () => {
  for (const { name, page = OWNER, input, card: right = [] } of CASES) {
    test(name, () => {
      assert.deepEqual(card(input, page), right);
    });
  }
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
