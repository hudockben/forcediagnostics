import { DrizzleQueryError } from "drizzle-orm";

import { rebateDownload } from "@/lib/rebates";
import { allows, lookupCurrentUser } from "@/lib/session";

// The Rebates tab's download: the invoices as read and checked on the page
// (sent as JSON), back as an Excel workbook: the NUSR sheet with the
// rebates in AO, AP and AQ, and the Rebates sheet. A POST, as the lines are
// too many for an address; it changes nothing.

// Far more than the largest invoice's lines take as JSON.
const MAX_BODY_BYTES = 2_000_000;

export async function POST(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return new Response("You've been signed out. Sign in again, then download it again.", { status: 401 });
  if (!allows(lookup.user, "sales.log")) return new Response("Your role can't open the NUSR.", { status: 403 });
  // JSON only: a form on another site can't send it without asking first.
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return new Response("Send the invoices as JSON.", { status: 415 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return new Response("That's too much to download at once.", { status: 413 });

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return new Response("That's too much to download at once.", { status: 413 });
    body = JSON.parse(text);
  } catch {
    return new Response("The invoices couldn't be read. Drop them again.", { status: 400 });
  }

  try {
    const result = await rebateDownload(lookup.user, body);
    if ("error" in result) return new Response(result.error, { status: 400 });
    return new Response(result.bytes, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": result.contentDisposition,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    // A DrizzleQueryError's message lists the query parameters.
    console.error("Couldn't write the rebates workbook", error instanceof DrizzleQueryError ? error.cause : error);
    return new Response("Couldn't make the workbook. Check the connection and try again.", { status: 500 });
  }
}
