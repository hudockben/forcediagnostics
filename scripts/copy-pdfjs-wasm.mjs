// Copies pdf.js's image decoders (WebAssembly, with plain JavaScript
// fallbacks) into public/pdfjs/wasm/, where the manual viewer loads them to
// draw scanned pages (CCITT, JBIG2 and JPEG 2000 images). npm runs this
// before `dev` and `build`, so the copy always matches the installed
// pdfjs-dist; it isn't committed.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../node_modules/pdfjs-dist/wasm/", import.meta.url));
const to = fileURLToPath(new URL("../public/pdfjs/wasm/", import.meta.url));

rmSync(to, { recursive: true, force: true });
// The viewer doesn't run scripts inside PDFs, so the scripting engine stays out.
cpSync(from, to, { recursive: true, filter: (source) => !source.includes("quickjs") });
