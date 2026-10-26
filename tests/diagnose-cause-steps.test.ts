// Diagnose: each likely cause's own steps (the next checks that confirm or
// rule it out, shown in its card), the "Start here" checks for no cause in
// particular, older replies keeping their separate list, "Ask how to check",
// and the prompt and tool asking Claude for checks that way. Pure: no
// database.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type Anthropic from "@anthropic-ai/sdk";

import { addAsk, causeRanks, causeSteps, checksHaveCauses, howToCheckQuestion, specText } from "../src/lib/diagnose-cause-steps";
import { SYSTEM_PROMPT, TOOL_NAMES, buildRequest } from "../src/lib/diagnose-prompt";
import { addQuote, finalizeReply, type Check } from "../src/lib/diagnose-rules";
import type { CauseState } from "../src/lib/diagnose-zones";

const cause = (title: string, status: CauseState = "open") => ({
  title,
  system: "electrical",
  likelihood: "medium",
  why: "",
  status,
  check_effort: "quick",
  sources: [],
});
const check = (tier: string, action: string, causes: unknown[]) => ({ tier, action, causes, expected: "", sources: [] });

// A speedometer that drops out: four causes (and one without a title, which
// the list leaves out), checks out of tier order, one shared by two causes,
// two for no cause in particular (one of them numbered past the list).
const speedo = () =>
  finalizeReply(
    {
      reply: "Start with the connector.",
      likely_causes: [
        cause("Water in the speed sensor connector"),
        cause(""),
        cause("Speed sensor failing inside"),
        cause("Chafed sensor wire"),
        cause("Gauge fault"),
      ],
      next_checks: [
        // Claude's numbers count the cause without a title: its 3 is the
        // list's 2, its 4 the list's 3, its 5 the list's 4.
        check("teardown", "Swap in a known-good speed sensor", [3]),
        check("test", "Back-probe the sensor signal while turning the wheel", [3, 1]),
        check("quick", "Unplug the connector and look for water", [1]),
        check("quick", "Read the stored codes on the gauge", []),
        check("quick", "Follow the sensor wire along the frame", [4]),
        check("test", "Check the battery's state of charge", [9]),
        check("quick", "Look at the connector's seal", [1]),
      ],
      safety_notes: [],
      questions_for_tech: [],
    },
    { pages: [], urls: [] },
  );

const actions = (steps: { check: Check }[] | undefined) => (steps ?? []).map((step) => step.check.action.split(" ").slice(0, 2).join(" "));

describe("each cause's steps", () => {
  test("an open cause gets the checks that settle it, quickest first; a shared check is in each card, saying which others it checks", () => {
    const reply = speedo();
    assert.deepEqual(
      reply.likelyCauses.map((c) => c.title.split(" ")[0]),
      ["Water", "Speed", "Chafed", "Gauge"],
    );
    const steps = causeSteps(reply.nextChecks, reply.likelyCauses)!;
    // Cause 1: its two quick looks (Claude's order within the tier), then
    // the test it shares with cause 2.
    assert.deepEqual(actions(steps.byCause.get(1)), ["Unplug the", "Look at", "Back-probe the"]);
    assert.deepEqual(steps.byCause.get(1)!.map((step) => [step.tier, step.also]), [
      ["quick", []],
      ["quick", []],
      ["test", [2]],
    ]);
    // Cause 2 (Claude's 3): the shared test, then teardown.
    assert.deepEqual(actions(steps.byCause.get(2)), ["Back-probe the", "Swap in"]);
    assert.deepEqual(steps.byCause.get(2)!.map((step) => step.also), [[1], []]);
    assert.deepEqual(actions(steps.byCause.get(3)), ["Follow the"]);
    // Cause 4 has none yet: an empty list, so its card can say so.
    assert.deepEqual(steps.byCause.get(4), []);
    // For no cause in particular, and numbered past the list: Start here,
    // quickest first.
    assert.deepEqual(actions(steps.general), ["Read the", "Check the"]);
    assert.deepEqual(steps.general.map((step) => [step.tier, step.also]), [
      ["quick", []],
      ["test", []],
    ]);
    // Every check is shown somewhere.
    const shown = new Set([...steps.general, ...[...steps.byCause.values()].flat()].map((step) => step.check));
    assert.equal(shown.size, reply.nextChecks.length);
  });

  test("ruled-out and confirmed causes show no steps, and a check for them only goes; Start here stays", () => {
    const reply = speedo();
    const marked = (statuses: CauseState[]) => reply.likelyCauses.map((c, index) => ({ ...c, status: statuses[index] }));
    const ruledOut = causeSteps(reply.nextChecks, marked(["ruled_out", "open", "open", "open"]))!;
    assert.equal(ruledOut.byCause.has(1), false);
    // The shared test stays with cause 2, which no longer says it checks 1.
    assert.deepEqual(actions(ruledOut.byCause.get(2)), ["Back-probe the", "Swap in"]);
    assert.deepEqual(ruledOut.byCause.get(2)!.map((step) => step.also), [[], []]);
    // Cause 1's own quick looks are nowhere now.
    const shown = [...ruledOut.general, ...[...ruledOut.byCause.values()].flat()].map((step) => step.check.action);
    assert.ok(!shown.some((action) => action.startsWith("Unplug") || action.startsWith("Look at")), JSON.stringify(shown));
    assert.equal(ruledOut.general.length, 2);
    // Once one is confirmed, the causes still open keep their steps, and
    // Start here its checks, as before.
    const solved = causeSteps(reply.nextChecks, marked(["confirmed", "open", "ruled_out", "open"]))!;
    assert.deepEqual([...solved.byCause.keys()], [2, 4]);
    assert.deepEqual(actions(solved.byCause.get(2)), ["Back-probe the", "Swap in"]);
    assert.deepEqual(actions(solved.general), ["Read the", "Check the"]);
  });

  test("a reply saved before checks carried causes keeps its own list; one with no checks goes cause by cause", () => {
    const old: Check[] = [
      { action: "Measure stator output.", expected: "", sources: [], unverifiedSpec: false },
      { tier: "test", action: "Load test the battery.", expected: "", sources: [], unverifiedSpec: false },
    ];
    assert.equal(checksHaveCauses(old), false);
    assert.equal(causeSteps(old, [{ status: "open" }]), null);
    assert.equal(checksHaveCauses([]), true);
    assert.deepEqual(causeSteps([], [{ status: "open" }, { status: "ruled_out" }]), { general: [], byCause: new Map([[1, []]]) });
    // No causes at all yet: every check is a Start here one.
    const none = causeSteps([{ tier: "quick" as const, causes: [1] }, { tier: "quick" as const, causes: [] }], [])!;
    assert.equal(none.general.length, 2);
    assert.deepEqual([causeRanks({ causes: [3, "2", 2, 0, 1.5, 7] }, 3), causeRanks({}, 3), causeRanks({ causes: "1" }, 3)], [[2, 3], [], []]);
  });

  test("Claude's cause numbers become the list's, once each and in order, and up to 16 checks are kept", () => {
    const many = finalizeReply(
      {
        reply: "x",
        likely_causes: [cause("A"), cause("B")],
        next_checks: Array.from({ length: 20 }, (_, index) => check(index % 2 ? "test" : "quick", `Check ${index + 1}`, [2, 1, 2])),
        safety_notes: [],
        questions_for_tech: [],
      },
      { pages: [], urls: [] },
    );
    assert.equal(many.nextChecks.length, 16);
    assert.ok(many.nextChecks.every((c) => JSON.stringify(c.causes) === "[1,2]"));
    // Quick ones first, in Claude's order.
    assert.deepEqual(many.nextChecks.slice(0, 3).map((c) => c.action), ["Check 1", "Check 3", "Check 5"]);
    // A check keeps every cause it settles, so it's in each of their cards.
    const seven = finalizeReply(
      {
        reply: "x",
        likely_causes: Array.from({ length: 7 }, (_, index) => cause(`Cause ${index + 1}`)),
        next_checks: [check("quick", "Read the stored codes", [7, 6, 5, 4, 3, 2, 1])],
        safety_notes: [],
        questions_for_tech: [],
      },
      { pages: [], urls: [] },
    );
    assert.deepEqual(seven.nextChecks[0].causes, [1, 2, 3, 4, 5, 6, 7]);
    const sevenSteps = causeSteps(seven.nextChecks, seven.likelyCauses)!;
    assert.deepEqual(sevenSteps.byCause.get(7)!.map((step) => step.also), [[1, 2, 3, 4, 5, 6]]);
  });

  test("a spec keeps each number on one line with its unit", () => {
    assert.equal(specText("Square wave, 0 to 5 V"), "Square wave, 0\u00a0to 5\u00a0V");
    assert.equal(specText("0.6 to 0.8 ohms primary"), "0.6\u00a0to 0.8\u00a0ohms primary");
    assert.equal(specText("25 Nm; 12.6 V or more; 90 °C; 5 %"), "25\u00a0Nm; 12.6\u00a0V or more; 90\u00a0°C; 5\u00a0%");
    // Nothing else changes: two numbers, words, or none.
    assert.equal(specText("1 2 3"), "1 2 3");
    assert.equal(specText("Within spec"), "Within spec");
    assert.equal(specText(""), "");
  });
});

describe("Ask how to check", () => {
  test("the question names the cause by its number and title", () => {
    assert.equal(howToCheckQuestion(2, "Fouled or worn spark plugs"), "How do I check cause 2, Fouled or worn spark plugs?");
    assert.equal(howToCheckQuestion(3, "  Low fuel  pressure. "), "How do I check cause 3, Low fuel pressure?");
  });

  test("it goes after what's typed, a blank line apart from quotes, and not twice", () => {
    const ask = howToCheckQuestion(2, "Fouled or worn spark plugs");
    assert.equal(addAsk("", ask), ask);
    assert.equal(addAsk("  \n", ask), ask);
    assert.equal(addAsk("Plugs look dry.", ask), `Plugs look dry.\n${ask}`);
    assert.equal(addAsk(addAsk("", ask), ask), ask);
    const other = howToCheckQuestion(3, "Low fuel pressure");
    assert.equal(addAsk(ask, other), `${ask}\n${other}`);
    const quoted = addQuote("", "How many hours are on it?");
    assert.equal(addAsk(`${quoted}About 200`, ask), `> How many hours are on it?\nAbout 200\n\n${ask}`);
  });
});

describe("the prompt and submit_diagnosis", () => {
  type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; description?: string; additionalProperties?: boolean };
  const submitSchema = () => {
    const tools = buildRequest({ messages: [], webSearch: true }).tools as Anthropic.Beta.Messages.BetaTool[];
    return tools.find((tool) => tool.name === TOOL_NAMES.submit)!.input_schema as Schema;
  };

  test("ask for a check for every open cause, every cause a check settles, and an empty list only for a general one", () => {
    assert.match(SYSTEM_PROMPT, /The next checks are the steps that confirm or rule out those causes/);
    assert.match(SYSTEM_PROMPT, /give every open cause at least one check, the quickest one that settles it first, and put on each check the number of every cause it settles/);
    assert.match(SYSTEM_PROMPT, /an empty list of causes only when it isn't about any one cause \(pulling stored codes, the battery's state of charge\): those are shown first, as "Start here"/);
    // The tiers are still how the checks are ordered.
    assert.match(SYSTEM_PROMPT, /quick checks \(minutes, no tools or teardown.*\), then tests \(.*\), then teardown \(.*\)\. Within a tier, put the most useful check first\./);
    // A cause's effort words agree with the steps beside them.
    assert.match(SYSTEM_PROMPT, /a cause's check_effort is the tier of the quickest check you give for it/);
    const effort = submitSchema().properties!.likely_causes.items!.properties!.check_effort;
    assert.match(String(effort.description), /The tier of the quickest check you give for it\.$/);
    const checks = submitSchema().properties!.next_checks;
    assert.match(String(checks.description), /^The steps that confirm or rule out the likely causes, at least one for every open cause \(the quickest that settles it first\)/);
    assert.match(String(checks.description), /quick checks, then tests, then teardown/);
    assert.match(String(checks.items!.properties!.causes.description), /^The number of every likely cause this check confirms or rules out .*An empty list only for a check that isn't about any one cause/);
  });

  test("the checks' shape is as before; a cause also has its confidence and what it rests on", () => {
    const input = submitSchema();
    assert.deepEqual(input.required, ["reply", "likely_causes", "next_checks", "safety_notes", "questions_for_tech"]);
    const item = input.properties!.next_checks.items!;
    assert.deepEqual(Object.keys(item.properties!), ["tier", "action", "causes", "expected", "sources"]);
    assert.deepEqual(item.required, ["tier", "action", "causes", "expected", "sources"]);
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(item.properties!.causes.type, "array");
    assert.deepEqual(item.properties!.causes.items, { type: "integer" });
    const causeItem = input.properties!.likely_causes.items!;
    assert.deepEqual(causeItem.required, ["title", "system", "confidence", "likelihood", "based_on", "why", "status", "check_effort", "sources"]);
  });

  test("the system prompt and tools are the same on every request (they're cached)", () => {
    const a = buildRequest({ messages: [], webSearch: true });
    const b = buildRequest({ messages: [{ role: "user", content: "Misfires under load" }], webSearch: true });
    assert.equal(JSON.stringify(a.system), JSON.stringify(b.system));
    assert.equal(JSON.stringify(a.tools), JSON.stringify(b.tools));
  });
});
