// Copies what Tesseract.js needs in the browser into public/tesseract/,
// where the Scanned pages card on System Admin > Manuals loads it to read
// scanned pages (OCR): the worker script, the engine (WebAssembly, in the
// LSTM-only builds for browsers with and without SIMD) and the English
// language data. Served from the site itself, never a CDN, so OCR works
// without reaching anyone else. npm runs this before `dev` and `build`, so
// the copy always matches the installed packages; it isn't committed.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const modules = new URL("../node_modules/", import.meta.url);
const to = new URL("../public/tesseract/", import.meta.url);

const files = {
  "worker.min.js": "tesseract.js/dist/worker.min.js",
  // tesseract.js picks one by what the browser supports.
  "core/tesseract-core-relaxedsimd-lstm.wasm.js": "tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "core/tesseract-core-simd-lstm.wasm.js": "tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
  "core/tesseract-core-lstm.wasm.js": "tesseract.js-core/tesseract-core-lstm.wasm.js",
  // The LSTM-only "best" model in integers: what tesseract.js uses by default.
  "lang/eng.traineddata.gz": "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
};

rmSync(to, { recursive: true, force: true });
for (const [name, source] of Object.entries(files)) {
  const target = fileURLToPath(new URL(name, to));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(fileURLToPath(new URL(source, modules)), target);
}
