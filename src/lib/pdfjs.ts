// pdf.js, loaded on first use and only in the browser: it needs the DOM and
// a web worker, and it's too big to ship with every page. The legacy build
// also runs on older tablet browsers.

type PdfJs = typeof import("pdfjs-dist");

// pdf.js's image decoders for scanned pages, copied into public/ by
// scripts/copy-pdfjs-wasm.mjs (the getDocument wasmUrl option).
export const PDFJS_WASM_URL = "/pdfjs/wasm/";

let loading: Promise<PdfJs> | undefined;

export function loadPdfJs(): Promise<PdfJs> {
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs").then(
    (pdfjs) => {
      // The bundler copies the worker into the build and gives back its URL.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    },
    (error) => {
      // Let the next call try again (a dropped connection, say).
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

// What to tell someone when pdf.js can't open a file.
export function describePdfError(error: unknown) {
  switch ((error as { name?: string } | null)?.name) {
    case "PasswordException":
      return "This PDF is password-protected. Save a copy without the password and add that.";
    case "InvalidPDFException":
      return "This file isn't a readable PDF. It may be damaged or only partly downloaded.";
    default:
      return "This PDF couldn't be opened. It may be damaged.";
  }
}
