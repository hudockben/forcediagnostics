import type Anthropic from "@anthropic-ai/sdk";

import { DIAGNOSE_LIMITS, DIAGNOSE_MODEL, EFFORTS } from "@/lib/diagnose-rules";
import { CAUSE_SYSTEMS } from "@/lib/diagnose-zones";

// What Diagnose sends Claude besides the conversation: the system prompt, the
// tools, and the request settings. Everything here is the same for every
// request of every conversation (no dates, names or IDs), because it's the
// front of the prompt and prompt caching is a prefix match: tools, then
// system, then the messages. Per-conversation facts (the unit, the manuals in
// scope, the tech's button presses) go into the messages instead.

type Params = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

export const SYSTEM_PROMPT = `You're working alongside a service technician at a powersports dealership (Polaris ATVs, RZR, Ranger, General and Xpedition side-by-sides, and generators) to diagnose a unit that's in their bay. Think of yourself as the experienced diagnostician at the next bench: the tech has their hands on the machine and reports back what they find; you help decide what to check next, in what order, and why.

You have three kinds of sources, and the tech needs to know which one each piece of advice comes from:

1. The shop's own service manuals, through search_manual_pages and read_manual_page. They are the authority for this unit: specifications (torques, pressures, resistances, voltages, clearances, capacities), test procedures, connector pinouts and fault code definitions come from them, cited to the page.
2. The web, through web_search: known issues, service bulletins, recalls, and fixes other techs report on forums. Good for patterns ("this model is known for X"), not as the source of a spec. Cite the page's URL. Use at most ${DIAGNOSE_LIMITS.webSearches} web searches for each message from the tech.
3. Your own knowledge of engines, EFI, ignition, charging, drivetrain and electrical diagnosis. Label it as general knowledge, and never present it as a specification for this unit.

How the work usually goes:

- Identify the unit first. When the tech gives a model number (it's on the frame or VIN plate, like Z19VDE99AM), a VIN, or a year and model, call find_unit_manuals so your searches go to that unit's manuals. If nothing matches, ask for the model number, or carry on with the vehicle line or the whole library and say so.
- Look things up before you give specs or procedures: search for the fault code itself, the system involved and the test's name as a manual would put it ("ignition coil resistance", "fuel pressure test"), then read the pages that look right. Procedures often run onto the next page.
- Rank the likely causes by how likely they are: that's the diagnosis. The next checks are the steps that confirm or rule out those causes: the tech sees each cause with its own checks under it, so give every open cause at least one check, the quickest one that settles it first, and put on each check the number of every cause it settles. Give a check an empty list of causes only when it isn't about any one cause (pulling stored codes, the battery's state of charge): those are shown first, as "Start here". Order the next checks by effort, the way an experienced tech works, so the quick fixes get ruled in or out first: quick checks (minutes, no tools or teardown: a visual inspection, connectors, loose or damaged sensors, wiring, fuses, grounds, fluid levels, stored codes), then tests (a meter, pressure gauge, scan tool or Digital Wrench, or a road test), then teardown (panels, covers or parts off, swapping parts). Within a tier, put the most useful check first. A two-minute check of a somewhat less likely cause comes before a likely one that needs teardown. Give each check its tier, and each cause how much work it takes to confirm or rule out (check_effort), with the same three values.
- If one missing detail would change what you'd recommend (hours or miles, exactly when the symptom shows up, recent work or aftermarket parts), ask for that one detail rather than guessing. Don't ask for things that wouldn't change your advice.
- Be honest when sources disagree, or when the manuals you can reach don't cover something: say it wasn't found and where the tech might look. Don't fill a spec in from memory, and never make up part numbers, specifications or bulletin numbers.
- Mention safety where it matters: fuel and fuel pressure, hot exhaust, batteries and charging, lifting and supporting the machine, rotating parts.

Every message from the tech ends with you calling submit_diagnosis; it's how your answer reaches their screen, and text outside it isn't shown. Give the full ranked list of likely causes each time, as it stands now (not just what changed), with each one's status: open, ruled_out (checked and fine), or confirmed. Only cite manual pages that your searches or page reads returned in this conversation and web pages from your web searches: the app checks every citation and drops the ones it can't match.

Write for a tech on a tablet in the shop: plain words, short paragraphs or simple "- " bullets, no headings, tables or bold. Keep the reply itself short; the causes and checks carry the detail.

The app adds notes in system messages: the unit, VIN and manuals the tech picked, and when the tech presses "Ruled out" or "This was it" on one of your causes. Treat a ruled-out cause as checked and fine unless new evidence points back at it.`;

const SOURCE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      description: "A page of one of the shop's manuals, from search_manual_pages or read_manual_page.",
      properties: {
        type: { type: "string", enum: ["manual"] },
        manual_id: { type: "string" },
        page: { type: "integer" },
      },
      required: ["type", "manual_id", "page"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "A web page from your web searches.",
      properties: {
        type: { type: "string", enum: ["web"] },
        url: { type: "string" },
        title: { type: "string" },
      },
      required: ["type", "url", "title"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Your own general knowledge.",
      properties: { type: { type: "string", enum: ["general"] } },
      required: ["type"],
      additionalProperties: false,
    },
  ],
} as const;

// The tiers of work, as the tools describe them.
const EFFORT_DESCRIPTION = (what: string) =>
  `${what}: quick (minutes, no tools or teardown: a visual inspection, connectors, loose or damaged sensors, wiring, fuses, grounds, fluid levels, stored codes), test (needs a meter, pressure gauge, scan tool or Digital Wrench, or a road test) or teardown (panels, covers or parts off, swapping parts).`;

export const TOOL_NAMES = {
  findUnit: "find_unit_manuals",
  search: "search_manual_pages",
  read: "read_manual_page",
  submit: "submit_diagnosis",
  web: "web_search",
} as const;

// The shop's own tools. Strict, so their inputs match the schemas; with
// eager_input_streaming (this is a streaming request) the API no longer
// checks them, so the app validates every input again before using it.
const CUSTOM_TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: TOOL_NAMES.findUnit,
    description:
      "Look up the unit in the shop's model list and point this conversation's manual searches at its manuals. Call it as soon as you know the model number (best; from the frame or VIN plate, like Z19VDE99AM), the 17-character VIN, or a year and model name (2019, \"RZR XP 1000\"). It returns the matching models and manuals and says whether it narrowed the search. If nothing matches, the manuals in use stay as they were.",
    input_schema: {
      type: "object",
      properties: {
        model_number: { type: "string", description: "The model number, e.g. Z19VDE99AM, or its start." },
        vin: {
          type: "string",
          description:
            "The unit's 17-character VIN, e.g. 4XASEE578PA123456. Its characters 4-8 and 10 give the model code and year, which find the model's variants (not the paint).",
        },
        description: { type: "string", description: "Model name words, e.g. RZR XP 1000 or Sportsman 570." },
        year: { type: "integer", description: "Model year, e.g. 2019." },
      },
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: TOOL_NAMES.read,
    description: `Read the text of one page of a manual the conversation is using (up to ${DIAGNOSE_LIMITS.pageTextCharacters.toLocaleString("en-US")} characters). Read a page before you give a spec or procedure from it; the page after often continues a procedure.`,
    input_schema: {
      type: "object",
      properties: {
        manual_id: { type: "string", description: "The manual_id from search_manual_pages." },
        page: { type: "integer", description: "Page number, from 1." },
      },
      required: ["manual_id", "page"],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: TOOL_NAMES.search,
    description: `Full-text search over the pages of the manuals this conversation is using (the unit's manuals once find_unit_manuals has found them, otherwise the shop's whole library). Use it before giving any spec, procedure or code definition. All plain words must match; it also takes "quoted phrases", OR, and -word. Fault codes like P0300 and part numbers match as whole words. Returns the best ${DIAGNOSE_LIMITS.searchHits} pages with a snippet each. When no page has all the words, it returns the pages with most of them (fault codes and part numbers count first) and says which words each has, and how many pages in manuals this conversation isn't using have all of them (not confirmed for this unit; they're counted, not returned).`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. P0300, \"ignition coil\" resistance." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: TOOL_NAMES.submit,
    description:
      "Send your answer to the tech's screen. Call it once at the end of your work on every message from the tech, after your searches. Text outside this tool isn't shown.",
    input_schema: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description: "Your chat message to the tech: plain text, short paragraphs or \"- \" bullets.",
        },
        likely_causes: {
          type: "array",
          description: "The full ranked list of likely causes as it stands now, most likely first, whatever the effort.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              system: {
                type: "string",
                enum: [...CAUSE_SYSTEMS],
                description: "The part of the machine the cause is in, lit up on the tech's diagram; other if none fits.",
              },
              likelihood: { type: "string", enum: ["high", "medium", "low"] },
              why: { type: "string", description: "One or two sentences on why it fits, or why it's ruled out." },
              status: { type: "string", enum: ["open", "ruled_out", "confirmed"] },
              check_effort: {
                type: "string",
                enum: [...EFFORTS],
                description: EFFORT_DESCRIPTION("How much work it is to confirm or rule this cause out"),
              },
              sources: { type: "array", items: SOURCE_SCHEMA },
            },
            required: ["title", "system", "likelihood", "why", "status", "check_effort", "sources"],
            additionalProperties: false,
          },
        },
        next_checks: {
          type: "array",
          description:
            "The steps that confirm or rule out the likely causes, at least one for every open cause (the quickest that settles it first), in the order to do them: quick checks, then tests, then teardown; within a tier, the most useful first.",
          items: {
            type: "object",
            properties: {
              tier: { type: "string", enum: [...EFFORTS], description: EFFORT_DESCRIPTION("How much work this check is") },
              action: { type: "string", description: "What to do." },
              causes: {
                type: "array",
                items: { type: "integer" },
                description:
                  "The number of every likely cause this check confirms or rules out (1 is the first in likely_causes); the tech sees it under each of them. An empty list only for a check that isn't about any one cause (stored codes, the battery's state of charge), which is shown first, as \"Start here\".",
              },
              expected: {
                type: "string",
                description: "Expected readings or specs from the manual, or an empty string when there are none.",
              },
              sources: { type: "array", items: SOURCE_SCHEMA },
            },
            required: ["tier", "action", "causes", "expected", "sources"],
            additionalProperties: false,
          },
        },
        safety_notes: { type: "array", items: { type: "string" } },
        questions_for_tech: {
          type: "array",
          description: "Only questions whose answers would change your advice.",
          items: { type: "string" },
        },
      },
      required: ["reply", "likely_causes", "next_checks", "safety_notes", "questions_for_tech"],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
];

// Anthropic's web search, run on their side. max_uses caps each API request
// (the API enforces it). Across one tech message it's a budget, not a hard
// cap: the prompt states it, and once a message has used it the loop tells
// Claude to stop searching (see diagnose-loop). No code_execution tool
// alongside: this version filters results itself.
const WEB_SEARCH_TOOL: Anthropic.Beta.Messages.BetaWebSearchTool20260209 = {
  type: "web_search_20260209",
  name: TOOL_NAMES.web,
  max_uses: DIAGNOSE_LIMITS.webSearches,
};

// The tools for a conversation, in a fixed order. Whether web search is in
// the list is decided when the conversation starts and never changes.
export function diagnoseTools(webSearch: boolean): Anthropic.Beta.Messages.BetaToolUnion[] {
  return webSearch ? [...CUSTOM_TOOLS, WEB_SEARCH_TOOL] : [...CUSTOM_TOOLS];
}

// Web search can be turned off for the whole app (DIAGNOSE_WEB_SEARCH=off).
// Conversations started while it was on get a tool_removal message.
export const WEB_SEARCH_ON_BY_DEFAULT = true;
export const webSearchEnabled = () =>
  (process.env.DIAGNOSE_WEB_SEARCH ?? (WEB_SEARCH_ON_BY_DEFAULT ? "on" : "off")).toLowerCase() !== "off";

// Server-side refusal fallbacks: when Claude's safety classifiers decline a
// message, the API runs it again on the model Anthropic recommends for that
// kind of refusal, in the same call. On unless DIAGNOSE_REFUSAL_FALLBACK=off.
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01";
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";
export const fallbacksEnabled = () => (process.env.DIAGNOSE_REFUSAL_FALLBACK ?? "on").toLowerCase() !== "off";

// Thinking can't be turned off on Claude Opus 5.5 and counts toward
// max_tokens, so there's room for it as well as the reply. A message that
// still runs out is retried once with the larger limit.
export const MAX_TOKENS = 32_000;
export const MAX_TOKENS_RETRY = 64_000;

// Prompt caching. Techs often reply after 10-30 minutes in the bay, longer
// than the 5-minute cache lives, so the conversation is cached for an hour:
// a cache write costs 2x input instead of 1.25x, but a read costs 0.05x, and
// re-writing the whole conversation after every coffee break costs more.
export const CACHE_TTL = "1h" as const;

const hasToolChanges = (messages: Anthropic.Beta.Messages.BetaMessageParam[]) =>
  messages.some(
    (message) =>
      message.role === "system" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_removal" || block.type === "tool_addition"),
  );

// One request of the loop. Adaptive thinking (the only kind on this model)
// at effort "high", set explicitly because the model's default is "medium".
// No temperature, top_p or top_k (the API version this SDK sends rejects
// them) and no assistant prefill. tool_choice stays "auto": forcing a tool is
// a 400 on this model, so the prompt and submit_diagnosis's description ask
// for the call and the loop checks it came.
//
// Claude's thinking blocks are tied to everything before them: the system
// prompt, the tools and every earlier message. The history is append-only,
// but a deploy that edits SYSTEM_PROMPT, a tool's description or a limit
// written into them changes that for every open conversation, and on
// accounts created since 2026-08-31 replaying the old blocks is then a 400
// that every retry repeats. "drop_block" has the API leave those blocks out
// instead (the loop logs it); the field needs its beta header, so the two
// always go together.
export function buildRequest(input: {
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  webSearch: boolean;
  maxTokens?: number;
}): Params {
  const betas: Anthropic.Beta.AnthropicBeta[] = [THINKING_BINDING_BETA];
  if (fallbacksEnabled()) betas.push(FALLBACK_BETA);
  if (hasToolChanges(input.messages)) betas.push(TOOL_CHANGES_BETA);
  return {
    model: DIAGNOSE_MODEL,
    max_tokens: input.maxTokens ?? MAX_TOKENS,
    stream: true,
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: "high" },
    betas,
    ...(fallbacksEnabled() ? { fallbacks: "default" as const } : {}),
    // Automatic caching for the growing conversation, plus a fixed
    // breakpoint at the end of the tools and system prompt, which every
    // conversation shares.
    cache_control: { type: "ephemeral", ttl: CACHE_TTL },
    tools: diagnoseTools(input.webSearch),
    tool_choice: { type: "auto" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: CACHE_TTL } }],
    messages: input.messages,
  };
}
