import type { PDFDocumentLoadingTask } from "pdfjs-dist";

// The viewer's copy of a manual's PDF, read from storage a part at a time.
// pdf.js could fetch the parts itself, given the link, but it never asks
// again for a part whose request failed, and anything else that needs that
// part (the next page's entry, say) then waits for it for good, with no
// error. So the parts are fetched here: a link storage turns down (they last
// 15 minutes) is swapped for a new one and the part asked for again, and a
// part that can't be had at all breaks the copy, which every step waiting
// on it hears about through `broken`.

type PdfJs = typeof import("pdfjs-dist");

export type StorageLink = {
  // The link to fetch from now.
  current: () => string;
  // Gets a new link in place of `expired`, once for every request that
  // found it had run out.
  renew: (expired: string) => Promise<void>;
};

export type StoragePdf = {
  loading: PDFDocumentLoadingTask;
  // Rejects once a part of the file couldn't be fetched: what's waiting for
  // it would wait for good, so this copy is no use any more.
  broken: Promise<never>;
};

// A request that gets nothing for this long has stalled: a dead connection
// can take minutes to fail by itself. Big parts still arrive bit by bit.
export const STALL_MS = 30_000;

export function openStoragePdf(
  pdfjs: PdfJs,
  link: StorageLink,
  {
    sizeBytes,
    chunkBytes,
    wasmUrl,
    stallMs = STALL_MS,
  }: { sizeBytes: number; chunkBytes: number; wasmUrl?: string; stallMs?: number },
): StoragePdf {
  // Aborted when pdf.js closes the copy.
  const closed = new AbortController();
  let breakCopy: (reason: unknown) => void = () => {};
  const broken = new Promise<never>((_, reject) => (breakCopy = reject));
  // It may break with nothing waiting on it.
  broken.catch(() => {});

  const transport = new pdfjs.PDFDataRangeTransport(sizeBytes, null);
  transport.requestDataRange = (begin, end) => {
    const stalled = () => {
      if (!closed.signal.aborted) breakCopy(new Error("Storage stopped sending part of the file."));
    };
    fetchPart(link, begin, end, closed.signal, stalled, stallMs)
      .then((bytes) => {
        if (!closed.signal.aborted) transport.onDataRange(begin, bytes);
      })
      .catch((error) => {
        if (!closed.signal.aborted) breakCopy(error);
      });
  };
  transport.abort = () => closed.abort();

  const loading = pdfjs.getDocument({
    range: transport,
    // Only fetch what the page on screen needs.
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: chunkBytes,
    // Decoders for scanned-page images (CCITT, JBIG2, JPEG 2000).
    wasmUrl,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  return { loading, broken };
}

async function fetchPart(
  link: StorageLink,
  begin: number,
  end: number,
  signal: AbortSignal,
  stalled: () => void,
  stallMs: number,
) {
  let timer = setTimeout(stalled, stallMs);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(stalled, stallMs);
  };
  try {
    for (let renewed = false; ; renewed = true) {
      const url = link.current();
      const response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal });
      alive();
      // A range that starts at the beginning may come back as the whole file
      // (200), which is what was asked for when the file is that short; a
      // longer one is caught below.
      if ((response.status === 206 || (response.status === 200 && begin === 0)) && response.body) {
        const bytes = new Uint8Array(end - begin);
        let length = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (length + value.length > bytes.length) throw new Error(`Storage sent more than bytes ${begin}-${end - 1}.`);
          bytes.set(value, length);
          length += value.length;
          alive();
        }
        // pdf.js needs every byte it asked for.
        if (length !== bytes.length) throw new Error(`Storage sent ${length} of bytes ${begin}-${end - 1}.`);
        return bytes;
      }
      // Storage turns a link that has run out down with 403.
      if (response.status !== 403 || renewed) throw new Error(`Storage answered ${response.status}.`);
      await link.renew(url);
    }
  } finally {
    clearTimeout(timer);
  }
}
