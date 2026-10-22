// The model list: Polaris's spreadsheet of which models each manual covers
// ("manual-list - All.csv"), imported under System Admin > Manuals. The
// uploader reads the CSV in the browser and sends it in batches; the server
// checks every field again with normalizeCatalogFile before saving it. Kept
// free of database imports so browser code can use it.

import { CsvError, parseCsv } from "@/lib/csv";

// The first row, exactly as Polaris's export script writes it.
export const CATALOG_HEADER = [
  "File",
  "Brand",
  "Article",
  "Posted On",
  "Title",
  "Model Years",
  "Year",
  "Model Number",
  "Model Description",
] as const;

export const CATALOG_LIMITS = {
  fileName: 255,
  brand: 40,
  article: 200,
  title: 500,
  modelYears: 200,
  modelNumber: 64,
  modelDescription: 300,
} as const;

export const MIN_MODEL_YEAR = 1950;
export const MAX_MODEL_YEAR = 2100;
export const MAX_MODELS_PER_FILE = 5000;

// A year or a range of years in an entry's Model Years text, as a Postgres
// regular expression: "2020, 2022" lists two, "2018-2027" ten.
export const MODEL_YEARS_PATTERN = "(\\d{4})(?:\\s*[-–]\\s*(\\d{4}))?";

// Entries go to the server in batches and a file's models are never split
// between two. Server Action requests are capped at 1 MB, so batches stay at
// about half that, and one file can't be bigger than most of it.
export const CATALOG_BATCH_BYTES = 512 * 1024;
export const MAX_CATALOG_FILE_BYTES = 900 * 1024;
export const MAX_CATALOG_FILES_PER_BATCH = 500;
export const MAX_CATALOG_MODELS_PER_BATCH = 20000;

// [year, model number, description]: any of them can be missing, not all.
export type CatalogModel = [year: number | null, number: string | null, description: string | null];

// One manual's entry, as the browser sends it and the server saves it.
export type CatalogFile = {
  fileName: string;
  brand: string | null;
  article: string | null;
  title: string | null;
  // YYYY-MM-DD
  postedOn: string | null;
  modelYears: string | null;
  models: CatalogModel[];
};

// The model list finds a manual by its file name, whatever the case. (The
// database works out its own key with lower(); this one groups rows.)
export const catalogKey = (fileName: string) => fileName.toLowerCase();

// What the Library calls Polaris's category codes (the list's Brand column),
// and which kind of vehicle each is, for the Vehicle filter. A code that
// isn't here shows as it is, under Other.
export const VEHICLES = ["UTV", "ATV", "Generator", "Other"] as const;
export type Vehicle = (typeof VEHICLES)[number];

export const VEHICLE_NAMES: Record<Vehicle, string> = {
  UTV: "UTVs (side-by-sides)",
  ATV: "ATVs",
  Generator: "Generators",
  Other: "Other",
};

export type BrandInfo = { label: string; vehicle: Vehicle };

// In the order the Library lists them within a vehicle.
const BRANDS = new Map<string, BrandInfo>([
  ["RGR", { label: "Ranger", vehicle: "UTV" }],
  ["RZR", { label: "RZR", vehicle: "UTV" }],
  ["GRL", { label: "General", vehicle: "UTV" }],
  ["XXP", { label: "Xpedition", vehicle: "UTV" }],
  ["ATV", { label: "ATV", vehicle: "ATV" }],
  ["GEN", { label: "Generators", vehicle: "Generator" }],
]);

export const KNOWN_BRANDS = [...BRANDS.keys()];

export const brandInfo = (code: string): BrandInfo => BRANDS.get(code) ?? { label: code, vehicle: "Other" };
export const brandLabel = (code: string) => brandInfo(code).label;

export const isVehicle = (value: unknown): value is Vehicle => VEHICLES.includes(value as Vehicle);

// The codes a vehicle is made of. Other has no list: it's every code that
// isn't in the table.
export const brandsOf = (vehicle: Exclude<Vehicle, "Other">) =>
  KNOWN_BRANDS.filter((code) => brandInfo(code).vehicle === vehicle);

// Whether the Vehicle filter lists a vehicle's codes under it as well. A
// vehicle that is one code (ATVs, Generators) is just itself.
export const listsBrands = (vehicle: Vehicle) => vehicle === "Other" || brandsOf(vehicle).length > 1;

// Brands in the order the Library shows them: by vehicle, then as in the
// table (Ranger, RZR, General, Xpedition), then other codes A to Z.
export function compareBrands(a: string, b: string) {
  const rank = (code: string) => {
    const known = KNOWN_BRANDS.indexOf(code);
    return [VEHICLES.indexOf(brandInfo(code).vehicle), known === -1 ? KNOWN_BRANDS.length : known];
  };
  const [[vehicleA, orderA], [vehicleB, orderB]] = [rank(a), rank(b)];
  return vehicleA - vehicleB || orderA - orderB || (a < b ? -1 : a > b ? 1 : 0);
}

// "Ranger, RZR": a manual's brands as the Library shows them.
export const brandLabels = (codes: readonly string[]) => [...codes].sort(compareBrands).map(brandLabel).join(", ");

const sameHeading = (a: string, b: string) => a.trim().toLowerCase() === b.toLowerCase();

export function isCatalogHeader(row: readonly string[]) {
  return row.length === CATALOG_HEADER.length && CATALOG_HEADER.every((name, i) => sameHeading(row[i], name));
}

// Text as stored: line breaks and other control characters become spaces,
// runs of spaces become one, and a blank field is null.
export function cleanCatalogText(value: string): string | null {
  const text = value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return text || null;
}

// File as stored: only trimmed, the way the uploader stores a PDF's name
// (src/lib/manuals.ts), so a name with two spaces or a no-break space in it
// still matches its PDF. A blank field is null.
export const cleanCatalogFileName = (value: string): string | null => value.trim() || null;

function isRealDate(year: number, month: number, day: number) {
  if (year < MIN_MODEL_YEAR || year > MAX_MODEL_YEAR) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// "6/24/2024", as Polaris lists it, or "2024-06-24" -> "2024-06-24". Null
// when it isn't a real date from 1950 to 2100.
export function parsePostedOn(value: string): string | null {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parts = us ? [us[3], us[1], us[2]] : iso ? [iso[1], iso[2], iso[3]] : null;
  if (!parts) return null;
  const [year, month, day] = parts.map(Number);
  if (!isRealDate(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export const isModelYear = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= MIN_MODEL_YEAR && (value as number) <= MAX_MODEL_YEAR;

const FIELD_NAMES = {
  fileName: "File",
  brand: "Brand",
  article: "Article",
  title: "Title",
  modelYears: "Model Years",
  modelNumber: "Model Number",
  modelDescription: "Model Description",
} as const;

class Invalid extends Error {}

function text(value: unknown, field: keyof typeof CATALOG_LIMITS): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Invalid(`${FIELD_NAMES[field]} isn't text.`);
  const cleaned = cleanCatalogText(value);
  if (cleaned && cleaned.length > CATALOG_LIMITS[field]) {
    throw new Invalid(`${FIELD_NAMES[field]} is longer than ${CATALOG_LIMITS[field]} characters.`);
  }
  return cleaned;
}

// Checks and tidies one entry: every field, whoever sent it. Model numbers
// are upper-cased, and a model listed twice is kept once.
export function normalizeCatalogFile(input: unknown): { file: CatalogFile } | { problem: string } {
  try {
    if (typeof input !== "object" || input === null) throw new Invalid("The entry is empty.");
    const entry = input as Record<string, unknown>;
    if (typeof entry.fileName !== "string") throw new Invalid("File isn't text.");
    const fileName = cleanCatalogFileName(entry.fileName);
    if (!fileName) throw new Invalid("File is blank.");
    if (fileName.length > CATALOG_LIMITS.fileName) {
      throw new Invalid(`File is longer than ${CATALOG_LIMITS.fileName} characters.`);
    }
    // No file name has one, and Postgres text can't hold a NUL.
    if (/[\u0000-\u001f\u007f]/.test(fileName)) throw new Invalid("File has a line break or control character.");
    let postedOn: string | null = null;
    if (entry.postedOn !== null) {
      postedOn = typeof entry.postedOn === "string" ? parsePostedOn(entry.postedOn) : null;
      if (!postedOn || postedOn !== entry.postedOn) throw new Invalid("Posted On isn't a date.");
    }
    if (!Array.isArray(entry.models)) throw new Invalid("The models aren't a list.");
    if (entry.models.length > MAX_MODELS_PER_FILE) {
      throw new Invalid(`It lists more than ${MAX_MODELS_PER_FILE.toLocaleString("en-US")} models.`);
    }
    const models = new Map<string, CatalogModel>();
    for (const model of entry.models) {
      if (!Array.isArray(model) || model.length !== 3) throw new Invalid("A model isn't in the right form.");
      const [rawYear, rawNumber, rawDescription] = model;
      if (rawYear !== null && !isModelYear(rawYear)) {
        throw new Invalid(`Year ${String(rawYear)} isn't a year from ${MIN_MODEL_YEAR} to ${MAX_MODEL_YEAR}.`);
      }
      const number = text(rawNumber, "modelNumber")?.toUpperCase() ?? null;
      const description = text(rawDescription, "modelDescription");
      if (rawYear === null && number === null && description === null) continue;
      const tidy: CatalogModel = [rawYear, number, description];
      models.set(JSON.stringify(tidy), tidy);
    }
    return {
      file: {
        fileName,
        brand: text(entry.brand, "brand"),
        article: text(entry.article, "article"),
        title: text(entry.title, "title"),
        postedOn,
        modelYears: text(entry.modelYears, "modelYears"),
        models: [...models.values()],
      },
    };
  } catch (error) {
    if (error instanceof Invalid) return { problem: error.message };
    throw error;
  }
}

export type LeftOutFile = { fileName: string; problem: string };

export type ModelList = {
  files: CatalogFile[];
  // Files whose rows have something wrong with them; the rest still go in.
  leftOut: LeftOutFile[];
  // Rows with a blank File: manuals Polaris had no download for.
  rowsWithoutFile: number;
};

export const NOT_A_MODEL_LIST = `This isn't the model list: its first row should be ${CATALOG_HEADER.map((name) => `"${name}"`).join(",")}.`;

export const NOT_UTF8 =
  'This model list isn\'t saved as UTF-8, so letters like ® would come out wrong. In Excel, use Save As > "CSV UTF-8 (Comma delimited)", then add it again.';

// The CSV file's text. It has to be UTF-8, as the export script saves it: a
// list saved again by Excel as plain "CSV (Comma delimited)" is Windows-1252,
// and reading that as UTF-8 would quietly turn ® into �. A byte order mark
// is dropped.
export function decodeModelList(bytes: Uint8Array): { text: string } | { error: string } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    // Only the model list needs saving again; any other CSV is just not it.
    const firstLine = new TextDecoder().decode(bytes.subarray(0, 4096)).split(/\r\n?|\n/, 1)[0];
    let header: string[] = [];
    try {
      header = parseCsv(firstLine)[0] ?? [];
    } catch {
      // Not even its first row reads as CSV.
    }
    return { error: isCatalogHeader(header) ? NOT_UTF8 : NOT_A_MODEL_LIST };
  }
}

const rowLabel = (index: number) => `Row ${index.toLocaleString("en-US")}`;

// Builds one entry from its rows (in the order listed). The manual's own
// details come from its first row.
function entryFromRows(rows: { index: number; fields: string[] }[]): { file: CatalogFile } | { problem: string } {
  const [first] = rows;
  const [fileName, brand, article, postedOnText, title, modelYears] = first.fields;
  const postedOnClean = cleanCatalogText(postedOnText);
  const postedOn = postedOnClean ? parsePostedOn(postedOnClean) : null;
  if (postedOnClean && !postedOn) return { problem: `${rowLabel(first.index)}: Posted On "${postedOnClean}" isn't a date.` };

  const models: CatalogModel[] = [];
  for (const { index, fields } of rows) {
    const yearText = cleanCatalogText(fields[6]);
    const year = yearText && /^\d{4}$/.test(yearText) ? Number(yearText) : null;
    if (yearText && !isModelYear(year)) {
      return { problem: `${rowLabel(index)}: Year "${yearText}" isn't a year from ${MIN_MODEL_YEAR} to ${MAX_MODEL_YEAR}.` };
    }
    models.push([year, fields[7], fields[8]] as CatalogModel);
  }
  return normalizeCatalogFile({ fileName, brand, article, title, postedOn, modelYears, models });
}

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

// Reads the model list CSV: checks its header, groups the rows by file, and
// builds each file's entry. Rows with a blank File are skipped. A file with a
// bad row is left out (with the reason) and the others still go in.
export function readModelList(csv: string): ModelList | { error: string } {
  let rows: string[][];
  try {
    rows = parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvError) return { error: `${rowLabel(error.row)} can't be read: ${error.message}` };
    throw error;
  }
  const [header, ...body] = rows;
  if (!header || !isCatalogHeader(header)) return { error: NOT_A_MODEL_LIST };

  const byFile = new Map<string, { index: number; fields: string[] }[]>();
  let rowsWithoutFile = 0;
  for (const [offset, fields] of body.entries()) {
    const index = offset + 2;
    // A blank line.
    if (fields.length === 1 && fields[0].trim() === "") continue;
    if (fields.length !== CATALOG_HEADER.length) {
      return {
        error: `${rowLabel(index)} has ${fields.length} columns instead of ${CATALOG_HEADER.length}. Check it's the model list as it was exported.`,
      };
    }
    const fileName = cleanCatalogFileName(fields[0]);
    if (!fileName) {
      rowsWithoutFile += 1;
      continue;
    }
    const key = catalogKey(fileName);
    const list = byFile.get(key);
    if (list) list.push({ index, fields });
    else byFile.set(key, [{ index, fields }]);
  }

  const files: CatalogFile[] = [];
  const leftOut: LeftOutFile[] = [];
  for (const fileRows of byFile.values()) {
    const fileName = cleanCatalogFileName(fileRows[0].fields[0]) ?? "";
    const result = entryFromRows(fileRows);
    if ("problem" in result) leftOut.push({ fileName, problem: result.problem });
    else if (jsonBytes(result.file) > MAX_CATALOG_FILE_BYTES) {
      leftOut.push({ fileName, problem: "It lists too many models to send in one go." });
    } else files.push(result.file);
  }
  return { files, leftOut, rowsWithoutFile };
}

// Splits entries into batches for the server, each under the size and count
// limits above. A file's models always travel together.
export function catalogBatches(files: CatalogFile[]): CatalogFile[][] {
  const batches: CatalogFile[][] = [];
  let batch: CatalogFile[] = [];
  let bytes = 0;
  let models = 0;
  for (const file of files) {
    const size = jsonBytes(file) + 1;
    if (
      batch.length > 0 &&
      (bytes + size > CATALOG_BATCH_BYTES ||
        batch.length >= MAX_CATALOG_FILES_PER_BATCH ||
        models + file.models.length > MAX_CATALOG_MODELS_PER_BATCH)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
      models = 0;
    }
    batch.push(file);
    bytes += size;
    models += file.models.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// Filling in blank brands, learned from the entries that do name theirs. The
// words in an entry's title and model descriptions are the best clue
// ("RANGER", "SPORTSMAN", "GENERATOR"); the first letter of its model numbers
// ("A23SXZ85A1", "Z24NAE99AK") is a weaker one, since product lines share
// letters: in Polaris's own list "P" covers generators and some ATVs, and "R"
// both Rangers and older RZRs. A wrong brand would hide a manual from the
// right filter and show it under the wrong one, so anything unclear stays
// blank.

export type BrandVoter = {
  key: string;
  // As the model list gives it; null when it left the brand blank.
  brand: string | null;
  // The distinct words of the entry's title and model descriptions (see
  // brandWords).
  words: string[];
  // How many of the entry's model numbers start with each letter.
  firstLetters: Record<string, number>;
};

// A word or letter is only a clue when this share of the named entries that
// use it have one brand, and at least this many entries use it.
export const WORD_PURITY = 0.9;
export const LETTER_PURITY = 0.95;
export const MIN_CLUE_ENTRIES = 2;

// The share of an entry's model numbers that must point to one brand before
// its letters alone fill the brand in.
export const BRAND_MAJORITY = 2 / 3;

// The words that can tell brands apart: letters only, three or more of them,
// so model codes and sizes ("XP", "4X4", "1000") don't count.
export function brandWords(...texts: (string | null | undefined)[]): string[] {
  const words = new Set<string>();
  for (const text of texts) {
    for (const word of (text ?? "").toUpperCase().match(/[A-Z]{3,}/g) ?? []) words.add(word);
  }
  return [...words];
}

// Each clue's brand, for the clues that clearly point at one.
function clearClues(entries: BrandVoter[], cluesOf: (entry: BrandVoter) => string[], purity: number) {
  const brandsByClue = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    if (!entry.brand) continue;
    for (const clue of new Set(cluesOf(entry))) {
      const brands = brandsByClue.get(clue) ?? new Map<string, number>();
      brands.set(entry.brand, (brands.get(entry.brand) ?? 0) + 1);
      brandsByClue.set(clue, brands);
    }
  }
  const clear = new Map<string, string>();
  for (const [clue, brands] of brandsByClue) {
    const total = [...brands.values()].reduce((sum, n) => sum + n, 0);
    const [brand, n] = [...brands].reduce((best, next) => (next[1] > best[1] ? next : best));
    if (total >= MIN_CLUE_ENTRIES && n / total >= purity) clear.set(clue, brand);
  }
  return clear;
}

// Brands for the entries with none, by key. Words go first: each clear word
// votes once, and the top brand needs at least twice the runner-up's votes.
// Failing that, model numbers vote by their clear first letters, and the top
// brand needs BRAND_MAJORITY of all the entry's model numbers.
export function inferBrands(entries: BrandVoter[]): Map<string, string> {
  const wordBrands = clearClues(entries, (entry) => entry.words, WORD_PURITY);
  const letterBrands = clearClues(
    entries,
    (entry) => Object.keys(entry.firstLetters).filter((letter) => entry.firstLetters[letter] > 0),
    LETTER_PURITY,
  );
  const top = (votes: Map<string, number>) =>
    [...votes].sort((a, b) => b[1] - a[1]).concat([["", 0], ["", 0]]).slice(0, 2);

  const inferred = new Map<string, string>();
  for (const entry of entries) {
    if (entry.brand) continue;
    const wordVotes = new Map<string, number>();
    for (const word of new Set(entry.words)) {
      const brand = wordBrands.get(word);
      if (brand) wordVotes.set(brand, (wordVotes.get(brand) ?? 0) + 1);
    }
    const [[wordBrand, best], [, runnerUp]] = top(wordVotes);
    if (best > 0 && best >= 2 * runnerUp) {
      inferred.set(entry.key, wordBrand);
      continue;
    }

    const letterVotes = new Map<string, number>();
    let models = 0;
    for (const [letter, count] of Object.entries(entry.firstLetters)) {
      if (count <= 0) continue;
      models += count;
      const brand = letterBrands.get(letter);
      if (brand) letterVotes.set(brand, (letterVotes.get(brand) ?? 0) + count);
    }
    const [[letterBrand, most]] = top(letterVotes);
    // The small allowance keeps exactly two-thirds from failing on rounding.
    if (most > 0 && most / models >= BRAND_MAJORITY - 1e-9) inferred.set(entry.key, letterBrand);
  }
  return inferred;
}
