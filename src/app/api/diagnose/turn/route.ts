import { after } from "next/server";

import { streamFromClaude, isClaudeConfigured } from "@/lib/claude";
import { isProblem, prepareTurn, runTurn, type TurnRequest } from "@/lib/diagnose";
import { SETUP_MESSAGE, type StreamEvent } from "@/lib/diagnose-rules";
import { allows, lookupCurrentUser } from "@/lib/session";

// Sends one tech message to Claude and streams the work back as NDJSON: a
// "start" line, "progress" / "scope" / "reply" lines while Claude searches
// and writes, and an "end" line with the saved turn. If the browser goes away
// (a tablet sleeping, shop Wi-Fi dropping) the turn still finishes and is
// saved; reopening the conversation shows it.
//
// Vercel Fluid compute keeps the function for up to maxDuration seconds; the
// loop finishes well inside it (see TURN_DEADLINE_MS in src/lib/diagnose.ts).
export const maxDuration = 300;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

function readRequest(body: unknown): TurnRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  const start = value.start && typeof value.start === "object" ? (value.start as Record<string, unknown>) : null;
  return {
    conversationId: text(value.conversationId),
    text: text(value.text),
    retryTurnId: text(value.retryTurnId),
    start: start
      ? {
          modelNumber: text(start.modelNumber),
          vehicle: text(start.vehicle),
          brand: text(start.brand),
          year: text(start.year),
          model: text(start.model),
          complaint: text(start.complaint),
          faultCodes: text(start.faultCodes),
          checked: text(start.checked),
          message: text(start.message),
          from: text(start.from),
        }
      : undefined,
  };
}

export async function POST(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) {
    return Response.json({ error: "You've been signed out. Sign in again.", redirectTo: lookup.redirectTo }, { status: 401 });
  }
  const user = lookup.user;
  if (!allows(user, "diagnostics.work")) {
    return Response.json({ error: "Your role can't use Diagnose." }, { status: 403 });
  }
  if (!isClaudeConfigured) return Response.json({ error: SETUP_MESSAGE }, { status: 503 });

  // JSON only: browsers can't send that from another site without asking
  // first, so a form elsewhere can't post a message as the signed-in tech.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "That request couldn't be read." }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That request couldn't be read." }, { status: 400 });
  }
  const prepared = await prepareTurn(user, readRequest(body));
  if (isProblem(prepared)) return Response.json({ error: prepared.error }, { status: prepared.status });

  const encoder = new TextEncoder();
  let output: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
    },
    cancel() {
      output = null;
    },
  });
  const send = (event: StreamEvent) => {
    try {
      output?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      output = null;
    }
  };
  send({ type: "start", conversation: prepared.conversationView, turn: prepared.turnView });

  const work = runTurn(prepared, { client: streamFromClaude, emit: send })
    .catch((error) => console.error("Diagnose turn couldn't be saved", error))
    .finally(() => {
      try {
        output?.close();
      } catch {
        // Already closed by the browser.
      }
      output = null;
    });
  // Keeps the function running until the turn is saved, even once nobody is
  // reading the response.
  after(() => work);

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      // no-transform: compression would hold lines back.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
