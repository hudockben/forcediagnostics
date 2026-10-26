// Diagnose: the tech ticking off Claude's checks (done, and OK or a problem
// found): a check known by its words from one reply to the next, which
// entries are kept, replaced or left out, the note Claude hears, the step to
// do next and what a cause's steps suggest. Pure: no database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";

import { SYSTEM_PROMPT, buildRequest } from "../src/lib/diagnose-prompt";
import type { StepCheckEntry, StepResult } from "../src/lib/diagnose-rules";
import { NOT_DONE, applyStepCheck, markHint, nextStep, sameState, stepKey, stepNotes, stepStateIn, stepStateOf, stepStates } from "../src/lib/diagnose-step-checks";

const turnId = randomUUID();
const COIL = "Ignition coil breaking down under load";
const PLUGS = "Fouled or worn spark plugs";
const RESISTANCE = "Measure coil primary resistance at the coil connector, each cylinder.";
const BULLETIN = "Check whether a service bulletin covers the coils.";

let clock = 0;
const entry = (action: string, done: boolean, result: StepResult | null = null, extra: Partial<StepCheckEntry> = {}): StepCheckEntry => ({
  turnId,
  seq: 1,
  index: 0,
  action,
  causes: [COIL],
  done,
  result,
  userId: "u1",
  userName: "Mike",
  at: new Date(Date.UTC(2026, 9, 26, 9, 0, clock++)).toISOString(),
  sentInSeq: null,
  ...extra,
});
const brief = (entries: StepCheckEntry[]) => entries.map((item) => [item.action.split(" ")[0], item.done, item.result, item.sentInSeq]);
const sent = (entries: StepCheckEntry[], seq: number) => entries.map((item) => (item.sentInSeq === null ? { ...item, sentInSeq: seq } : item));

describe("a check from one reply to the next", () => {
  test("is known by its words, case, accents, punctuation and spacing aside", () => {
    assert.equal(stepKey(RESISTANCE), "measure coil primary resistance at the coil connector each cylinder");
    assert.equal(stepKey("  measure coil primary resistance at the coil connector — each cylinder "), stepKey(RESISTANCE));
    assert.equal(stepKey("Check the régulateur's plug!"), "check the regulateur s plug");
    assert.notEqual(stepKey("Measure coil secondary resistance."), stepKey("Measure coil primary resistance."));
    assert.equal(stepKey(undefined as unknown as string), "");
    // Signs aren't punctuation: over and under 12 V are two checks.
    assert.notEqual(stepKey("Confirm voltage > 12 V."), stepKey("Confirm voltage < 12 V."));
    assert.equal(stepKey("Confirm voltage>12 V"), "confirm voltage > 12 v");
    assert.equal(stepKey("Check B+ at the relay."), "check b + at the relay");
  });

  test("how it stood on the screen tapped is a state, or nothing", () => {
    assert.deepEqual(stepStateIn({ done: true, result: "problem" }), { done: true, result: "problem" });
    assert.deepEqual(stepStateIn({ done: true }), { done: true, result: null });
    assert.deepEqual(stepStateIn({ done: false, result: "ok" }), NOT_DONE);
    assert.equal(stepStateIn({ done: "yes" }), null);
    assert.equal(stepStateIn({ done: true, result: "maybe" }), null);
    assert.equal(stepStateIn(null), null);
    assert.equal(stepStateIn("done"), null);
    assert.ok(sameState({ done: false, result: "ok" }, NOT_DONE));
    assert.ok(!sameState({ done: true, result: null }, { done: true, result: "ok" }));
  });

  test("stands as its latest entry, whichever reply it was ticked on", () => {
    const entries = [entry(RESISTANCE, true), entry(BULLETIN, true, "ok"), entry("measure coil primary resistance at the coil connector, each cylinder", true, "problem", { turnId: randomUUID(), seq: 2, index: 1 })];
    const states = stepStates(entries);
    assert.deepEqual(stepStateOf(states, RESISTANCE), { done: true, result: "problem" });
    assert.deepEqual(stepStateOf(states, BULLETIN), { done: true, result: "ok" });
    assert.deepEqual(stepStateOf(states, "Pull the plugs."), NOT_DONE);
    // A tick taken back: not done, whatever it found before.
    assert.deepEqual(stepStateOf(stepStates([...entries, entry(RESISTANCE, false)]), RESISTANCE), NOT_DONE);
  });
});

describe("saving a tick", () => {
  test("before Claude has heard, an entry for the same check is replaced, and taking a tick back leaves nothing", () => {
    let entries = applyStepCheck([], entry(RESISTANCE, true));
    assert.deepEqual(brief(entries), [["Measure", true, null, null]]);
    entries = applyStepCheck(entries, entry(RESISTANCE, true, "ok"));
    assert.deepEqual(brief(entries), [["Measure", true, "ok", null]]);
    entries = applyStepCheck(entries, entry(BULLETIN, true, "problem"));
    entries = applyStepCheck(entries, entry("measure coil primary resistance at the coil connector each cylinder", true, "problem"));
    assert.deepEqual(brief(entries), [
      ["Check", true, "problem", null],
      ["measure", true, "problem", null],
    ]);
    entries = applyStepCheck(entries, entry(RESISTANCE, false));
    assert.deepEqual(brief(entries), [["Check", true, "problem", null]]);
    // No result without the tick, and never sent yet, whatever it says.
    const [bare] = applyStepCheck([], entry(PLUGS, true, "ok"));
    assert.deepEqual(brief(applyStepCheck([], { ...bare, done: false, sentInSeq: 4 })), []);
    assert.equal(applyStepCheck([], { ...bare, sentInSeq: 4 })[0].sentInSeq, null);
  });

  test("once Claude has heard, a change is a new entry; putting it back as Claude heard it is no change", () => {
    const heard = sent([entry(RESISTANCE, true, "ok")], 2);
    let entries = applyStepCheck(heard, entry(RESISTANCE, true, "problem"));
    assert.deepEqual(brief(entries), [
      ["Measure", true, "ok", 2],
      ["Measure", true, "problem", null],
    ]);
    entries = applyStepCheck(entries, entry(RESISTANCE, true, "ok"));
    assert.deepEqual(brief(entries), [["Measure", true, "ok", 2]]);
    entries = applyStepCheck(entries, entry(RESISTANCE, false));
    assert.deepEqual(brief(entries), [
      ["Measure", true, "ok", 2],
      ["Measure", false, null, null],
    ]);
    // Done with no result is a change from OK.
    assert.equal(applyStepCheck(heard, entry(RESISTANCE, true)).length, 2);
  });

  test("while a message is with Claude, nothing is replaced: the tick goes after the ones on their way", () => {
    const waiting = [entry(RESISTANCE, true, "ok")];
    const entries = applyStepCheck(waiting, entry(RESISTANCE, false), { inFlight: true });
    assert.deepEqual(brief(entries), [
      ["Measure", true, "ok", null],
      ["Measure", false, null, null],
    ]);
    assert.deepEqual(stepStateOf(stepStates(entries), RESISTANCE), NOT_DONE);
  });
});

describe("what Claude hears", () => {
  test("each check it hasn't heard, as it stands, with the causes it's for", () => {
    const entries = [
      entry(RESISTANCE, true, "ok"),
      entry(BULLETIN, true, "problem", { causes: [COIL, PLUGS] }),
      entry("Read the stored codes.", true, null, { causes: [] }),
      entry("Follow the harness past the frame, the fuse and the ground.", true, "ok", { causes: [COIL, PLUGS, "Low fuel pressure"] }),
    ];
    assert.deepEqual(stepNotes(entries), [
      "Since your last reply the tech checked:\n" +
        `- “${RESISTANCE}” (for cause “${COIL}”): OK (found nothing wrong)\n` +
        `- “${BULLETIN}” (for causes “${COIL}” and “${PLUGS}”): problem found\n` +
        "- “Read the stored codes.”: done (no result given)\n" +
        `- “Follow the harness past the frame, the fuse and the ground.” (for causes “${COIL}”, “${PLUGS}” and “Low fuel pressure”): OK (found nothing wrong)`,
    ]);
    assert.deepEqual(stepNotes([]), []);
  });

  test("nothing it has heard; a tick taken back after it heard; nothing that's back as it heard it", () => {
    const heard = sent([entry(RESISTANCE, true, "ok"), entry(BULLETIN, true)], 2);
    assert.deepEqual(stepNotes(heard), []);
    assert.deepEqual(stepNotes([...heard, entry(RESISTANCE, false)]), [`Since your last reply the tech checked:\n- “${RESISTANCE}” (for cause “${COIL}”): unticked (not done after all)`]);
    // Ticked again on the way, as Claude heard it: nothing to say.
    assert.deepEqual(stepNotes([...heard, entry(RESISTANCE, false), entry(RESISTANCE, true, "ok")]), []);
    // Never heard, ticked and taken back while a message was with Claude.
    assert.deepEqual(stepNotes([entry(PLUGS, true), entry(PLUGS, false)]), []);
  });

  test("a check's long words are cut short", () => {
    const [note] = stepNotes([entry(`Remove the left side panel ${"and look ".repeat(40)}`, true, "ok", { causes: [] })]);
    const line = note.split("\n")[1];
    assert.ok(line.length <= 230 && line.includes("…”: OK"), line);
  });

  test("the prompt says what the notes are and to use them; it's the same on every request", () => {
    assert.match(SYSTEM_PROMPT, /the next checks the tech has ticked off as done, with the step's result when they gave one: OK \(they found nothing wrong\) or problem found/);
    assert.match(SYSTEM_PROMPT, /Use the tech's marks and step results to update each cause's confidence and status/);
    assert.match(SYSTEM_PROMPT, /keep a check's action word for word when you repeat it/);
    assert.match(SYSTEM_PROMPT, /To have the tech do a check again \(after a repair, say\), word it as a new check/);
    const a = buildRequest({ messages: [], webSearch: true });
    const b = buildRequest({ messages: [{ role: "user", content: `Coil OK\n${stepNotes([entry(RESISTANCE, true, "ok")])[0]}` }], webSearch: true });
    assert.equal(JSON.stringify([a.system, a.tools]), JSON.stringify([b.system, b.tools]));
  });
});

describe("on the screen", () => {
  const done = (result: StepResult | null = null) => ({ done: true, result });

  test("the step to do next is the first that isn't done, in the card's order", () => {
    assert.equal(nextStep([NOT_DONE, NOT_DONE]), 0);
    assert.equal(nextStep([done("ok"), NOT_DONE, NOT_DONE]), 1);
    assert.equal(nextStep([done(), done("problem"), NOT_DONE]), 2);
    assert.equal(nextStep([NOT_DONE, done()]), 0);
    assert.equal(nextStep([done(), done("ok")]), -1);
    assert.equal(nextStep([]), -1);
  });

  test("every step done and OK suggests Ruled out; a problem found on any, This was it; otherwise nothing", () => {
    assert.equal(markHint([done("ok"), done("ok")]), "ruled_out");
    assert.equal(markHint([done("ok"), done("problem")]), "confirmed");
    assert.equal(markHint([NOT_DONE, done("problem")]), "confirmed");
    assert.equal(markHint([done("ok"), NOT_DONE]), null);
    assert.equal(markHint([done("ok"), done()]), null);
    assert.equal(markHint([NOT_DONE]), null);
    assert.equal(markHint([]), null);
  });
});
