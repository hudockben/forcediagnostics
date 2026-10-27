// Reading a manual page once for the part sheet's card: what Claude records
// is checked against the page's own text, and nothing on the card says
// anything of a torque. On the owner's starter-solenoid page the card has
// the procedure's title, steps 1 to 7 as the page words them, no tools, and
// the line saying the page has torque specs; every way a torque reached the
// card in earlier checks (a value, a number with no unit or in words, a unit
// as OCR misreads it, wording that hands one fastener's value to another,
// "Torque the cable fastener to 97…", two columns read across, values
// before their labels, a table row wrapped under its value) is dropped
// from the title, the steps, the tools and the cautions. A page without
// torque specs has no such line, and its numbers only have to be on it. A
// card saved in an earlier shape (a torque list, notes) is read without
// them. Also the request itself (the model, no thinking, the strict tool
// with no torques, nothing forced) and reading the answer. Pure: no
// database.
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
2. Measure the resistance between pins 1 and 2: 0.2 to 0.4 ohms.
3. Measure from each pin to ground: there should be no continuity.
4. Replace the stator if a reading is out of range.`;
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
// An entry in every list, and as a heading the page prints in the title.
function everywhere(entry: string, page: string) {
  const heading = entry.replace(/[.:]$/, "").toUpperCase();
  return [...card({ steps: [{ n: 8, text: entry }], tools: [entry], cautions: [entry] }, page), ...card({ title: heading }, `${page}\n${heading}`)];
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
  "words for torquing or tightening, with no number": [
    "Torque the starter solenoid cable fasteners to specification.",
    "Torque the cable fastener to the starter solenoid fastener's.",
    "Retorque the battery terminal fasteners.",
    "Re-torque the battery terminal fasteners.",
    "Tighten the battery terminal securely.",
    "Install the cable nuts hand-tight.",
    "Snug the starter solenoid fasteners.",
    "Install the torqued starter solenoid fasteners.",
  ],
};

describe("nothing on the card says anything of a torque", () => {
  for (const [kind, entries] of Object.entries(LEAKS)) {
    test(`${kind}: dropped from the steps, tools, cautions and title, and counted`, () => {
      for (const entry of entries) {
        for (const page of [OWNER, OWNER_OCR]) assert.deepEqual(everywhere(entry, page), [], entry);
        const result = kept({ steps: [{ n: 8, text: entry }], tools: [entry], cautions: [entry] }, OWNER);
        assert.equal(result.dropped, 3, entry);
      }
    });
  }

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

  test("on a page with torque specs no number stays but one in another unit, a callout or a part number", () => {
    const page = `${OWNER_STEPS}
With the key on, there should be 12 V at pin 13 of the solenoid connector.
The terminal gap is 0.7 mm.
Use Battery Terminal Wrench PU-50964.
${OWNER_BOXES}`;
    const result = kept(
      {
        steps: [
          { n: 1, text: "With the key on, there should be 12 V at the solenoid connector." },
          { n: 2, text: "With the key on, there should be 12 V at pin 13 of the solenoid connector." },
          { n: 3, text: "The terminal gap is 0.7 mm." },
          { n: 4, text: "The terminal gap is 0.8 mm." },
          { n: 5, text: "Remove start solenoid cable nuts ②." },
          { n: 6, text: "Remove start solenoid cable nuts (2)." },
        ],
        tools: ["Battery Terminal Wrench PU-50964", "Battery Terminal Wrench PU-50965", "Battery Terminal Wrench PU 50964", "Battery Terminal Wrench"],
      },
      page,
    );
    assert.deepEqual(
      result.steps.map((step) => step.n),
      [1, 3, 5],
    );
    assert.deepEqual(result.tools, ["Battery Terminal Wrench PU-50964", "Battery Terminal Wrench"]);
    assert.equal(result.dropped, 5);
  });
});

describe("a page without torque specs", () => {
  test("no torque line; numbers only have to be on the page; tools need their part numbers exactly as printed", () => {
    const { facts, dropped } = checkFacts(
      {
        ...STATOR_READING,
        steps: [...STATOR_READING.steps, { n: 5, text: "Measure the resistance between pins 1 and 6: 0.2 to 0.4 ohms." }],
        tools: [...STATOR_READING.tools, "Digital Multimeter PU-50639", "Digital Multimeter PU 50638"],
        cautions: [...STATOR_READING.cautions, "Wear eye protection and keep a fire extinguisher nearby."],
      },
      STATOR,
    );
    assert.deepEqual(facts, { ...STATOR_READING, torqueOnPage: false });
    assert.equal(dropped, 4);
    assert.ok(hasFacts(facts));
  });

  test("the same step on a page that has a torque spec: its pin numbers could be a torque's, so it's dropped", () => {
    const torqued = `${STATOR}\nTORQUE\nStator Bolts:\n8 ft-lbs (11 N·m)`;
    const result = kept(STATOR_READING, torqued);
    assert.deepEqual(
      result.steps.map((step) => step.n),
      [1, 3, 4],
    );
    assert.deepEqual([result.tools, result.torqueOnPage], [STATOR_READING.tools, true]);
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
      steps: [...OWNER_LIST, { n: 8, text: "Torque the starter solenoid fasteners to 97 in-lbs (11 N·m)." }],
      torques: [{ item: "Starter Solenoid Fastener", value: "97 in-lbs (11 N·m)" }],
      tools: [],
      cautions: [],
      notes: ["Starter Solenoid Cable Fastener: 35 in-lbs (4 N·m)"],
      moreTorques: false,
    };
    const { facts, dropped } = checkFacts(old, OWNER);
    assert.deepEqual(facts, { ...OWNER_READING, torqueOnPage: true });
    assert.equal(dropped, 1);
    // Read again, a card is the same card.
    assert.deepEqual(checkFacts(facts, OWNER), { facts, dropped: 0 });
  });

  test("whatever shape the input has, the result has the card's shape", () => {
    for (const input of [null, undefined, "text", 42, [], { steps: "no", tools: [5, null], cautions: {}, torques: [null, 1, "x"], notes: [{}], torqueOnPage: false }]) {
      assert.deepEqual(checkFacts(input, OWNER).facts, { title: "", steps: [], tools: [], cautions: [], torqueOnPage: true }, JSON.stringify(input));
    }
  });

  test("steps get a number when theirs isn't one, each entry is kept once, and lists are capped", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Inspect the stator connector seal ${"abcdefghijklmnopqrst"[i]}`);
    const { facts } = checkFacts(
      {
        steps: [
          { n: 0, text: "Disconnect the stator connector." },
          { n: "two", text: "Replace the stator if a reading is out of range." },
          { n: 2, text: "Replace the stator if a reading is out of range." },
        ],
        cautions: lines,
      },
      `${STATOR}\n${lines.join("\n")}`,
    );
    assert.deepEqual(facts.steps, [
      { n: 1, text: "Disconnect the stator connector." },
      { n: 2, text: "Replace the stator if a reading is out of range." },
    ]);
    assert.equal(facts.cautions.length, FACTS_LIMITS.cautions);
  });

  test("long text is cut to the card's lengths", () => {
    const long = "Disconnect the stator connector. ".repeat(30);
    const { facts } = checkFacts({ steps: [{ n: 1, text: long }] }, `${STATOR}\n${long}`);
    assert.ok(facts.steps[0].text.length <= FACTS_LIMITS.text);
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
