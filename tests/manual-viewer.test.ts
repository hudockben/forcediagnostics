// How the manual viewer reads a PDF from storage (storage-pdf.ts), with the
// real pdf.js and a stand-in for storage: a link that has run out is swapped
// for a new one and the part fetched again, for every page waiting on it;
// a part that can't be had (refused, the connection dropped, stalled, cut
// short) breaks the copy, so the viewer can open a fresh one, where pdf.js
// on its own would leave every page needing that part waiting for good.
// Also which page an address names (page-number.ts), which the server opens
// the viewer at and the viewer follows on Back and Forward. Needs no
// database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { pageFromAddress } from "../src/app/(app)/library/[manualId]/page-number";
import { openStoragePdf, type StorageLink } from "../src/app/(app)/library/[manualId]/storage-pdf";

type PdfJs = typeof import("pdfjs-dist");

const CHUNK = 128 * 1024;

// Laid out like a publishing tool's PDF: a page tree in nodes of five near
// the start, then each page's dict followed by its ~50 KB content stream.
// Page 7's lookup reads page 6's dict (same node), so both wait on one part.
function buildPdf(pages: number) {
  const parts: string[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (text: string) => {
    parts.push(text);
    length += Buffer.byteLength(text, "latin1");
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.4\n");
  const nodes = Math.ceil(pages / 5);
  const firstPage = 3 + nodes;
  const pageObj = (i: number) => firstPage + 2 * i;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${Array.from({ length: nodes }, (_, k) => `${3 + k} 0 R`).join(" ")}] /Count ${pages} >>`);
  for (let k = 0; k < nodes; k++) {
    const kids = Array.from({ length: 5 }, (_, j) => `${pageObj(5 * k + j)} 0 R`).join(" ");
    obj(3 + k, `<< /Type /Pages /Parent 2 0 R /Kids [${kids}] /Count 5 >>`);
  }
  for (let i = 0; i < pages; i++) {
    const page = pageObj(i);
    obj(page, `<< /Type /Page /Parent ${3 + Math.floor(i / 5)} 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R >>`);
    const content = `% page ${i + 1}\n` + "0 0 m\n".repeat(8500);
    obj(page + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  const count = firstPage + 2 * pages;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return { bytes: new Uint8Array(Buffer.from(parts.join(""), "latin1")), page6: offsets[pageObj(5)] };
}

const { bytes, page6 } = buildPdf(20);

type Request = { url: string; begin: number; end: number; signal: AbortSignal | null };
// What storage does with a request: undefined to answer it normally.
let storage: (request: Request) => Promise<Response | undefined> | Response | undefined = () => undefined;
const requests: Request[] = [];
const realFetch = globalThis.fetch;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PENDING = Symbol("pending");
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, sleep(ms).then(() => PENDING)]);
const holds = (request: Request, offset: number) => request.begin <= offset && offset < request.end;
const answer = (begin: number, end: number) =>
  new Response(bytes.slice(begin, end), {
    status: 206,
    headers: { "Content-Range": `bytes ${begin}-${end - 1}/${bytes.length}` },
  });
// Never answers; gives up when the request is aborted.
const never = (request: Request) =>
  new Promise<Response>((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

let pdfjs: PdfJs;
before(async () => {
  pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
  const require = createRequire(import.meta.url);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("Range") ?? "");
    assert.ok(match, "every request asks for a range");
    const request = { url: String(input), begin: Number(match[1]), end: Number(match[2]) + 1, signal: init?.signal ?? null };
    requests.push(request);
    return (await storage(request)) ?? answer(request.begin, request.end);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

// A link that lasts until renewed; counts the renewals.
function storageLink() {
  let number = 1;
  const link: StorageLink & { renewals: number } = {
    renewals: 0,
    current: () => `https://bucket.example/manual.pdf?link=${number}`,
    async renew(expired) {
      if (expired !== link.current()) return;
      link.renewals += 1;
      await sleep(20);
      number += 1;
    },
  };
  return link;
}

async function open(link: StorageLink, stallMs?: number) {
  const pdf = openStoragePdf(pdfjs, link, { sizeBytes: bytes.length, chunkBytes: CHUNK, stallMs });
  const doc = await pdf.loading.promise;
  await doc.getPage(1);
  return { pdf, doc };
}

describe("manual viewer: reading the PDF from storage", () => {
  test("a link that ran out is renewed once and the part fetched again, for every page waiting on it", async () => {
    storage = () => undefined;
    const link = storageLink();
    const { pdf, doc } = await open(link);
    // 15 minutes later: storage turns the first link down, after a while.
    const expired = link.current();
    storage = async (request) => {
      if (request.url !== expired) return undefined;
      await sleep(100);
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    };
    requests.length = 0;
    // Page 7 is asked for while page 6's request is on its way.
    const six = doc.getPage(6);
    await sleep(20);
    const seven = doc.getPage(7);
    const [shown6, shown7] = await Promise.all([within(six, 5000), within(seven, 5000)]);
    assert.notEqual(shown6, PENDING, "page 6 still loading");
    assert.notEqual(shown7, PENDING, "page 7 still loading");
    assert.equal(link.renewals, 1);
    assert.ok(requests.some((request) => request.url === expired && holds(request, page6)), "page 6's part asked for with the old link");
    assert.ok(requests.some((request) => request.url === link.current() && holds(request, page6)), "and again with the new one");
    assert.equal(await within(pdf.broken, 50), PENDING, "the copy isn't broken");
    // The next page loads through the same copy.
    assert.notEqual(await within(doc.getPage(12), 5000), PENDING);
    await pdf.loading.destroy();
  });

  test("a short file storage sends whole (200) for its one range opens; a longer whole file breaks the copy", async () => {
    const short = buildPdf(1).bytes;
    assert.ok(short.length < CHUNK);
    storage = () => new Response(short.slice(), { status: 200 });
    const pdf = openStoragePdf(pdfjs, storageLink(), { sizeBytes: short.length, chunkBytes: CHUNK });
    const doc = (await within(pdf.loading.promise, 5000)) as Awaited<typeof pdf.loading.promise> | typeof PENDING;
    assert.notEqual(doc, PENDING, "the short file opens");
    assert.notEqual(doc !== PENDING && (await within(doc.getPage(1), 5000)), PENDING, "and shows its page");
    await pdf.loading.destroy();

    storage = () => new Response(bytes.slice(), { status: 200 });
    const long = openStoragePdf(pdfjs, storageLink(), { sizeBytes: bytes.length, chunkBytes: CHUNK });
    void long.loading.promise.catch(() => {});
    await assert.rejects(within(long.broken, 5000), /Storage (sent more than|answered 200)/);
    await long.loading.destroy();
  });

  test("a part refused even with a new link breaks the copy", async () => {
    storage = () => undefined;
    const link = storageLink();
    const { pdf, doc } = await open(link);
    storage = (request) => (holds(request, page6) ? new Response("denied", { status: 403 }) : undefined);
    void doc.getPage(6).catch(() => {});
    void doc.getPage(7).catch(() => {});
    await assert.rejects(within(pdf.broken, 5000), /Storage answered 403/);
    assert.equal(link.renewals, 1);
    await pdf.loading.destroy();
  });

  test("a dropped connection, or a part cut short, breaks the copy", async () => {
    for (const [refusal, message] of [
      [() => Promise.reject(new TypeError("fetch failed")), /fetch failed/],
      [(request: Request) => answer(request.begin, request.end - 1000), /Storage sent \d+ of bytes/],
    ] as const) {
      storage = () => undefined;
      const { pdf, doc } = await open(storageLink());
      storage = (request) => (holds(request, page6) ? refusal(request) : undefined);
      void doc.getPage(6).catch(() => {});
      await assert.rejects(within(pdf.broken, 5000), message);
      await pdf.loading.destroy();
    }
  });

  test("a part that stops arriving breaks the copy; one that arrives slowly doesn't", async () => {
    storage = () => undefined;
    const stalled = await open(storageLink(), 300);
    let held: Request | undefined;
    storage = (request) => {
      if (!holds(request, page6)) return undefined;
      held = request;
      return never(request);
    };
    void stalled.doc.getPage(6).catch(() => {});
    await assert.rejects(within(stalled.pdf.broken, 5000), /stopped sending/);
    // Closing the copy gives up on the request.
    await stalled.pdf.loading.destroy();
    assert.equal(held?.signal?.aborted, true);

    // The same part a few KB at a time, 100 ms apart: well over 1 s in all,
    // but never a gap near it (so a busy machine doesn't trip it).
    storage = () => undefined;
    const slow = await open(storageLink(), 1000);
    storage = (request) => {
      if (!holds(request, page6)) return undefined;
      const piece = Math.ceil((request.end - request.begin) / 16);
      let sent = request.begin;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await sleep(100);
          const next = Math.min(sent + piece, request.end);
          controller.enqueue(bytes.slice(sent, next));
          sent = next;
          if (sent === request.end) controller.close();
        },
      });
      return new Response(body, { status: 206 });
    };
    assert.notEqual(await within(slow.doc.getPage(6), 5000), PENDING);
    assert.equal(await within(slow.pdf.broken, 50), PENDING);
    await slow.pdf.loading.destroy();
  });

  test("closing a copy stops its requests without breaking it", async () => {
    storage = () => undefined;
    const { pdf, doc } = await open(storageLink());
    let held: Request | undefined;
    storage = (request) => {
      if (!holds(request, page6)) return undefined;
      held = request;
      return never(request);
    };
    void doc.getPage(6).catch(() => {});
    await sleep(100);
    assert.ok(held, "page 6's part asked for");
    await pdf.loading.destroy();
    assert.equal(held.signal?.aborted, true);
    assert.equal(await within(pdf.broken, 100), PENDING);
  });
});

test("an address names a page of the manual, or page 1", () => {
  // As the page's searchParams has it, and as URLSearchParams.get has it.
  assert.equal(pageFromAddress("12", 30), 12);
  assert.equal(pageFromAddress(undefined, 30), 1);
  assert.equal(pageFromAddress(null, 30), 1);
  assert.equal(pageFromAddress(["3", "4"], 30), 1);
  for (const junk of ["", "abc", "2.5", "-"]) assert.equal(pageFromAddress(junk, 30), 1, junk);
  assert.equal(pageFromAddress("0", 30), 1);
  assert.equal(pageFromAddress("-4", 30), 1);
  assert.equal(pageFromAddress("999", 30), 30);
});
