// The model list: reading the CSV, importing it (replacing per file),
// filling in blank brands, the Library's filters, manualsForModel, and that
// the list stays inside its own shop. Needs DATABASE_URL pointing at a
// disposable Postgres database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, asc, eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, manualCatalogDocuments, manualCatalogModels, manuals, shops, users } from "../src/db/schema";
import { CsvError, parseCsv } from "../src/lib/csv";
import {
  SEARCH_LIMIT,
  cleanLibraryFilters,
  getReadyManual,
  libraryFilterOptions,
  listReadyManuals,
  manualsForModel,
  modelFilterWords,
  searchManuals,
  type LibraryFilters,
} from "../src/lib/library";
import { catalogSummary, finishCatalogImport, saveCatalogBatch } from "../src/lib/manual-catalog";
import {
  CATALOG_BATCH_BYTES,
  CATALOG_HEADER,
  MAX_MODELS_PER_FILE,
  NOT_A_MODEL_LIST,
  NOT_UTF8,
  brandWords,
  catalogBatches,
  decodeModelList,
  inferBrands,
  normalizeCatalogFile,
  readModelList,
  type BrandVoter,
  type CatalogFile,
  type CatalogModel,
  type ModelList,
} from "../src/lib/manual-catalog-rules";
import { pdfFileName } from "../src/lib/manual-rules";
import {
  confirmManualUpload,
  finishManual,
  listManuals,
  saveManualPages,
  startManualUpload,
  storageKeyFor,
} from "../src/lib/manuals";
import type { CurrentUser } from "../src/lib/session";
import type { FileStorage } from "../src/lib/storage";

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
let adminA: CurrentUser;
let adminB: CurrentUser;
// For file names and the year filter, apart from the filter tests' shop.
let adminC: CurrentUser;

async function createShopWithAdmin(code: string): Promise<CurrentUser> {
  const [shop] = await systemDb
    .insert(shops)
    .values({ code, name: `Shop ${code}` })
    .returning({ id: shops.id, code: shops.code, name: shops.name });
  const id = randomUUID();
  await systemDb.insert(users).values({
    id,
    shopId: shop.id,
    role: "admin",
    name: "Admin",
    username: `${code}.boss`,
    displayUsername: "boss",
    email: `${randomUUID()}@no-email.invalid`,
  });
  return { id, name: "Admin", username: "boss", role: "admin", shop, bay: null };
}

const randomSha = () => createHash("sha256").update(randomUUID()).digest("hex");
const sizeOf = (pages: string[]) => 1000 + pages.join("").length;

// Adds a ready manual through the uploader's steps, with a stand-in for storage.
async function addManual(actor: CurrentUser, fileName: string, pages: string[], sha256 = randomSha()) {
  const objects = new Map<string, number>();
  const storage: FileStorage = {
    uploadUrl: async (key) => `https://storage.test/${key}`,
    downloadUrl: async (key) => `https://storage.test/${key}`,
    size: async (key) => objects.get(key) ?? null,
  };
  const sizeBytes = sizeOf(pages);
  const start = await startManualUpload(actor, { fileName, sizeBytes, sha256 }, storage);
  assert.ok("next" in start && start.next === "upload", JSON.stringify(start));
  objects.set(storageKeyFor(actor.shop.id, start.manualId), sizeBytes);
  assert.deepEqual(await confirmManualUpload(actor, { manualId: start.manualId, pageCount: pages.length }, storage), {
    next: "extract",
  });
  await saveManualPages(actor, {
    manualId: start.manualId,
    pages: pages.map((text, index) => ({ pageNumber: index + 1, text })),
  });
  const finished = await finishManual(actor, { manualId: start.manualId });
  assert.ok("added" in finished && finished.added, JSON.stringify(finished));
  return start.manualId;
}

const entry = (fileName: string, models: CatalogModel[], extra: Partial<CatalogFile> = {}): CatalogFile => ({
  fileName,
  brand: null,
  article: null,
  title: null,
  postedOn: null,
  modelYears: null,
  models,
  ...extra,
});

// Imports entries the way the uploader does: batches, then finish.
async function importEntries(actor: CurrentUser, files: CatalogFile[], fileName = "manual-list - All.csv") {
  const importId = randomUUID();
  for (const batch of catalogBatches(files)) {
    const saved = await saveCatalogBatch(actor, { importId, files: batch });
    assert.ok("saved" in saved, JSON.stringify(saved));
  }
  const result = await finishCatalogImport(actor, { importId, fileName, leftOut: 0, rowsWithoutFile: 0 });
  assert.ok("manuals" in result, JSON.stringify(result));
  return { importId, ...result };
}

// What the shop's list says, without when or by which import it was saved.
async function snapshot(shopId: string) {
  const documents = await systemDb
    .select({
      fileKey: manualCatalogDocuments.fileKey,
      fileName: manualCatalogDocuments.fileName,
      brand: manualCatalogDocuments.brand,
      inferredBrand: manualCatalogDocuments.inferredBrand,
      article: manualCatalogDocuments.article,
      title: manualCatalogDocuments.title,
      postedOn: manualCatalogDocuments.postedOn,
      modelYears: manualCatalogDocuments.modelYears,
    })
    .from(manualCatalogDocuments)
    .where(eq(manualCatalogDocuments.shopId, shopId))
    .orderBy(asc(manualCatalogDocuments.fileKey));
  const models = await systemDb
    .select({
      fileKey: manualCatalogModels.fileKey,
      year: manualCatalogModels.modelYear,
      number: manualCatalogModels.modelNumber,
      description: manualCatalogModels.modelDescription,
    })
    .from(manualCatalogModels)
    .where(eq(manualCatalogModels.shopId, shopId))
    .orderBy(
      asc(manualCatalogModels.fileKey),
      asc(manualCatalogModels.modelNumber),
      asc(manualCatalogModels.modelYear),
      asc(manualCatalogModels.modelDescription),
    );
  return { documents, models };
}

const csvLine = (fields: string[]) => fields.map((field) => `"${field.replace(/"/g, '""')}"`).join(",");
const csv = (rows: string[][]) => `﻿${[[...CATALOG_HEADER], ...rows].map(csvLine).join("\r\n")}\r\n`;

before(async () => {
  adminA = await createShopWithAdmin(`ca${suffix}`);
  adminB = await createShopWithAdmin(`cb${suffix}`);
  adminC = await createShopWithAdmin(`cc${suffix}`);
});

after(async () => {
  await systemDb.delete(shops).where(eq(shops.id, adminA.shop.id));
  await systemDb.delete(shops).where(eq(shops.id, adminB.shop.id));
  await systemDb.delete(shops).where(eq(shops.id, adminC.shop.id));
  await systemDb.$client.end();
});

describe("reading CSV", () => {
  test("drops a byte order mark and the last line break, CRLF or LF", () => {
    assert.deepEqual(parseCsv("﻿a,b\r\nc,d\r\n"), [
      ["a", "b"],
      ["c", "d"],
    ]);
    assert.deepEqual(parseCsv("a,b\nc,d"), [
      ["a", "b"],
      ["c", "d"],
    ]);
    assert.deepEqual(parseCsv("a\rb\r"), [["a"], ["b"]]);
    assert.deepEqual(parseCsv(""), []);
    assert.deepEqual(parseCsv("﻿"), []);
  });

  test("quoted fields hold commas, doubled quotes and line breaks", () => {
    assert.deepEqual(parseCsv('"9942508.pdf","RZR, Pro R","He said ""Boost""","two\r\nlines","x\ny"\r\n'), [
      ["9942508.pdf", "RZR, Pro R", 'He said "Boost"', "two\r\nlines", "x\ny"],
    ]);
    assert.deepEqual(parseCsv('"",""\r\n""""'), [["", ""], ['"']]);
  });

  test("keeps empty fields, including a trailing one", () => {
    assert.deepEqual(parseCsv("a,,c,\r\n,\r\n"), [
      ["a", "", "c", ""],
      ["", ""],
    ]);
    assert.deepEqual(parseCsv("a,b,"), [["a", "b", ""]]);
    assert.deepEqual(parseCsv("\r\n"), [[""]]);
  });

  test("an unquoted field keeps a stray quote", () => {
    assert.deepEqual(parseCsv('12" wheel,b'), [['12" wheel', "b"]]);
  });

  test("a quote that never ends, or text after a closing quote, is an error with its row", () => {
    assert.throws(
      () => parseCsv('a,b\r\nc,"never ends\r\nd,e'),
      (error: unknown) => error instanceof CsvError && error.row === 2,
    );
    assert.throws(
      () => parseCsv('a\r\nb\r\n"x"y,z'),
      (error: unknown) => error instanceof CsvError && error.row === 3,
    );
  });

  test("reads 20,000 rows quickly", () => {
    const text = csv(
      Array.from({ length: 20000 }, (_, i) => [
        `${i % 440}.pdf`,
        "ATV",
        "9942508",
        "6/24/2024",
        "A title, with a comma",
        "2020, 2022",
        "2020",
        `A20SXZ85A${i}`,
        'SPORTSMAN 850 "ULTIMATE"',
      ]),
    );
    const started = performance.now();
    const rows = parseCsv(text);
    const elapsed = performance.now() - started;
    assert.equal(rows.length, 20001);
    assert.equal(rows[20000][8], 'SPORTSMAN 850 "ULTIMATE"');
    assert.ok(elapsed < 2000, `${elapsed} ms`);
  });
});

describe("reading the model list", () => {
  const read = (text: string) => {
    const list = readModelList(text);
    assert.ok(!("error" in list), JSON.stringify(list));
    return list as ModelList;
  };

  test("refuses a CSV whose first row isn't the model list's", () => {
    assert.deepEqual(readModelList('"File","Brand"\r\n"a.pdf","ATV"\r\n'), { error: NOT_A_MODEL_LIST });
    assert.deepEqual(readModelList(""), { error: NOT_A_MODEL_LIST });
    assert.deepEqual(readModelList(`${csvLine([...CATALOG_HEADER, "Extra"])}\r\n`), { error: NOT_A_MODEL_LIST });
    const renamed: string[] = [...CATALOG_HEADER];
    renamed[7] = "Model No";
    assert.deepEqual(readModelList(`${csvLine(renamed)}\r\n`), { error: NOT_A_MODEL_LIST });
    // Case and spaces around a heading don't matter.
    assert.ok(!("error" in readModelList(`${CATALOG_HEADER.map((h) => ` ${h.toUpperCase()} `).join(",")}\n`)));
  });

  test("a row with the wrong number of columns stops the whole list", () => {
    const text = `${csv([["a.pdf", "ATV", "1", "", "T", "", "", "", ""]])}"b.pdf","ATV"\r\n`;
    const list = readModelList(text);
    assert.ok("error" in list && list.error.startsWith("Row 3 has 2 columns"), JSON.stringify(list));
    assert.ok("error" in readModelList(`${csv([])}"unterminated`));
  });

  test("groups rows by file, whatever the case, and takes the manual's details from its first row", () => {
    const list = read(
      csv([
        ["9942508.pdf", "ATV", "9942508", "6/24/2024", 'Sportsman, "850" Service', "2020, 2022", "2020", "a20sxz85a1", "SPORTSMAN 850"],
        ["9942508.pdf", "ATV", "9942508", "6/24/2024", 'Sportsman, "850" Service', "2020, 2022", "2022", "A22SXZ85A1", "SPORTSMAN 850\r\nPREMIUM"],
        ["", "ATV", "NOFILE", "1/2/2020", "No download", "", "2020", "A20X", ""],
        ["9929400_2019_Outlaw 50.pdf", "", "9929400", "12/1/2018", "2019 Outlaw 50", "2019", "", "", ""],
        ["9942508.PDF", "RZR", "ignored", "", "ignored", "", "2020", "A20SXZ85A1", "SPORTSMAN 850"],
      ]),
    );
    assert.equal(list.rowsWithoutFile, 1);
    assert.deepEqual(list.leftOut, []);
    assert.deepEqual(list.files, [
      {
        fileName: "9942508.pdf",
        brand: "ATV",
        article: "9942508",
        title: 'Sportsman, "850" Service',
        postedOn: "2024-06-24",
        modelYears: "2020, 2022",
        models: [
          // Upper-cased, and the repeat on the last row is kept once.
          [2020, "A20SXZ85A1", "SPORTSMAN 850"],
          [2022, "A22SXZ85A1", "SPORTSMAN 850 PREMIUM"],
        ],
      },
      {
        fileName: "9929400_2019_Outlaw 50.pdf",
        brand: null,
        article: "9929400",
        title: "2019 Outlaw 50",
        postedOn: "2018-12-01",
        modelYears: "2019",
        // A manual with no models.
        models: [],
      },
    ]);
  });

  test("keeps a file name's own spacing, trimming only its ends, as the uploader does", () => {
    const list = read(
      csv([
        [" 9929400_2019_Outlaw  50.pdf ", "ATV", "9929400", "", "Outlaw 50", "", "2019", "A19YAF05A4", ""],
        ["9929400_2019_OUTLAW  50.pdf", "ATV", "9929400", "", "Outlaw 50", "", "2019", "A19YAF05A6", ""],
        ["Sportsman\u00a0570.pdf", "ATV", "1", "", "Sportsman 570", "", "", "", ""],
        ["two\r\nlines.pdf", "ATV", "2", "", "Broken", "", "", "", ""],
      ]),
    );
    assert.deepEqual(
      list.files.map((file) => [file.fileName, file.models.length]),
      [
        ["9929400_2019_Outlaw  50.pdf", 2],
        ["Sportsman\u00a0570.pdf", 0],
      ],
    );
    assert.deepEqual(list.leftOut, [
      { fileName: "two\r\nlines.pdf", problem: "File has a line break or control character." },
    ]);
  });

  test("needs UTF-8: a list Excel saved as Windows-1252 is turned down, not garbled", () => {
    const header = csvLine([...CATALOG_HEADER]);
    const row = csvLine(["a.pdf", "RGR", "1", "", "2021 RANGER® XP 1000", "", "2021", "R21RAN99A1", "RANGER® XP 1000"]);
    // ® is the single byte 0xAE in Windows-1252, which isn't UTF-8.
    const windows1252 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
    assert.deepEqual(decodeModelList(windows1252(`${header}\r\n${row}\r\n`)), { error: NOT_UTF8 });
    assert.deepEqual(decodeModelList(windows1252('"Part","Desc"\r\n"2205123","Kit®"\r\n')), { error: NOT_A_MODEL_LIST });
    // Saved as UTF-8, with or without a byte order mark, it reads.
    for (const bom of ["\ufeff", ""]) {
      const decoded = decodeModelList(new TextEncoder().encode(`${bom}${header}\r\n${row}\r\n`));
      assert.ok("text" in decoded, JSON.stringify(decoded));
      assert.equal(read(decoded.text).files[0].title, "2021 RANGER® XP 1000");
    }
  });

  test("leaves out a file with a bad date or year, with the row, and keeps the rest", () => {
    const list = read(
      csv([
        ["good.pdf", "ATV", "1", "6/24/2024", "Good", "", "2020", "A1", ""],
        ["bad-date.pdf", "ATV", "2", "2/30/2024", "Bad date", "", "", "", ""],
        ["bad-year.pdf", "ATV", "3", "", "Bad year", "", "2020", "A2", ""],
        ["bad-year.pdf", "ATV", "3", "", "Bad year", "", "1949", "A3", ""],
        ["text-year.pdf", "ATV", "4", "", "Text year", "", "MY20", "A4", ""],
        ["long.pdf", "ATV", "5", "", "x".repeat(501), "", "", "", ""],
      ]),
    );
    assert.deepEqual(
      list.files.map((file) => file.fileName),
      ["good.pdf"],
    );
    assert.deepEqual(list.leftOut, [
      { fileName: "bad-date.pdf", problem: 'Row 3: Posted On "2/30/2024" isn\'t a date.' },
      { fileName: "bad-year.pdf", problem: 'Row 5: Year "1949" isn\'t a year from 1950 to 2100.' },
      { fileName: "text-year.pdf", problem: 'Row 6: Year "MY20" isn\'t a year from 1950 to 2100.' },
      { fileName: "long.pdf", problem: "Title is longer than 500 characters." },
    ]);
  });

  test("batches never split a file and stay under the size limit", () => {
    const files = Array.from({ length: 60 }, (_, i) =>
      entry(
        `${i}.pdf`,
        Array.from({ length: 200 }, (_, n) => [2020, `A20${i}X${n}`, `SPORTSMAN ${n} ULTIMATE TRAIL - CHALK GLO`]),
      ),
    );
    const batches = catalogBatches(files);
    assert.ok(batches.length > 1);
    assert.deepEqual(batches.flat(), files);
    for (const batch of batches) {
      assert.ok(new TextEncoder().encode(JSON.stringify(batch)).length <= CATALOG_BATCH_BYTES + 1024);
    }
    // One file bigger than a batch still goes, on its own.
    const big = entry("big.pdf", Array.from({ length: MAX_MODELS_PER_FILE }, (_, n) => [2020, `A${n}`, "X".repeat(100)]));
    assert.deepEqual(catalogBatches([files[0], big, files[1]]), [[files[0]], [big], [files[1]]]);
  });
});

describe("checking an entry on the server", () => {
  const good = entry("a.pdf", [[2020, "A1", "Desc"]], { postedOn: "2024-06-24" });

  test("tidies text, upper-cases model numbers and drops empty or repeated models", () => {
    const result = normalizeCatalogFile({
      ...good,
      fileName: "  a.pdf ",
      title: "Two\nlines\u0000 here",
      brand: " ",
      models: [
        [2020, " a1 ", "Desc"],
        [2020, "A1", "Desc"],
        [null, null, null],
        [null, "B1", null],
      ],
    });
    assert.deepEqual(result, {
      file: {
        ...good,
        title: "Two lines here",
        models: [
          [2020, "A1", "Desc"],
          [null, "B1", null],
        ],
      },
    });
    // A file name keeps its own spacing, so it still matches its PDF.
    assert.deepEqual(normalizeCatalogFile({ ...good, fileName: " Outlaw  50\u00a0EFI.pdf\t" }), {
      file: { ...good, fileName: "Outlaw  50\u00a0EFI.pdf" },
    });
  });

  test("refuses anything malformed", () => {
    for (const input of [
      null,
      "a.pdf",
      { ...good, fileName: "" },
      { ...good, fileName: " " },
      { ...good, fileName: null },
      { ...good, fileName: 42 },
      { ...good, fileName: "a\u0000.pdf" },
      { ...good, fileName: "a\nb.pdf" },
      { ...good, fileName: `${"x".repeat(256)}` },
      { ...good, brand: "B".repeat(41) },
      { ...good, title: "t".repeat(501) },
      { ...good, article: ["x"] },
      { ...good, modelYears: undefined },
      { ...good, postedOn: "6/24/2024" },
      { ...good, postedOn: "2024-02-30" },
      { ...good, postedOn: "1900-01-01" },
      { ...good, models: "none" },
      { ...good, models: [[2020, "A1"]] },
      { ...good, models: [[1949, "A1", null]] },
      { ...good, models: [[2101, "A1", null]] },
      { ...good, models: [[2020.5, "A1", null]] },
      { ...good, models: [["2020", "A1", null]] },
      { ...good, models: [[2020, 7, null]] },
      { ...good, models: [[2020, "A".repeat(65), null]] },
      { ...good, models: Array.from({ length: MAX_MODELS_PER_FILE + 1 }, (_, n) => [2020, `A${n}`, null]) },
    ]) {
      assert.ok("problem" in normalizeCatalogFile(input), JSON.stringify(input)?.slice(0, 80));
    }
  });
});

describe("filling in brands", () => {
  const voter = (
    key: string,
    brand: string | null,
    firstLetters: Record<string, number>,
    ...texts: string[]
  ): BrandVoter => ({ key, brand, firstLetters, words: brandWords(...texts) });

  test("words in titles and model descriptions come first", () => {
    const inferred = inferBrands([
      voter("rgr1", "RGR", { R: 40 }, "2025 RANGER 1000", "RANGER 1000 EPS"),
      voter("rgr2", "RGR", { R: 9 }, "2024 RANGER XP 1000", "RANGER XP 1000 NORTHSTAR"),
      voter("grl1", "GRL", { R: 4 }, "2020-2027 General / General XP", "GENERAL XP 1000"),
      voter("grl2", "GRL", { G: 6 }, "2026 General", "GENERAL 1000 SPORT"),
      voter("gen1", "GEN", { P: 3 }, "P2000i Generator", "GENERATOR-P2000I"),
      voter("gen2", "GEN", { P: 1 }, "2003 7500 Watt Generator", "GENERATOR-P7500"),
      // Some ATVs have P model numbers too, as in Polaris's own list.
      voter("atv1", "ATV", { A: 30, P: 2 }, "Sportsman 570", "SPORTSMAN 570 EPS"),
      voter("atv2", "ATV", { A: 12, P: 1 }, "Sportsman 450", "SPORTSMAN 450 H.O."),
      voter("web-rgr", null, { R: 17 }, "2019-2022 RANGER DIESEL", "RANGER DIESEL CREW"),
      // R model numbers, but the words say General.
      voter("web-grl", null, { R: 54 }, "2016-2019 GENERAL", "GENERAL 1000 EPS"),
      // P model numbers, but the words say generator, not ATV.
      voter("web-gen", null, { P: 2 }, "P1000i / P2000i Generator", "GENERATOR-P1000I"),
      voter("web-atv", null, { A: 46 }, "2012-2014 Sportsman 850 XP Service Manual", "SPORTSMAN 850 XP"),
    ]);
    assert.deepEqual(Object.fromEntries(inferred), {
      "web-rgr": "RGR",
      "web-grl": "GRL",
      "web-gen": "GEN",
      "web-atv": "ATV",
    });
  });

  test("a word only counts when nearly every entry using it has one brand", () => {
    const named = [
      // RZR shows up under three brands, as Polaris files older RZRs.
      voter("rzr1", "RZR", { Z: 5 }, "2024 RZR XP 1000"),
      voter("rzr2", "RZR", { Z: 5 }, "2025 RZR Pro R"),
      voter("rgr-rzr", "RGR", { R: 3 }, "2011 RANGER RZR 800"),
      voter("atv-rzr", "ATV", { R: 2 }, "2012 RZR 170"),
    ];
    // Only RZR, which is split three ways, and R, which isn't clear: blank.
    assert.deepEqual(Object.fromEntries(inferBrands([...named, voter("web", null, { R: 6 }, "2013 RZR 570")])), {});
    // The top brand needs twice the runner-up's clear words.
    const split = [
      voter("atv1", "ATV", {}, "Sportsman Touring"),
      voter("atv2", "ATV", {}, "Sportsman Touring"),
      voter("rgr1", "RGR", {}, "Ranger Crew"),
      voter("rgr2", "RGR", {}, "Ranger Crew"),
    ];
    assert.deepEqual(Object.fromEntries(inferBrands([...split, voter("even", null, {}, "Sportsman Ranger")])), {});
    assert.deepEqual(
      Object.fromEntries(inferBrands([...split, voter("clear", null, {}, "Sportsman Touring Ranger")])),
      { clear: "ATV" },
    );
  });

  test("without clear words, model numbers decide by letters only one brand uses", () => {
    const named = [
      voter("rzr1", "RZR", { Z: 12 }),
      voter("rzr2", "RZR", { Z: 30 }),
      voter("atv1", "ATV", { A: 30, P: 2 }),
      voter("atv2", "ATV", { A: 3 }),
      voter("gen1", "GEN", { P: 3 }),
    ];
    const inferred = inferBrands([
      ...named,
      voter("web-rzr", null, { Z: 26, R: 4 }),
      voter("web-atv", null, { A: 3 }),
      // P is shared by ATVs and generators, so it settles nothing.
      voter("web-p", null, { P: 1 }),
    ]);
    assert.deepEqual(Object.fromEntries(inferred), { "web-rzr": "RZR", "web-atv": "ATV" });
  });

  test("by letters, two-thirds of the entry's model numbers must agree", () => {
    const named = [voter("atv1", "ATV", { A: 3 }), voter("atv2", "ATV", { A: 1 })];
    assert.deepEqual(Object.fromEntries(inferBrands([...named, voter("half", null, { A: 1, Q: 1 })])), {});
    assert.deepEqual(Object.fromEntries(inferBrands([...named, voter("most", null, { A: 2, Q: 1 })])), { most: "ATV" });
  });

  test("with nothing to go on, brands stay blank", () => {
    assert.deepEqual(Object.fromEntries(inferBrands([])), {});
    assert.deepEqual(Object.fromEntries(inferBrands([voter("x", null, { A: 4 }, "Sportsman"), voter("y", null, { A: 1 })])), {});
    // One entry isn't enough to make a word or letter a clue.
    assert.deepEqual(Object.fromEntries(inferBrands([voter("atv", "ATV", { A: 1 }, "Sportsman"), voter("x", null, { A: 1 }, "Sportsman")])), {});
    assert.deepEqual(Object.fromEntries(inferBrands([voter("atv", "ATV", { A: 1 }), voter("none", null, {})])), {});
  });

  test("brand words are whole words of three or more letters, once each", () => {
    assert.deepEqual(brandWords("2017-2018 RZR XP / XP4 1000", "rzr xp 4 turbo - white lightning", null, undefined).sort(), [
      "LIGHTNING",
      "RZR",
      "TURBO",
      "WHITE",
    ]);
  });
});

describe("importing the model list", () => {
  const atvA = (n: number): CatalogModel => [2020, `A20SXZ85A${n}`, `SPORTSMAN 850 ${n}`];
  const list = () => [
    entry("atv-1.pdf", [atvA(1), atvA(2)], { brand: "ATV", title: "2020 Sportsman 850", postedOn: "2024-06-24" }),
    entry("atv-2.pdf", [atvA(3)], { brand: "ATV", article: "9942508" }),
    entry("rzr-1.pdf", [[2024, "Z24NAE99AK", "RZR XP 1000"]], { brand: "RZR" }),
    entry("Web Manual.pdf", [atvA(4), atvA(5)], { title: "Sportsman web manual" }),
    entry("no-models.pdf", [], { brand: "GEN", modelYears: "2018-2027" }),
  ];
  let first: Awaited<ReturnType<typeof importEntries>>;

  before(async () => {
    first = await importEntries(adminA, list());
  });

  test("saves every entry and model, fills in the blank brand, and records the import", async () => {
    assert.deepEqual(
      { manuals: first.manuals, models: first.models, brandsInferred: first.brandsInferred },
      { manuals: 5, models: 6, brandsInferred: 1 },
    );
    const { documents, models } = await snapshot(adminA.shop.id);
    assert.equal(documents.length, 5);
    assert.equal(models.length, 6);
    const web = documents.find((d) => d.fileName === "Web Manual.pdf");
    assert.deepEqual(
      { fileKey: web?.fileKey, brand: web?.brand, inferred: web?.inferredBrand },
      { fileKey: "web manual.pdf", brand: "ATV", inferred: true },
    );
    assert.equal(documents.find((d) => d.fileName === "atv-1.pdf")?.postedOn, "2024-06-24");
    const entries = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, first.importId));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "manual_catalog.imported");
    assert.equal(entries[0].actorUserId, adminA.id);
    assert.deepEqual(entries[0].details, {
      fileName: "manual-list - All.csv",
      manuals: 5,
      models: 6,
      brandsInferred: 1,
      leftOut: 0,
      rowsWithoutFile: 0,
    });
  });

  test("finishing again doesn't record the import twice", async () => {
    const again = await finishCatalogImport(adminA, {
      importId: first.importId,
      fileName: "x.csv",
      leftOut: 0,
      rowsWithoutFile: 0,
    });
    assert.deepEqual(again, { manuals: 5, models: 6, brandsInferred: 1 });
    const entries = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, first.importId));
    assert.equal(entries.length, 1);
  });

  test("importing the same list again changes nothing", async () => {
    const before = await snapshot(adminA.shop.id);
    const again = await importEntries(adminA, list());
    assert.deepEqual(await snapshot(adminA.shop.id), before);
    assert.deepEqual(
      { manuals: again.manuals, models: again.models, brandsInferred: again.brandsInferred },
      { manuals: 5, models: 6, brandsInferred: 1 },
    );
  });

  test("a later list replaces only its own files' entries, whatever their case", async () => {
    const before = await snapshot(adminA.shop.id);
    const later = await importEntries(adminA, [
      entry("ATV-2.PDF", [[2021, "A21SXZ85A9", "SPORTSMAN 850 PREMIUM"]], { brand: "ATV", title: "Replaced" }),
    ]);
    assert.deepEqual({ manuals: later.manuals, models: later.models }, { manuals: 1, models: 1 });
    const now = await snapshot(adminA.shop.id);
    assert.equal(now.documents.length, 5);
    const changed = now.documents.find((d) => d.fileKey === "atv-2.pdf");
    assert.deepEqual(
      { fileName: changed?.fileName, title: changed?.title, article: changed?.article },
      { fileName: "ATV-2.PDF", title: "Replaced", article: null },
    );
    assert.deepEqual(
      now.models.filter((m) => m.fileKey === "atv-2.pdf"),
      [{ fileKey: "atv-2.pdf", year: 2021, number: "A21SXZ85A9", description: "SPORTSMAN 850 PREMIUM" }],
    );
    // Everything else is as it was, and wasn't rewritten.
    assert.deepEqual(
      now.documents.filter((d) => d.fileKey !== "atv-2.pdf"),
      before.documents.filter((d) => d.fileKey !== "atv-2.pdf"),
    );
    assert.deepEqual(
      now.models.filter((m) => m.fileKey !== "atv-2.pdf"),
      before.models.filter((m) => m.fileKey !== "atv-2.pdf"),
    );
    const untouched = await systemDb
      .select({ importId: manualCatalogDocuments.importId })
      .from(manualCatalogDocuments)
      .where(and(eq(manualCatalogDocuments.shopId, adminA.shop.id), eq(manualCatalogDocuments.fileKey, "rzr-1.pdf")));
    assert.notEqual(untouched[0].importId, later.importId);
  });

  test("a brand given later replaces one that was filled in", async () => {
    await importEntries(adminA, [entry("Web Manual.pdf", [atvA(4)], { brand: "SNO" })]);
    const [web] = await systemDb
      .select({ brand: manualCatalogDocuments.brand, inferred: manualCatalogDocuments.inferredBrand })
      .from(manualCatalogDocuments)
      .where(and(eq(manualCatalogDocuments.shopId, adminA.shop.id), eq(manualCatalogDocuments.fileKey, "web manual.pdf")));
    assert.deepEqual(web, { brand: "SNO", inferred: false });
    // Back to the original list for the tests after this one.
    await importEntries(adminA, list());
  });

  test("a batch with anything wrong saves nothing", async () => {
    const before = await snapshot(adminA.shop.id);
    const importId = randomUUID();
    for (const files of [
      [entry("atv-1.pdf", []), { ...entry("bad.pdf", []), postedOn: "yesterday" }],
      [entry("atv-1.pdf", []), entry("ATV-1.pdf", [])],
      [],
      "nope",
      Array.from({ length: 501 }, (_, i) => entry(`${i}.pdf`, [])),
    ]) {
      const result = await saveCatalogBatch(adminA, { importId, files });
      assert.ok("error" in result, JSON.stringify(files).slice(0, 60));
    }
    assert.ok("error" in (await saveCatalogBatch(adminA, { importId: "not-an-id", files: [entry("x.pdf", [])] })));
    assert.deepEqual(await snapshot(adminA.shop.id), before);
  });
});

describe("the model list and the manuals", () => {
  let listed: string;
  let notListed: string;

  before(async () => {
    listed = await addManual(adminB, "9942477R02-2.PDF", ["Torque the caliper bolts. Zephyrine brake bleed."]);
    notListed = await addManual(adminB, "Own Manual.pdf", ["Zephyrine valve check."]);
    await importEntries(adminB, [
      entry("9942477r02-2.pdf", [[2027, "Z27RPR2BAK", "RZR PRO R BOOST"]], {
        brand: "RZR",
        title: "2027 RZR Pro R Boost / Pro R Boost 4",
        modelYears: "2027",
      }),
      entry("not-uploaded.pdf", [], { title: "Coming later" }),
    ]);
  });

  test("a manual takes the list's title, brand and years, matched by file name whatever the case", async () => {
    const ready = await listReadyManuals(adminB.shop.id);
    const mine = ready.find((manual) => manual.id === listed);
    assert.deepEqual(
      { title: mine?.title, brands: mine?.brands, modelYears: mine?.modelYears },
      { title: "2027 RZR Pro R Boost / Pro R Boost 4", brands: ["RZR"], modelYears: "2027" },
    );
    const own = ready.find((manual) => manual.id === notListed);
    assert.deepEqual({ title: own?.title, brands: own?.brands }, { title: "Own Manual", brands: [] });

    const hits = await searchManuals(adminB.shop.id, "zephyrine");
    assert.deepEqual(
      hits.map((hit) => [hit.title, hit.brands.join()]).sort(),
      [
        ["2027 RZR Pro R Boost / Pro R Boost 4", "RZR"],
        ["Own Manual", ""],
      ],
    );
    const viewer = await getReadyManual(adminB.shop.id, listed);
    assert.equal(viewer?.title, "2027 RZR Pro R Boost / Pro R Boost 4");
    assert.equal(pdfFileName(viewer!.title), "2027 RZR Pro R Boost - Pro R Boost 4.pdf");
    assert.equal(pdfFileName('Sportsman 850, "Ultimate": a/b\\c?'), "Sportsman 850, 'Ultimate' a - b - c.pdf");
    assert.equal(pdfFileName("  "), "Manual.pdf");
    // Cut at 200 without keeping half of a character from outside the BMP,
    // which would make the download link throw.
    const long = pdfFileName(`${"y".repeat(199)}\u{1D4AF} Service Manual`);
    assert.equal(long, `${"y".repeat(199)}.pdf`);
    assert.doesNotThrow(() => encodeURIComponent(long));
    assert.equal(pdfFileName(`${"y".repeat(198)}\u{1D4AF} Service Manual`), `${"y".repeat(198)}\u{1D4AF}.pdf`);

    const admin = (await listManuals(adminB.shop.id)).find((manual) => manual.id === listed);
    assert.deepEqual(
      { title: admin?.title, fileName: admin?.fileName, inList: admin?.inList, models: admin?.models },
      { title: "2027 RZR Pro R Boost / Pro R Boost 4", fileName: "9942477R02-2.PDF", inList: true, models: 1 },
    );
  });

  test("the summary counts both sides and lists what doesn't match", async () => {
    const summary = await catalogSummary(adminB.shop.id);
    assert.equal(summary.manuals, 2);
    assert.equal(summary.entries, 2);
    assert.equal(summary.models, 1);
    assert.ok(summary.lastImportedAt instanceof Date);
    assert.deepEqual(summary.notListed, [{ id: notListed, title: "Own Manual", fileName: "Own Manual.pdf" }]);
    assert.deepEqual(summary.missingPdfs, [{ fileName: "not-uploaded.pdf", title: "Coming later" }]);
  });
});

describe("library filters", () => {
  const ids: Record<string, string> = {};

  before(async () => {
    ids.atv = await addManual(adminA, "atv-1.pdf", ["Quillwort carburetor float height.", "Wiring."]);
    ids.gen = await addManual(adminA, "gen-1.pdf", ["Quillwort carburetor on the generator."]);
    ids.rzr = await addManual(adminA, "rzr-1.pdf", ["Quillwort clutch."]);
    ids.web = await addManual(adminA, "Web Manual.pdf", ["Web manual text."]);
    ids.unlisted = await addManual(adminA, "unlisted.pdf", ["Quillwort everywhere."]);
    await importEntries(adminA, [
      entry(
        "atv-1.pdf",
        [
          [2020, "A20SXZ85A1", "SPORTSMAN 570"],
          [2021, "A21SXZ85A1", "SPORTSMAN 850 ULTIMATE TRAIL - CHALK GLO"],
        ],
        { brand: "ATV", modelYears: "2020-2021" },
      ),
      entry("gen-1.pdf", [[2020, "P20GDGDNA", "GENERATOR-P2000I"]], { brand: "GEN" }),
      entry("rzr-1.pdf", [[2024, "Z24NAE99AK", "RZR XP 1000 EPS"]], { brand: "RZR" }),
    ]);
  });

  const searchIds = async (filters: LibraryFilters, query = "quillwort") =>
    (await searchManuals(adminA.shop.id, query, filters)).map((hit) => hit.manualId).sort();
  const listIds = async (filters: LibraryFilters) =>
    (await listReadyManuals(adminA.shop.id, filters)).map((manual) => manual.id).sort();
  const sorted = (...names: string[]) => names.map((name) => ids[name]).sort();

  test("brand keeps search and the list to that brand's manuals", async () => {
    assert.deepEqual(await searchIds({}), sorted("atv", "gen", "rzr", "unlisted"));
    assert.deepEqual(await searchIds({}, "quillwort carburetor"), sorted("atv", "gen"));
    assert.deepEqual(await searchIds({ brand: "ATV" }, "quillwort carburetor"), sorted("atv"));
    assert.deepEqual(await searchIds({ brand: "GEN" }, "quillwort carburetor"), sorted("gen"));
    assert.deepEqual(await searchIds({ brand: "SNO" }), []);
    assert.deepEqual(await listIds({ brand: "ATV" }), sorted("atv", "web"));
    assert.deepEqual(await listIds({ brand: "RZR" }), sorted("rzr"));
  });

  test("year and model narrow by the models a manual covers", async () => {
    assert.deepEqual(await searchIds({ year: 2020 }), sorted("atv", "gen"));
    assert.deepEqual(await searchIds({ year: 2024 }), sorted("rzr"));
    assert.deepEqual(await searchIds({ model: "Z24NAE99" }), sorted("rzr"));
    assert.deepEqual(await searchIds({ model: "z24nae99ak" }), sorted("rzr"));
    assert.deepEqual(await searchIds({ model: "rzr xp 1000" }), sorted("rzr"));
    assert.deepEqual(await searchIds({ model: "RZR XP 900" }), []);
    assert.deepEqual(await searchIds({ model: "p2000i" }), sorted("gen"));
    assert.deepEqual(await searchIds({ model: "generator" }), sorted("gen"));
    assert.deepEqual(await searchIds({ model: "chalk glo" }), sorted("atv"));
    // Words match from the start of a word only.
    assert.deepEqual(await searchIds({ model: "PORTSMAN" }), []);
    assert.deepEqual(await listIds({ year: 2021 }), sorted("atv"));
  });

  test("filters combine, and year and model must match the same model", async () => {
    assert.deepEqual(await searchIds({ brand: "ATV", year: 2020 }), sorted("atv"));
    assert.deepEqual(await searchIds({ brand: "GEN", year: 2024 }), []);
    assert.deepEqual(await searchIds({ year: 2020, model: "570" }), sorted("atv"));
    assert.deepEqual(await searchIds({ year: 2021, model: "570" }), []);
    assert.deepEqual(await listIds({ brand: "ATV", year: 2021, model: "sportsman 850" }), sorted("atv"));
  });

  test("a filter or a scope keeps the whole library's hits for its manuals, ranked and ordered the same", async () => {
    const all = await searchManuals(adminA.shop.id, "quillwort");
    assert.equal(all.length, 4);
    assert.ok(new Set(all.map((hit) => hit.rank)).size > 1, JSON.stringify(all));
    const only = (...names: string[]) => all.filter((hit) => names.some((name) => ids[name] === hit.manualId));
    assert.deepEqual(await searchManuals(adminA.shop.id, "quillwort", { brand: "ATV" }), only("atv"));
    assert.deepEqual(await searchManuals(adminA.shop.id, "quillwort", { year: 2020 }), only("atv", "gen"));
    // Diagnose's scope for a unit, alone and with a filter.
    const scope = [ids.gen, ids.rzr, ids.unlisted];
    assert.deepEqual(await searchManuals(adminA.shop.id, "quillwort", {}, SEARCH_LIMIT, scope), only("gen", "rzr", "unlisted"));
    assert.deepEqual(await searchManuals(adminA.shop.id, "quillwort", { year: 2020 }, SEARCH_LIMIT, scope), only("gen"));
    assert.deepEqual(await searchManuals(adminA.shop.id, "quillwort", { brand: "ATV" }, SEARCH_LIMIT, scope), []);
  });

  test("manuals that aren't in the model list only show without filters", async () => {
    assert.ok((await listIds({})).includes(ids.unlisted));
    assert.ok(!(await listIds({ year: 2020 })).includes(ids.unlisted));
  });

  test("filter options list brands and years that ready manuals have", async () => {
    const options = await libraryFilterOptions(adminA.shop.id);
    assert.ok(options.manuals >= 5);
    // The web manual's brand was filled in from its model numbers.
    const brands = Object.fromEntries(options.brands.map((b) => [b.brand, b.manuals]));
    assert.deepEqual(brands, { ATV: 2, GEN: 1, RZR: 1 });
    assert.deepEqual(options.years, [2024, 2021, 2020]);
    const other = await libraryFilterOptions(adminB.shop.id);
    assert.deepEqual(other.brands, [{ brand: "RZR", manuals: 1 }]);
  });

  test("the address's filters are tidied", () => {
    assert.deepEqual(cleanLibraryFilters({ brand: " ATV ", year: "2020", model: "  rzr  xp " }), {
      brand: "ATV",
      year: 2020,
      model: "rzr xp",
    });
    assert.deepEqual(
      cleanLibraryFilters({ brand: ["ATV", "RZR"], year: "20x0", model: " - / " }),
      {},
    );
    assert.deepEqual(cleanLibraryFilters({ brand: "B".repeat(41), year: "1949", model: "\u0000" }), {});
    assert.deepEqual(cleanLibraryFilters({ year: "2101" }), {});
    assert.equal(cleanLibraryFilters({ model: "x".repeat(100) }).model?.length, 60);
    assert.deepEqual(modelFilterWords("rzr xp-1000 / 4"), ["RZR", "XP", "1000", "4"]);
  });

  test("odd filter text can't break the query", async () => {
    for (const model of ["%", "_", "'; drop table manuals; --", "\\", "é"]) {
      const filters = cleanLibraryFilters({ model });
      assert.deepEqual(await searchIds(filters), filters.model ? [] : sorted("atv", "gen", "rzr", "unlisted"), model);
    }
    assert.deepEqual(await searchIds({ brand: "'" }), []);
  });
});

describe("manuals for a model number", () => {
  test("finds the ready manuals covering a model number exactly, whatever the case", async () => {
    const atv = (await listReadyManuals(adminA.shop.id)).find((manual) => manual.title === "atv-1");
    assert.ok(atv);
    const found = await manualsForModel(adminA.shop.id, "a21sxz85a1");
    assert.deepEqual(
      found.map((manual) => manual.id),
      [atv.id],
    );
    assert.deepEqual(found[0].brands, ["ATV"]);
    assert.deepEqual(await manualsForModel(adminA.shop.id, " A20SXZ85A1 "), found);
    // Exact only: not the start of a model number.
    assert.deepEqual(await manualsForModel(adminA.shop.id, "A21SXZ85"), []);
    assert.deepEqual(await manualsForModel(adminA.shop.id, ""), []);
    assert.deepEqual(await manualsForModel(adminA.shop.id, "X".repeat(100)), []);
    // Another shop's model list doesn't count.
    assert.deepEqual(await manualsForModel(adminB.shop.id, "A21SXZ85A1"), []);
  });

  test("leaves out manuals that aren't ready", async () => {
    await importEntries(adminA, [entry("pending.pdf", [[2025, "A25PENDING", "PENDING"]], { brand: "ATV" })]);
    const pending = await startManualUpload(
      adminA,
      { fileName: "pending.pdf", sizeBytes: 10, sha256: createHash("sha256").update(randomUUID()).digest("hex") },
      { uploadUrl: async () => "u", downloadUrl: async () => "d", size: async () => null },
    );
    assert.ok("manualId" in pending);
    assert.deepEqual(await manualsForModel(adminA.shop.id, "A25PENDING"), []);
    await systemDb.update(manuals).set({ status: "ready", pageCount: 1 }).where(eq(manuals.id, pending.manualId));
    assert.deepEqual(
      (await manualsForModel(adminA.shop.id, "A25PENDING")).map((manual) => manual.id),
      [pending.manualId],
    );
  });
});

describe("file names and the model list", () => {
  test("a name with two spaces or a no-break space matches the same name in the list", async () => {
    const name = "9929400_2019_Outlaw  50\u00a0EFI.pdf";
    const id = await addManual(adminC, name, ["Outlaw 50 kickstart."]);
    const list = readModelList(
      csv([[name, "ATV", "9929400", "12/1/2018", "2019 Outlaw 50 Owner's Manual", "2019", "2019", "A19YAF05A4", "OUTLAW 50"]]),
    );
    assert.ok(!("error" in list) && list.files.length === 1, JSON.stringify(list));
    await importEntries(adminC, list.files);
    assert.deepEqual(
      (await manualsForModel(adminC.shop.id, "A19YAF05A4")).map((manual) => [manual.id, manual.title]),
      [[id, "2019 Outlaw 50 Owner's Manual"]],
    );
    const summary = await catalogSummary(adminC.shop.id);
    assert.ok(!summary.notListed.some((manual) => manual.id === id), JSON.stringify(summary.notListed));
    assert.ok(!summary.missingPdfs.some((entry) => entry.fileName === name), JSON.stringify(summary.missingPdfs));
  });
});

describe("the year filter and Model Years text", () => {
  const ids: Record<string, string> = {};

  before(async () => {
    ids.range = await addManual(adminC, "range.pdf", ["Wombatine supplement."]);
    ids.list = await addManual(adminC, "list.pdf", ["Wombatine list."]);
    ids.dated = await addManual(adminC, "dated.pdf", ["Wombatine dated."]);
    await importEntries(adminC, [
      // Listed without models: its Model Years is all there is to go on.
      entry("range.pdf", [], { brand: "GEN", modelYears: "2018-2027" }),
      // A model with no year doesn't count as dated.
      entry("list.pdf", [[null, "P99NOYEAR1", "GENERATOR"]], { brand: "GEN", modelYears: "2020, 2022" }),
      // Dated models win over the text.
      entry("dated.pdf", [[2020, "P20DATED01", "GENERATOR-P2000I"]], { brand: "GEN", modelYears: "2018-2027" }),
    ]);
  });

  const searchIds = async (filters: LibraryFilters) =>
    (await searchManuals(adminC.shop.id, "wombatine", filters)).map((hit) => hit.manualId).sort();
  const sorted = (...names: string[]) => names.map((name) => ids[name]).sort();

  test("an entry with no dated models matches the years its Model Years text covers", async () => {
    assert.deepEqual(await searchIds({ year: 2019 }), sorted("range"));
    assert.deepEqual(await searchIds({ year: 2020 }), sorted("range", "list", "dated"));
    assert.deepEqual(await searchIds({ year: 2021 }), sorted("range"));
    assert.deepEqual(await searchIds({ year: 2022 }), sorted("range", "list"));
    assert.deepEqual(await searchIds({ year: 2017 }), []);
    assert.deepEqual(await searchIds({ year: 2027, brand: "GEN" }), sorted("range"));
    assert.deepEqual(await searchIds({ year: 2027, brand: "ATV" }), []);
    // With Model too, the year has to be a matching model's own.
    assert.deepEqual(await searchIds({ year: 2020, model: "generator" }), sorted("dated"));
    assert.deepEqual(
      (await listReadyManuals(adminC.shop.id, { year: 2021 })).map((manual) => manual.id),
      [ids.range],
    );
  });
});

describe("the model filter and manual titles", () => {
  const ids: Record<string, string> = {};

  before(async () => {
    ids.spm = await addManual(adminC, "9921889.pdf", ["Marmotine belt."]);
    ids.rgr = await addManual(adminC, "9920736.pdf", ["Marmotine belt."]);
    ids.supplement = await addManual(adminC, "supplement.pdf", ["Marmotine belt."]);
    await importEntries(adminC, [
      // As in Polaris's list: older model descriptions abbreviate the name
      // (or leave it out) that the manual's title spells out.
      entry(
        "9921889.pdf",
        [
          [2009, "A09ZN85AL", "SPM XP 850, PNTD RED"],
          [2009, "A09ZN8EAW", "SPM XP 850 EPS, WHITE"],
        ],
        { brand: "ATV", title: "2009 SPORTSMAN XP 850 Service Manual", modelYears: "2009" },
      ),
      entry("9920736.pdf", [[2007, "R07RB50AA", "2X4,500 CARB,EB GRN"]], {
        brand: "RGR",
        title: "2007 RANGER 500 Service Manual",
        modelYears: "2007",
      }),
      // Listed without models: its title is all Model has to go on.
      entry("supplement.pdf", [], { brand: "ATV", title: "Sportsman Touring Supplement", modelYears: "2009" }),
    ]);
  });

  const searchIds = async (filters: LibraryFilters) =>
    (await searchManuals(adminC.shop.id, "marmotine", filters)).map((hit) => hit.manualId).sort();
  const listIds = async (filters: LibraryFilters) =>
    (await listReadyManuals(adminC.shop.id, filters)).map((manual) => manual.id).sort();
  const sorted = (...names: string[]) => names.map((name) => ids[name]).sort();

  test("model words match the manual's title as well as its models", async () => {
    assert.deepEqual(await searchIds({ model: "sportsman" }), sorted("spm", "supplement"));
    assert.deepEqual(await searchIds({ model: "Sportsman XP 850" }), sorted("spm"));
    assert.deepEqual(await searchIds({ model: "spm xp 850" }), sorted("spm"));
    assert.deepEqual(await searchIds({ model: "ranger 500" }), sorted("rgr"));
    assert.deepEqual(await listIds({ model: "sportsman xp 850" }), sorted("spm"));
    // Every word has to match the same entry, in its title or one model.
    assert.deepEqual(await searchIds({ model: "sportsman 500" }), []);
    assert.deepEqual(await searchIds({ model: "ranger 850" }), []);
    // Never some words from the title and the rest from a model: all from
    // one or all from the other.
    assert.deepEqual(await searchIds({ model: "sportsman eps white" }), []);
    assert.deepEqual(await searchIds({ model: "spm eps white" }), sorted("spm"));
    assert.deepEqual(await searchIds({ model: "sportsman pntd white" }), []);
    // From the start of a word only, as in model names.
    assert.deepEqual(await searchIds({ model: "ortsman" }), []);
  });

  test("with a year, the year still has to be one of the entry's own models'", async () => {
    assert.deepEqual(await searchIds({ year: 2009, model: "sportsman" }), sorted("spm"));
    assert.deepEqual(await searchIds({ vehicle: "ATV", year: 2009, model: "sportsman" }), sorted("spm"));
    assert.deepEqual(await listIds({ brand: "ATV", year: 2009, model: "sportsman xp 850" }), sorted("spm"));
    assert.deepEqual(await searchIds({ year: 2010, model: "sportsman" }), []);
    assert.deepEqual(await searchIds({ year: 2007, model: "ranger" }), sorted("rgr"));
    assert.deepEqual(await searchIds({ year: 2008, model: "ranger 500" }), []);
    assert.deepEqual(await searchIds({ vehicle: "UTV", year: 2009, model: "sportsman" }), []);
  });

  test("a title covering several sizes or lines doesn't lend one model another's name", async () => {
    ids.r900 = await addManual(adminC, "9928100.pdf", ["Marmotine belt."]);
    ids.r1000 = await addManual(adminC, "9928101.pdf", ["Marmotine belt."]);
    ids.rzr170 = await addManual(adminC, "9928102.pdf", ["Marmotine belt."]);
    ids.rzrs = await addManual(adminC, "9928103.pdf", ["Marmotine belt."]);
    await importEntries(
      adminC,
      [
        entry("9928100.pdf", [[2019, "R19RRE99A1", "RANGER XP 900 EPS"]], {
          brand: "RGR",
          title: "2018-2019 RANGER 900 / 1000",
          modelYears: "2018-2019",
        }),
        entry("9928101.pdf", [[2019, "R19RSE99A1", "RANGER XP 1000 EPS"]], {
          brand: "RGR",
          title: "2018-2019 RANGER XP 1000 (DOHC)",
          modelYears: "2018-2019",
        }),
        entry("9928102.pdf", [[2009, "Y09RZ17AB", "RZR 170, BLUE"]], {
          brand: "RZR",
          title: "2009 RZR 170 Service Manual",
          modelYears: "2009",
        }),
        entry("9928103.pdf", [[2009, "R09VH76AD", "RZR S, RED"]], {
          brand: "RZR",
          title: "2009-2010 RANGER RZR / RZR S / RZR 4 Service Manual",
          modelYears: "2009-2010",
        }),
      ],
      "manual-list - sizes.csv",
    );
    // RANGER and XP from the 900's model, 1000 from its title: not a match.
    assert.deepEqual(await searchIds({ year: 2019, model: "ranger xp 1000" }), sorted("r1000"));
    assert.deepEqual(await searchIds({ model: "ranger xp 1000" }), sorted("r1000"));
    // The whole title still counts: it names a RANGER 900.
    assert.deepEqual(await searchIds({ year: 2019, model: "ranger 900" }), sorted("r900"));
    // Short words and numbers only match whole title words: S isn't SERVICE.
    assert.deepEqual(await searchIds({ year: 2009, model: "rzr s" }), sorted("rzrs"));
  });

  test("words every title has, and years, don't match titles", async () => {
    for (const model of ["service", "manual", "service manual", "wire diagrams", "chapter", "2019", "2009 sportsman"]) {
      assert.deepEqual(await listIds({ model }), [], model);
    }
  });
});

describe("model list shop isolation", () => {
  const rlsDenied = (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501";

  test("can't read another shop's entries or models", async () => {
    await withShop(adminB.shop.id, async (tx) => {
      const documents = await tx.select({ shopId: manualCatalogDocuments.shopId }).from(manualCatalogDocuments);
      assert.ok(documents.length > 0 && documents.every((d) => d.shopId === adminB.shop.id));
      const models = await tx.select({ shopId: manualCatalogModels.shopId }).from(manualCatalogModels);
      assert.ok(models.length > 0 && models.every((m) => m.shopId === adminB.shop.id));
      const asked = await tx
        .select()
        .from(manualCatalogModels)
        .where(eq(manualCatalogModels.shopId, adminA.shop.id));
      assert.equal(asked.length, 0);
    });
    const noShop = await systemDb.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      return tx.select().from(manualCatalogDocuments);
    });
    assert.equal(noShop.length, 0);
  });

  test("can't add entries or models to another shop, even under its own shop ID", async () => {
    await assert.rejects(
      withShop(adminB.shop.id, (tx) =>
        tx.insert(manualCatalogDocuments).values({ shopId: adminA.shop.id, fileName: "sneaky.pdf", importId: randomUUID() }),
      ),
      rlsDenied,
    );
    await assert.rejects(
      withShop(adminB.shop.id, (tx) =>
        tx.insert(manualCatalogModels).values({ shopId: adminA.shop.id, fileKey: "atv-1.pdf", modelNumber: "X" }),
      ),
      rlsDenied,
    );
    // Its own shop ID on a file only shop A has: the shop/file key doesn't match.
    await assert.rejects(
      withShop(adminB.shop.id, (tx) =>
        tx.insert(manualCatalogModels).values({ shopId: adminB.shop.id, fileKey: "atv-1.pdf", modelNumber: "X" }),
      ),
      (error: Error & { cause?: { code?: string } }) => error.cause?.code === "23503",
    );
  });

  test("can't change or delete another shop's entries", async () => {
    const before = await snapshot(adminA.shop.id);
    const changed = await withShop(adminB.shop.id, (tx) =>
      tx
        .update(manualCatalogDocuments)
        .set({ brand: "DEFACED" })
        .where(eq(manualCatalogDocuments.shopId, adminA.shop.id))
        .returning(),
    );
    assert.equal(changed.length, 0);
    const deleted = await withShop(adminB.shop.id, async (tx) => [
      ...(await tx.delete(manualCatalogModels).where(eq(manualCatalogModels.shopId, adminA.shop.id)).returning()),
      ...(await tx.delete(manualCatalogDocuments).where(eq(manualCatalogDocuments.shopId, adminA.shop.id)).returning()),
    ]);
    assert.equal(deleted.length, 0);
    // Shop B's import of a file shop A also has leaves shop A's alone.
    await importEntries(adminB, [entry("atv-1.pdf", [[2030, "B30", "SHOP B"]], { brand: "OTHER" })]);
    assert.deepEqual(await snapshot(adminA.shop.id), before);
  });

  test("app code can't rewrite an entry's file, shop or import, or edit models in place", async () => {
    for (const statement of [
      `update "manual_catalog_documents" set "file_name" = 'x.pdf'`,
      `update "manual_catalog_documents" set "shop_id" = '${adminB.shop.id}'`,
      `update "manual_catalog_documents" set "import_id" = '${randomUUID()}'`,
      `update "manual_catalog_documents" set "title" = 'x'`,
      `update "manual_catalog_models" set "model_number" = 'X'`,
      `update "manual_catalog_models" set "shop_id" = '${adminB.shop.id}'`,
      // Nor can a manual's name, title or file change.
      `update "manuals" set "file_name" = 'x.pdf'`,
      `update "manuals" set "title" = 'x'`,
      `update "manuals" set "size_bytes" = 1`,
    ]) {
      await assert.rejects(
        withShop(adminA.shop.id, (tx) => tx.execute(sql.raw(statement))),
        rlsDenied,
        statement,
      );
    }
  });
});
