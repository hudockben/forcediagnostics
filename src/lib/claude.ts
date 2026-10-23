import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { BrokenOffRequest, ClaudeStream } from "@/lib/diagnose-loop";
import { TOOL_NAMES } from "@/lib/diagnose-prompt";

// The Claude API client for Diagnose. ANTHROPIC_API_KEY is set in Vercel
// (Production and Preview); without it the Diagnose tab says it isn't set up.
// The SDK also reads ANTHROPIC_BASE_URL, which only the tests set, to point
// it at a stand-in API.

export const isClaudeConfigured = Boolean(process.env.ANTHROPIC_API_KEY);

let client: Anthropic | undefined;

function getClient() {
  // The key is passed explicitly so nothing else on the machine (an
  // ANTHROPIC_AUTH_TOKEN, a CLI profile) is picked up instead. The SDK
  // retries 429s, 5xx and dropped connections twice with backoff.
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
  return client;
}

// Partial reply text is sent to the browser at most this often.
const REPLY_EVERY_MS = 150;

// One streamed request. While it streams, it reports the web searches Claude
// runs and the reply text as submit_diagnosis's input arrives (with eager
// input streaming that's as it's written); it resolves with the whole
// message, or rejects with the SDK's typed error. The SDK's timeout only
// covers the wait for the response to start; the signal (Stop, or the
// message's deadline) ends it at any point.
export const streamFromClaude: ClaudeStream = async (params, { signal, timeoutMs, onNotice }) => {
  const stream = getClient().beta.messages.stream(params, { signal, timeout: timeoutMs });
  let submitIndex = -1;
  let sentAt = 0;
  let sent = "";
  const sendReply = (block: unknown, force: boolean) => {
    const now = Date.now();
    if (!force && now - sentAt < REPLY_EVERY_MS) return;
    let text: unknown;
    try {
      text = (block as { input?: { reply?: unknown } } | undefined)?.input?.reply;
    } catch {
      return;
    }
    if (typeof text !== "string" || text === sent) return;
    sentAt = now;
    sent = text;
    onNotice({ type: "reply", text });
  };
  stream.on("streamEvent", (event, snapshot) => {
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type === "tool_use" && block.name === TOOL_NAMES.submit) {
        submitIndex = event.index;
        sent = "";
        onNotice({ type: "writing" });
      }
    } else if (event.type === "content_block_delta") {
      if (event.index === submitIndex && event.delta.type === "input_json_delta") {
        sendReply(snapshot.content[event.index], false);
      }
    } else if (event.type === "content_block_stop") {
      const block = snapshot.content[event.index];
      if (block?.type === "server_tool_use" && block.name === "web_search") {
        const query = (block.input as { query?: unknown } | null)?.query;
        onNotice({ type: "web_search", id: block.id, query: typeof query === "string" ? query : "" });
      }
      if (event.index === submitIndex) sendReply(block, true);
    }
  });
  try {
    return await stream.finalMessage();
  } catch (error) {
    // A response that broke off part way still had its prompt billed.
    const partialMessage = stream.currentMessage;
    if (partialMessage && error instanceof Error) Object.assign(error, { partialMessage } satisfies BrokenOffRequest);
    throw error;
  }
};
