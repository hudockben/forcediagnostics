// Diagnose: Claude's confidence in each likely cause (checked and held to
// 0-100, its likelihood set from it), the line of what it rests on, each
// step's source level (manual, web, general), and the prompt and tool asking
// for them. Pure: no database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";

import type Anthropic from "@anthropic-ai/sdk";

import { evidenceLine, evidenceParts, sourceLevel, webKind } from "../src/lib/diagnose-evidence";
import { SYSTEM_PROMPT, TOOL_NAMES, buildRequest } from "../src/lib/diagnose-prompt";
import {
  BASED_ON,
  basedOnOf,
  confidenceOf,
  finalizeReply,
  likelihoodFor,
  partialReply,
  type Check,
  type SeenSources,
  type SourceView,
} from "../src/lib/diagnose-rules";

const manualId = randomUUID();
const FORUM = { url: "https://www.rzrforums.example.com/threads/xp-1000-p0300-under-load.4411/", title: "XP 1000 P0300 misfire under load - fixed (coil)" };
const TSB = { url: "https://polaris-tsb.example.com/bulletins/rzr-2019-ignition", title: "RZR 2019 ignition coil bulletin" };
const seen: SeenSources = {
  pages: [
    { manualId, page: 2, title: "2019 RZR XP 1000 Service Manual" },
    { manualId, page: 3, title: "2019 RZR XP 1000 Service Manual" },
  ],
  urls: [FORUM, TSB],
};

const cause = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  system: "ignition",
  likelihood: "medium",
  why: "",
  status: "open",
  check_effort: "test",
  sources: [],
  ...extra,
});
const reply = (likely_causes: unknown[], next_checks: unknown[] = []) =>
  finalizeReply({ reply: "x", likely_causes, next_checks, safety_notes: [], questions_for_tech: [] }, seen);

describe("a cause's confidence", () => {
  test("is a whole number held to 0-100; one that isn't a number is left out, as on a reply saved before", () => {
    assert.deepEqual(
      [72, 71.6, "45", " 45% ", 150, -5, 0, 100, "high", "", null, undefined, true, Number.NaN, Infinity].map(confidenceOf),
      [72, 72, 45, 45, 100, 0, 0, 100, null, null, null, null, null, null, null],
    );
    const causes = reply([
      cause("A", { confidence: 82.4, based_on: ["manual"] }),
      cause("B", { confidence: "not sure", based_on: ["web"] }),
      cause("C"),
    ]).likelyCauses;
    assert.equal(causes[0].confidence, 82);
    // No number, no confidence and no grounds: no % shows, never "0%".
    for (const without of causes.slice(1)) {
      assert.equal(without.confidence, undefined);
      assert.equal(without.basedOn, undefined);
      assert.ok(!("confidence" in without), JSON.stringify(without));
    }
  });

  test("what it rests on keeps the listed values once each, in the list's order; anything else is dropped", () => {
    assert.deepEqual(BASED_ON, ["tech_report", "fault_codes", "step_results", "manual", "web", "experience"]);
    assert.deepEqual(basedOnOf(["web", "Tech report", "fault-codes", "web", "gut feel", 7, null, " EXPERIENCE "]), ["tech_report", "fault_codes", "web", "experience"]);
    assert.deepEqual(basedOnOf("manual"), []);
    assert.deepEqual(basedOnOf(undefined), []);
    const [only] = reply([cause("A", { confidence: 40, based_on: ["vibes", "step_results", "step_results"] })]).likelyCauses;
    assert.deepEqual(only.basedOn, ["step_results"]);
    // Missing altogether, with a confidence: an empty list.
    const [bare] = reply([cause("A", { confidence: 40 })]).likelyCauses;
    assert.deepEqual(bare.basedOn, []);
  });

  test("sets the likelihood (high from 60, medium from 30, low under it), whatever Claude said; without one Claude's stands", () => {
    assert.deepEqual([100, 60, 59, 30, 29, 0].map(likelihoodFor), ["high", "high", "medium", "medium", "low", "low"]);
    const causes = reply([
      cause("Coil", { likelihood: "low", confidence: 78 }),
      cause("Plugs", { likelihood: "high", confidence: 59.6 }),
      cause("Plug wires", { likelihood: "high", confidence: 59.4 }),
      cause("Fuel pressure", { likelihood: "medium", confidence: 15 }),
      cause("Exhaust leak", { likelihood: "high", confidence: 30 }),
      cause("Old style", { likelihood: "high" }),
      cause("Bad value", { likelihood: "extreme" }),
    ]).likelyCauses;
    assert.deepEqual(
      causes.map((c) => [c.title, c.confidence ?? null, c.likelihood]),
      [
        ["Coil", 78, "high"],
        ["Plugs", 60, "high"],
        ["Plug wires", 59, "medium"],
        ["Fuel pressure", 15, "low"],
        ["Exhaust leak", 30, "medium"],
        ["Old style", null, "high"],
        ["Bad value", null, "medium"],
      ],
    );
  });

  test("never reorders the causes: their numbers are the checks' and the callouts'", () => {
    const out = reply(
      [cause("Low first", { confidence: 20 }), cause("High second", { confidence: 90 }), cause("Middle third", { confidence: 50 })],
      [{ tier: "quick", action: "Look at the second", causes: [2], expected: "", sources: [] }],
    );
    assert.deepEqual(out.likelyCauses.map((c) => c.title), ["Low first", "High second", "Middle third"]);
    assert.deepEqual(out.likelyCauses.map((c) => c.likelihood), ["low", "high", "medium"]);
    assert.deepEqual(out.nextChecks[0].causes, [2]);
  });

  test("a partial reply keeps the last reply's confidences as they were", () => {
    const last = reply([cause("Coil", { confidence: 70, based_on: ["tech_report"] })]);
    const partial = partialReply("", last);
    assert.equal(partial.likelyCauses[0].confidence, 70);
    assert.deepEqual(partial.likelyCauses[0].basedOn, ["tech_report"]);
  });
});

describe("what a confidence rests on", () => {
  const manual = (page: number, id: string = manualId): SourceView => ({ type: "manual", manualId: id, page, title: "Service Manual" });
  const web = (url: string, title = "A page"): SourceView => ({ type: "web", url, title });

  test("the manual pages and web pages counted, then Claude's other grounds in words", () => {
    assert.equal(
      evidenceLine({ sources: [manual(2), manual(3), web(FORUM.url, FORUM.title)], basedOn: ["tech_report", "fault_codes", "manual", "web"] }),
      "2 manual pages · 1 forum post · your report · fault codes",
    );
    assert.equal(
      evidenceLine({ sources: [manual(3), web(TSB.url, TSB.title), web("https://shop.example.com/how-to"), web("https://www.reddit.com/r/RZR/comments/abc/")], basedOn: ["step_results", "experience"] }),
      "1 manual page · 1 forum post · 2 web pages · your check results · experience",
    );
    // A page cited twice (any case of its id) counts once.
    assert.equal(evidenceLine({ sources: [manual(3), manual(3, manualId.toUpperCase())] }), "1 manual page");
  });

  test("manual or web in based_on count only with a citation that held; general knowledge when nothing else; nothing, no line", () => {
    assert.equal(evidenceLine({ sources: [{ type: "general" }], basedOn: ["manual", "web", "experience"] }), "experience");
    assert.equal(evidenceLine({ sources: [{ type: "general" }], basedOn: ["manual"] }), "general knowledge");
    assert.equal(evidenceLine({ sources: [{ type: "general" }] }), "general knowledge");
    assert.equal(evidenceLine({ sources: [], basedOn: [] }), null);
    assert.deepEqual(evidenceParts({ sources: [] }), []);
  });

  test("forum posts are told from other web pages by their address or title", () => {
    const kinds = [
      [FORUM.url, ""],
      ["https://www.reddit.com/r/SXSonline/comments/xyz/", ""],
      ["https://community.polaris.com/t/stator-test/123", ""],
      ["https://example.com/topics/coil-failures", ""],
      ["https://www.example.com/page", "Polaris RZR Forum - coil"],
      [TSB.url, TSB.title],
      ["https://www.example.com/how-to-test-a-coil", "How to test a coil"],
    ].map(([url, title]) => webKind({ url, title }));
    assert.deepEqual(kinds, ["forum post", "forum post", "forum post", "forum post", "forum post", "web page", "web page"]);
  });

  test("built from the citations finalizeReply kept: a made-up page or address isn't counted", () => {
    const [coil] = reply([
      cause("Coil", {
        confidence: 78,
        based_on: ["tech_report", "fault_codes", "manual", "web"],
        sources: [
          { type: "manual", manual_id: manualId, page: 3 },
          { type: "manual", manual_id: manualId, page: 99 },
          { type: "web", url: FORUM.url, title: "x" },
          { type: "web", url: "https://made-up.example.com/tsb", title: "TSB" },
        ],
      }),
    ]).likelyCauses;
    assert.equal(evidenceLine(coil), "1 manual page · 1 forum post · your report · fault codes");
  });
});

describe("a step's source level", () => {
  const check = (expected: string, sources: SourceView[], unverifiedSpec?: boolean) => ({ expected, sources, unverifiedSpec });
  const manual: SourceView = { type: "manual", manualId, page: 3, title: "Service Manual" };
  const web: SourceView = { type: "web", url: TSB.url, title: TSB.title };

  test("manual when it cites a page that held; web when it cites only the web; general otherwise", () => {
    assert.equal(sourceLevel(check("0.6 to 0.8 ohms", [manual], false)), "manual");
    assert.equal(sourceLevel(check("", [manual, web], false)), "manual");
    assert.equal(sourceLevel(check("", [web], false)), "web");
    assert.equal(sourceLevel(check("", [{ type: "general" }], false)), "general");
    assert.equal(sourceLevel(check("", [], false)), "general");
  });

  test("a spec with no manual page behind it is general (verify first), from the web too", () => {
    assert.equal(sourceLevel(check("Gap 0.7 mm", [{ type: "general" }], true)), "general");
    assert.equal(sourceLevel(check("25 Nm", [web], true)), "general");
    // A reply saved without the flag: worked out the same way.
    assert.equal(sourceLevel(check("25 Nm", [web])), "general");
    assert.equal(sourceLevel(check("25 Nm", [manual])), "manual");
    // The flag wins should a spec ever carry it beside a page.
    assert.equal(sourceLevel(check("25 Nm", [manual], true)), "general");
  });

  test("as finalizeReply leaves the checks: the misfire's bulletin look, coil test and plug gap", () => {
    const out = reply(
      [cause("Coil"), cause("Plugs")],
      [
        { tier: "quick", action: "Check whether a service bulletin covers the coils.", causes: [1], expected: "", sources: [{ type: "web", url: TSB.url, title: "x" }, { type: "web", url: "https://made-up.example.com/tsb", title: "TSB" }] },
        { tier: "test", action: "Measure coil primary resistance.", causes: [1], expected: "0.6 to 0.8 ohms", sources: [{ type: "manual", manual_id: manualId, page: 3 }] },
        { tier: "teardown", action: "Pull the plugs and set the gap.", causes: [2], expected: "Gap 0.7 mm", sources: [{ type: "general" }] },
        { tier: "test", action: "Torque the header nuts.", causes: [], expected: "25 Nm", sources: [{ type: "web", url: FORUM.url, title: "x" }] },
        { tier: "quick", action: "Read the stored codes.", causes: [], expected: "", sources: [{ type: "manual", manual_id: manualId, page: 99 }] },
      ],
    );
    const levels = Object.fromEntries(out.nextChecks.map((c: Check) => [c.action.split(" ")[0], sourceLevel(c)]));
    assert.deepEqual(levels, { Check: "web", Read: "general", Measure: "manual", Torque: "general", Pull: "general" });
  });
});

describe("the prompt and submit_diagnosis ask for a confidence", () => {
  type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: string[]; description?: string; minimum?: number; maximum?: number };
  const causeItem = () => {
    const tools = buildRequest({ messages: [], webSearch: true }).tools as Anthropic.Beta.Messages.BetaTool[];
    return (tools.find((tool) => tool.name === TOOL_NAMES.submit)!.input_schema as Schema).properties!.likely_causes.items!;
  };

  test("each cause requires a whole-number confidence and what it rests on (from the list), with no bounds the strict tool can't take", () => {
    const item = causeItem();
    assert.ok(item.required!.includes("confidence") && item.required!.includes("based_on"), JSON.stringify(item.required));
    const { confidence, based_on: basedOn, likelihood } = item.properties!;
    assert.equal(confidence.type, "integer");
    assert.equal(confidence.minimum, undefined);
    assert.equal(confidence.maximum, undefined);
    assert.match(String(confidence.description), /^How likely this cause is behind the symptoms given everything so far, 0 to 100 \(the causes needn't add up to 100\)\. Work it out again with every reply/);
    assert.equal(basedOn.type, "array");
    assert.deepEqual(basedOn.items, { type: "string", enum: [...BASED_ON] });
    assert.match(String(basedOn.description), /tech_report .*fault_codes.*step_results .*manual .*web .*experience/);
    assert.deepEqual(likelihood.enum, ["high", "medium", "low"]);
    assert.equal(likelihood.description, "From the confidence: high for 60 or more, medium for 30 to 59, low under 30.");
    // The confidence comes before the likelihood that follows from it.
    const keys = Object.keys(item.properties!);
    assert.ok(keys.indexOf("confidence") < keys.indexOf("likelihood"), keys.join());
  });

  test("the prompt explains the number, its bands, ranking by it, what it rests on, and working it out again with every reply", () => {
    assert.match(SYSTEM_PROMPT, /Rank the likely causes by how likely they are, highest confidence first: that's the diagnosis\./);
    assert.match(SYSTEM_PROMPT, /Give each likely cause your confidence, a whole number from 0 to 100, that it's behind this unit's symptoms given everything so far/);
    assert.match(SYSTEM_PROMPT, /the numbers needn't add up to 100/);
    assert.match(SYSTEM_PROMPT, /high from 60, medium from 30 to 59, low under 30 \(the app sets it from the number, so the tech's heat bar and the % always agree\)/);
    assert.match(SYSTEM_PROMPT, /Say in based_on what the number rests on/);
    assert.match(SYSTEM_PROMPT, /Work it out again with every reply from what's new \(a check that came out fine or found a problem, a cause the tech ruled out, a new symptom or code\)/);
    assert.match(SYSTEM_PROMPT, /with each one's confidence and status/);
    assert.match(SYSTEM_PROMPT, /let the tech's marks move your confidence in the causes still open/);
    const list = buildRequest({ messages: [], webSearch: false }).tools as Anthropic.Beta.Messages.BetaTool[];
    const causes = (list.find((tool) => tool.name === TOOL_NAMES.submit)!.input_schema as Schema).properties!.likely_causes;
    assert.match(String(causes.description), /most likely first \(by confidence\)/);
  });

  test("the prompt and tools stay the same on every request (they're cached)", () => {
    const a = buildRequest({ messages: [], webSearch: true });
    const b = buildRequest({ messages: [{ role: "user", content: "Coil tested at 0.7 ohms" }], webSearch: true });
    assert.equal(JSON.stringify([a.system, a.tools]), JSON.stringify([b.system, b.tools]));
  });
});
