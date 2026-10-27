import Anthropic from "@anthropic-ai/sdk";

import { MAX_TOKENS, MAX_TOKENS_RETRY, TOOL_NAMES, buildRequest } from "@/lib/diagnose-prompt";
import {
  DIAGNOSE_LIMITS,
  DIAGNOSE_MODEL,
  FULL_BY_LENGTH,
  addSeen,
  emptySeen,
  emptyUsage,
  estimateCostCents,
  submittedProblem,
  type ProgressKind,
  type SeenSources,
  type TurnUsage,
} from "@/lib/diagnose-rules";
import { cutText } from "@/lib/manual-rules";

// The agent loop for one tech message: send the conversation, run the tools
// Claude asks for, send their results, and repeat until Claude calls
// submit_diagnosis. It only knows the API and the tools it's given, so tests
// can drive it with a scripted client (src/lib/diagnose.ts wires it up).
//
// History is append-only. `history` (every earlier finished message) goes
// out unchanged at the front of every request; this message's own messages
// are appended after it, Claude's content blocks exactly as they came back
// (thinking, tool_use, web search blocks and all). Nothing earlier is ever
// edited or dropped: Claude Opus 5.5's thinking blocks are tied to the exact
// conversation that produced them, and the prompt cache is a prefix match.

type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type RequestParams = ReturnType<typeof buildRequest>;

// What the client adapter reports while a response streams in.
export type StreamNotice =
  | { type: "web_search"; id: string; query: string }
  | { type: "writing" }
  | { type: "reply"; text: string };

// One streamed API request, resolved with the final message. The real one
// is in src/lib/claude.ts; tests pass a scripted one.
export type ClaudeStream = (
  params: RequestParams,
  options: { signal: AbortSignal; timeoutMs: number; onNotice: (notice: StreamNotice) => void },
) => Promise<Message>;

// What a request that broke off part way (stopped, cut off at the deadline,
// an error in the stream) had already reported about itself: message_start's
// input and cache counts, which are billed all the same. The client adds it
// to the error it rejects with.
export type BrokenOffRequest = { partialMessage?: Pick<Message, "model" | "usage"> };

export type LocalToolName = typeof TOOL_NAMES.findUnit | typeof TOOL_NAMES.search | typeof TOOL_NAMES.read;

export type ToolOutcome = {
  result: unknown;
  isError?: boolean;
  seen?: Partial<SeenSources>;
  progress?: { kind: ProgressKind; label: string };
};

export type ToolHandler = (name: LocalToolName, input: Record<string, unknown>) => Promise<ToolOutcome>;

export type FailureReason =
  | "refusal"
  | "max_tokens"
  | "steps"
  | "too_long"
  | "rate_limited"
  | "overloaded"
  | "setup"
  | "billing"
  | "bad_request"
  | "connection"
  | "timeout"
  | "stopped"
  | "error";

export type LoopResult =
  | {
      status: "done";
      appended: MessageParam[];
      // submit_diagnosis's input, or null when Claude never sent one.
      submitted: unknown;
      // Claude's last plain text, for when it didn't.
      text: string;
      capped: boolean;
      seen: SeenSources;
      usage: TurnUsage;
    }
  | { status: "failed" | "stopped"; reason: FailureReason; message: string; seen: SeenSources; usage: TurnUsage };

export const FAILURE_MESSAGES: Record<FailureReason, string> = {
  refusal:
    "Claude declined to answer this one. Try rewording it around the repair (the symptom, the codes, what you've checked), then retry.",
  max_tokens: "Claude's answer ran past its length limit. Retry, or ask about one system at a time.",
  steps: "Claude ran out of steps on this one. Retry, or ask about one system at a time.",
  too_long: FULL_BY_LENGTH,
  rate_limited: "Anthropic's API is busy for this account right now (rate limited). Wait a minute, then retry.",
  overloaded: "Anthropic's API is overloaded or having trouble right now. Wait a minute, then retry.",
  setup: "The Anthropic API key isn't working. An admin needs to check ANTHROPIC_API_KEY in Vercel.",
  billing:
    "Anthropic's API turned this down for a billing reason. An admin needs to check the plan and credits in the Claude Console.",
  bad_request: "Anthropic's API couldn't take this request. Retry; if it keeps happening, tell an admin.",
  connection: "Couldn't reach Anthropic's API. Check the shop's internet connection, then retry.",
  timeout: "Claude took too long on this one. Retry, or ask about one system at a time.",
  stopped: "Stopped. Retry to send it again.",
  error: "Something went wrong talking to Claude. Retry.",
};

// The API has also turned a request down for an account out of credit with
// a 400 ("Your credit balance is too low to access the Anthropic API"), not
// a 402: that's billing too.
function outOfCredit(error: InstanceType<typeof Anthropic.APIError>) {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const said = typeof body?.error?.message === "string" ? body.error.message : error.message;
  return /credit balance/i.test(said);
}

// Sorts an error from the SDK into what the tech is told. Most specific
// class first: they all extend APIError.
export function classifyError(error: unknown): FailureReason {
  if (error instanceof Anthropic.APIUserAbortError) return "stopped";
  if (error instanceof Anthropic.RateLimitError) return "rate_limited";
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return "setup";
  if (error instanceof Anthropic.NotFoundError) return "setup";
  if (error instanceof Anthropic.BadRequestError) return outOfCredit(error) ? "billing" : "bad_request";
  if (error instanceof Anthropic.InternalServerError) return "overloaded";
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "connection";
  if (error instanceof Anthropic.APIError) {
    // An error the API sent part way through a stream (an `error` event, no
    // HTTP status, often an overload during a long answer), or a status the
    // SDK has no class for (402): sorted by the error's type.
    if (error.status === 402 || error.type === "billing_error") return "billing";
    if (error.type === "overloaded_error" || error.type === "api_error") return "overloaded";
    if (error.type === "rate_limit_error") return "rate_limited";
    if (error.type === "timeout_error") return "timeout";
    return error.status === 413 ? "too_long" : "error";
  }
  return "error";
}

// For the failures someone has to look into (a request the API turned down,
// the key, billing, anything unrecognised), what the API itself said goes
// after the plain message and into the log, so a screenshot or the Vercel
// log shows what to fix. The API never echoes the key back.
const NEEDS_DETAIL: ReadonlySet<FailureReason> = new Set(["bad_request", "setup", "billing", "error"]);

export function apiErrorDetail(error: unknown): string | null {
  if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIUserAbortError) return null;
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const said = typeof body?.error?.message === "string" ? body.error.message : error.message;
  const parts = [error.status ? String(error.status) : null, error.type, said, error.requestID ? `request ${error.requestID}` : null];
  return cutText(parts.filter(Boolean).join(" · "), 400);
}

// An overload reported part way through a stream ends that request, and the
// SDK only retries before a stream starts: the loop tries once more itself,
// after this pause.
const MID_STREAM_RETRY_PAUSE_MS = 2000;

// The max_tokens retry asks for up to 64,000 tokens, minutes of streaming at
// effort high: with less time than this left for the message it couldn't
// finish, so the message fails at once instead.
const RETRY_ROOM_MS = 120_000;

// A response's content as it goes back into the history. Unchanged, except
// after a refusal fallback inside the response: the declined model's
// thinking, tool calls, and server tool calls without their results that
// came before the last fallback block are left out, as the fallback docs
// say to (text, paired server-tool blocks and everything after it stay).
export function echoableContent(content: ContentBlock[]): ContentBlockParam[] {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  if (boundary === -1) return content as ContentBlockParam[];
  const answered = new Set(
    content.flatMap((block) => ("tool_use_id" in block && typeof block.tool_use_id === "string" ? [block.tool_use_id] : [])),
  );
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    if (block.type === "text" || block.type === "fallback") return true;
    if (block.type === "server_tool_use") return answered.has(block.id);
    if (block.type.endsWith("_tool_result")) return true;
    return false;
  }) as ContentBlockParam[];
}

// The tool calls of a response that this app runs: after the last fallback
// block, since the declined part was never finished.
function clientToolUses(content: ContentBlock[]) {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  return content
    .slice(boundary + 1)
    .filter((block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === "tool_use");
}

// The web pages Claude's web searches returned in a response, which web
// citations are checked against.
export function webPagesIn(content: readonly unknown[]): SeenSources["urls"] {
  const urls: SeenSources["urls"] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result.type === "web_search_result") urls.push({ url: result.url, title: result.title });
      }
    }
    if (block.type === "text") {
      for (const citation of block.citations ?? []) {
        if (citation.type === "web_search_result_location") {
          urls.push({ url: citation.url, title: citation.title ?? citation.url });
        }
      }
    }
  }
  return urls;
}

type Iteration = NonNullable<Message["usage"]["iterations"]>[number];
type SamplingStep = Extract<Iteration, { type: "message" | "fallback_message" }>;
const isSamplingStep = (entry: Iteration): entry is SamplingStep =>
  entry.type === "message" || entry.type === "fallback_message";

// The billed parts of one response, each with the model that ran it. With
// usage.iterations, one per sampling step: the steps of a server-side web
// search, and when a refusal fallback ran, the declined attempt and the
// fallback model's (the top-level counts cover only the attempt that
// produced the message). Without it, the top-level counts.
function billedParts(response: Pick<Message, "model" | "usage">) {
  const u = response.usage;
  const steps = (u.iterations ?? []).filter(isSamplingStep);
  const parts = steps.length > 0 ? steps : [u];
  return parts.map((part) => ({
    model: ("model" in part && part.model) || (steps.length > 0 ? DIAGNOSE_MODEL : response.model),
    input: part.input_tokens ?? 0,
    output: part.output_tokens ?? 0,
    cacheRead: part.cache_read_input_tokens ?? 0,
    write: part.cache_creation_input_tokens ?? 0,
    write5m: part.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    write1h: part.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  }));
}

function addUsage(usage: TurnUsage, response: Pick<Message, "model" | "usage">) {
  const parts = billedParts(response);
  usage.requests += 1;
  for (const part of parts) {
    // Without the breakdown, writes are at the TTL the request asked for.
    const split = part.write5m + part.write1h > 0;
    const tokens = {
      inputTokens: part.input,
      outputTokens: part.output,
      cacheReadTokens: part.cacheRead,
      cacheWrite5mTokens: split ? part.write5m : 0,
      cacheWrite1hTokens: split ? part.write1h : part.write,
      webSearches: 0,
    };
    usage.inputTokens += tokens.inputTokens;
    usage.outputTokens += tokens.outputTokens;
    usage.cacheReadTokens += tokens.cacheReadTokens;
    usage.cacheWrite5mTokens += tokens.cacheWrite5mTokens;
    usage.cacheWrite1hTokens += tokens.cacheWrite1hTokens;
    usage.costCents += estimateCostCents(tokens, part.model);
  }
  const searches = response.usage.server_tool_use?.web_search_requests ?? 0;
  usage.webSearches += searches;
  usage.costCents += estimateCostCents({ ...emptyUsage(), webSearches: searches });
  // How big the conversation has become: the prompt of the last sampling
  // step. The top-level counts add up every step of a server-side web
  // search, so they'd overstate it several times over.
  const last = parts.at(-1)!;
  usage.contextTokens = last.input + last.cacheRead + last.write;
  // A refusal fallback model answered (the served-by signal, which also
  // covers turns that stay on the fallback model with no fallback block).
  if ((response.usage.iterations ?? []).some((entry) => entry.type === "fallback_message") && !usage.servedBy.includes(response.model)) {
    usage.servedBy.push(response.model);
  }
}

const NUDGE =
  "Please send your answer to the tech with submit_diagnosis: it's the only way it reaches their screen.";
const LAST_STEP =
  "This is the last step for this message: don't call any more tools, call submit_diagnosis now with what you have, and say what you couldn't get to.";
const WEB_DONE = `That's the ${DIAGNOSE_LIMITS.webSearches} web searches this message allows: don't search the web again for it.`;

const toolLimits: Record<LocalToolName, { limit: number; what: string }> = {
  [TOOL_NAMES.findUnit]: { limit: DIAGNOSE_LIMITS.unitLookups, what: "unit lookups" },
  [TOOL_NAMES.search]: { limit: DIAGNOSE_LIMITS.manualSearches, what: "manual searches" },
  [TOOL_NAMES.read]: { limit: DIAGNOSE_LIMITS.pageReads, what: "page reads" },
};

const isLocalTool = (name: string): name is LocalToolName => name in toolLimits;

export async function runDiagnosisLoop(input: {
  client: ClaudeStream;
  history: MessageParam[];
  // This message's opening messages (the tech's text and any app note).
  opening: MessageParam[];
  webSearch: boolean;
  tools: ToolHandler;
  signal: AbortSignal;
  // When the whole message must be finished by (Date.now() time).
  deadline: number;
  // Past this, the next tool results ask Claude to wrap up.
  softDeadline: number;
  onProgress: (kind: ProgressKind, label: string) => void;
  onReply?: (text: string) => void;
}): Promise<LoopResult> {
  const appended: MessageParam[] = [...input.opening];
  const seen = emptySeen();
  const usage = emptyUsage();
  const used: Record<LocalToolName, number> = {
    [TOOL_NAMES.findUnit]: 0,
    [TOOL_NAMES.search]: 0,
    [TOOL_NAMES.read]: 0,
  };
  const announced = new Set<string>();
  let maxTokens = MAX_TOKENS;
  let nudged = false;
  let lastStep = false;
  let webNoted = false;
  let unparseable = 0;
  let retriedMidStream = false;
  let text = "";

  const fail = (reason: FailureReason, message = FAILURE_MESSAGES[reason]): LoopResult => ({
    status: reason === "stopped" ? "stopped" : "failed",
    reason,
    message,
    seen,
    usage,
  });
  const announceWeb = (id: string, query: string) => {
    if (announced.has(id)) return;
    announced.add(id);
    input.onProgress("web", `Searching the web: ${query}`);
  };

  input.onProgress("thinking", "Thinking it over");
  while (true) {
    if (input.signal.aborted) return fail("stopped");
    const remaining = input.deadline - Date.now();
    if (remaining <= 5000) return fail("timeout");

    const params = buildRequest({
      messages: [...input.history, ...appended],
      webSearch: input.webSearch,
      maxTokens,
    });
    // The deadline also cuts off a request that's still streaming: the
    // SDK's timeout only covers the wait for the response to start, and past
    // maxDuration Vercel would end the function before anything was saved.
    const late = new AbortController();
    const lateTimer = setTimeout(() => late.abort(), remaining);
    let message: Message;
    try {
      message = await input.client(params, {
        signal: AbortSignal.any([input.signal, late.signal]),
        timeoutMs: remaining,
        onNotice: (notice) => {
          if (notice.type === "web_search") announceWeb(notice.id, notice.query);
          else if (notice.type === "writing") input.onProgress("writing", "Writing the answer");
          else input.onReply?.(notice.text);
        },
      });
    } catch (error) {
      const partial = (error as BrokenOffRequest | null)?.partialMessage;
      if (partial?.usage) addUsage(usage, partial);
      if (input.signal.aborted) return fail("stopped");
      // Checked before classifyError, which would call the abort a Stop.
      if (late.signal.aborted) return fail("timeout");
      // The SDK couldn't parse a tool input it streamed (eager input
      // streaming): ask again, a couple of times at most. API errors (which
      // the SDK has already retried where that helps) end the message.
      if (!(error instanceof Anthropic.APIError) && error instanceof Anthropic.AnthropicError && unparseable < 2) {
        unparseable += 1;
        continue;
      }
      const reason = classifyError(error);
      if (reason === "overloaded" && error instanceof Anthropic.APIError && error.status === undefined && !retriedMidStream) {
        retriedMidStream = true;
        await new Promise((resolve) => setTimeout(resolve, MID_STREAM_RETRY_PAUSE_MS));
        continue;
      }
      const detail = apiErrorDetail(error);
      console.error(`Diagnose request failed (${reason})`, detail ?? error);
      return fail(reason, detail && NEEDS_DETAIL.has(reason) ? `${FAILURE_MESSAGES[reason]} Anthropic said: ${detail}` : undefined);
    } finally {
      clearTimeout(lateTimer);
    }
    unparseable = 0;
    addUsage(usage, message);
    // Thinking blocks the API dropped because the conversation before them
    // changed (a deploy that edited the system prompt or a tool, say): the
    // message carries on without that reasoning, but it shouldn't happen
    // otherwise. Drops after a refusal fallback (model_binding_mismatch) are
    // expected.
    const edited = (message.input_transformations ?? []).filter((entry) => entry.reason === "prefix_binding_mismatch");
    if (edited.length > 0) {
      console.warn("Diagnose: earlier thinking didn't match the conversation", edited.map((entry) => `${entry.type} ${entry.path}`));
    }

    // The stop reason comes first: a refused or cut-off response is never
    // read as an answer, and never goes into the history.
    if (message.stop_reason === "refusal") return fail("refusal");
    if (message.stop_reason === "model_context_window_exceeded") return fail("too_long");
    if (message.stop_reason === "max_tokens") {
      // A tool input cut off here can still look whole, so the response is
      // dropped and asked for again with more room, if there's time for it.
      if (maxTokens < MAX_TOKENS_RETRY && input.deadline - Date.now() > RETRY_ROOM_MS) {
        maxTokens = MAX_TOKENS_RETRY;
        continue;
      }
      return fail("max_tokens");
    }

    const content = echoableContent(message.content);
    appended.push({ role: "assistant", content });
    addSeen(seen, { urls: webPagesIn(message.content) });
    for (const block of message.content) {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        announceWeb(block.id, String((block.input as { query?: unknown }).query ?? ""));
      }
      if (block.type === "text" && block.text.trim()) text = block.text;
    }

    // Web search ran out of server-side steps; sending the paused turn back
    // as it is lets it carry on.
    if (message.stop_reason === "pause_turn") {
      // Out of steps mid-search: a paused turn can't be left in the history
      // unfinished, so this message fails rather than being kept.
      if (usage.requests >= DIAGNOSE_LIMITS.modelRequests) return fail("steps");
      continue;
    }

    const toolUses = clientToolUses(message.content);
    const submit = toolUses.find((use) => use.name === TOOL_NAMES.submit);
    if (submit) {
      const problem = submittedProblem(submit.input);
      const results: ToolResult[] = toolUses.map((use) =>
        use === submit
          ? problem
            ? { type: "tool_result", tool_use_id: use.id, is_error: true, content: `${problem} Call submit_diagnosis again.` }
            : { type: "tool_result", tool_use_id: use.id, content: "Shown to the tech." }
          : { type: "tool_result", tool_use_id: use.id, is_error: true, content: "Not run: the answer was already sent." },
      );
      appended.push({ role: "user", content: results });
      if (!problem) return { status: "done", appended, submitted: submit.input, text, capped: false, seen, usage };
      if (usage.requests >= DIAGNOSE_LIMITS.modelRequests) {
        return { status: "done", appended, submitted: null, text, capped: true, seen, usage };
      }
      continue;
    }

    if (toolUses.length === 0) {
      // Finished without the structured reply: ask once, then make do with
      // its text.
      if (!nudged && usage.requests < DIAGNOSE_LIMITS.modelRequests) {
        nudged = true;
        appended.push({ role: "user", content: [{ type: "text", text: NUDGE }] });
        continue;
      }
      return { status: "done", appended, submitted: null, text, capped: false, seen, usage };
    }

    // Out of steps: the tool calls are answered (every tool_use needs its
    // result before the next message) but not run.
    if (usage.requests >= DIAGNOSE_LIMITS.modelRequests || lastStep) {
      appended.push({
        role: "user",
        content: toolUses.map((use) => ({
          type: "tool_result" as const,
          tool_use_id: use.id,
          is_error: true,
          content: "Not run: this message is out of steps.",
        })),
      });
      return { status: "done", appended, submitted: null, text, capped: true, seen, usage };
    }

    const results: ContentBlockParam[] = [];
    for (const use of toolUses) {
      if (input.signal.aborted) return fail("stopped");
      if (!isLocalTool(use.name)) {
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `There's no tool called ${use.name}.` });
        continue;
      }
      const limit = toolLimits[use.name];
      if (used[use.name] >= limit.limit) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: `Limit reached: that's the ${limit.limit} ${limit.what} this message allows. Don't call more tools for it; call submit_diagnosis with what you have.`,
        });
        continue;
      }
      used[use.name] += 1;
      const toolInput = typeof use.input === "object" && use.input !== null ? (use.input as Record<string, unknown>) : {};
      let outcome: ToolOutcome;
      try {
        outcome = await input.tools(use.name, toolInput);
      } catch (error) {
        console.error(`Diagnose tool ${use.name} failed`, error);
        outcome = { result: { error: "The tool failed on the shop's side. Try again or carry on without it." }, isError: true };
      }
      if (outcome.progress) input.onProgress(outcome.progress.kind, outcome.progress.label);
      if (outcome.seen) addSeen(seen, outcome.seen);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        ...(outcome.isError ? { is_error: true } : {}),
        content: JSON.stringify(outcome.result),
      });
    }
    // Notes go after the results, in the same message, and stay there.
    if (usage.requests >= DIAGNOSE_LIMITS.modelRequests - 1 || Date.now() > input.softDeadline) {
      lastStep = true;
      results.push({ type: "text", text: LAST_STEP });
    } else if (input.webSearch && usage.webSearches >= DIAGNOSE_LIMITS.webSearches && !webNoted) {
      webNoted = true;
      results.push({ type: "text", text: WEB_DONE });
    }
    appended.push({ role: "user", content: results });
  }
}
