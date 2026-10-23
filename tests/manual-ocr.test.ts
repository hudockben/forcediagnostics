// Reading scanned pages with OCR: the rules the browser job uses (scale,
// image clean-up, which words to keep, batches, time left), and the server
// side: who may use it, the list of pages left to read, saving text without
// ever overwriting any, the counts and audit row when a manual is done,
// search over what OCR read, and that it all stays inside its own shop.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";

import { enterShop, systemDb, withShop } from "../src/db";
import { auditLog, manualPageToRead, manualPages, manuals, shops, users } from "../src/db/schema";
import { searchManuals } from "../src/lib/library";
import { listOcrWork, ocrFileUrl, saveOcrPages } from "../src/lib/manual-ocr";
import {
  MIN_CODE_CONFIDENCE,
  MIN_WORD_CONFIDENCE,
  OCR_MAX_PAGES_PER_BATCH,
  OCR_MAX_PIXELS,
  OCR_PAGES_PER_BATCH,
  batchBytes,
  describePages,
  fitsInBatch,
  fixDigitConfusions,
  formatDuration,
  ocrScale,
  ocrWorkerCount,
  pagesPerMinute,
  removeRules,
  roughSeconds,
  textFromTsv,
  toGreyPgm,
} from "../src/lib/manual-ocr-rules";
import { MAX_PAGE_TEXT_LENGTH, PAGE_BATCH_BYTES, type PageText } from "../src/lib/manual-rules";
import { confirmManualUpload, finishManual, listManuals, saveManualPages, startManualUpload, storageKeyFor } from "../src/lib/manuals";
import type { CurrentUser } from "../src/lib/session";
import type { FileStorage } from "../src/lib/storage";

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
let adminA: CurrentUser;
let adminB: CurrentUser;

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

// Stands in for R2: remembers which objects exist and how big they are.
function fakeStorage() {
  const objects = new Map<string, number>();
  const storage: FileStorage = {
    async uploadUrl(key) {
      return `https://storage.test/${key}?signature=put`;
    },
    async downloadUrl(key, fileName) {
      return `https://storage.test/${key}?signature=get&name=${encodeURIComponent(fileName)}`;
    },
    async size(key) {
      return objects.get(key) ?? null;
    },
  };
  return { objects, storage };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Adds a manual through the uploader's steps; ready unless told otherwise.
// An empty string is a scanned page with no text layer.
async function addManual(actor: CurrentUser, fileName: string, pages: string[], { finish = true } = {}) {
  const { objects, storage } = fakeStorage();
  const sizeBytes = 1000 + pages.join("").length;
  const start = await startManualUpload(actor, { fileName, sizeBytes, sha256: sha(fileName + randomUUID()) }, storage);
  assert.ok("next" in start && start.next === "upload", JSON.stringify(start));
  objects.set(storageKeyFor(actor.shop.id, start.manualId), sizeBytes);
  assert.deepEqual(await confirmManualUpload(actor, { manualId: start.manualId, pageCount: pages.length }, storage), {
    next: "extract",
  });
  const saved = await saveManualPages(actor, {
    manualId: start.manualId,
    pages: pages.map((text, index) => ({ pageNumber: index + 1, text })),
  });
  assert.deepEqual(saved, { saved: pages.length });
  if (finish) {
    const finished = await finishManual(actor, { manualId: start.manualId });
    assert.ok("added" in finished && finished.added, JSON.stringify(finished));
  }
  return start.manualId;
}

const pageRow = async (manualId: string, pageNumber: number) => {
  const [row] = await systemDb
    .select({ text: manualPages.text, ocrAt: manualPages.ocrAt })
    .from(manualPages)
    .where(and(eq(manualPages.manualId, manualId), eq(manualPages.pageNumber, pageNumber)));
  return row;
};

const manualRow = async (manualId: string) => {
  const [row] = await systemDb.select().from(manuals).where(eq(manuals.id, manualId));
  return row;
};

const workFor = async (actor: CurrentUser, manualId: string) => {
  const work = await listOcrWork(actor);
  assert.ok(!("error" in work), JSON.stringify(work));
  return work.manuals.find((manual) => manual.id === manualId);
};

before(async () => {
  adminA = await createShopWithAdmin(`oa${suffix}`);
  adminB = await createShopWithAdmin(`ob${suffix}`);
});

after(async () => {
  await systemDb.delete(shops).where(eq(shops.id, adminA.shop.id));
  await systemDb.delete(shops).where(eq(shops.id, adminB.shop.id));
  await systemDb.$client.end();
});

describe("drawing pages for OCR", () => {
  test("pages are drawn at 300 dpi, big ones smaller so memory stays sane", () => {
    const letter = ocrScale(612, 792);
    assert.equal(letter.dpi, 300);
    assert.equal(letter.scale, 300 / 72);
    assert.ok(612 * letter.scale * 792 * letter.scale <= OCR_MAX_PIXELS);
    // An 11 x 17 in fold-out and a 36 x 24 in wiring diagram.
    for (const [width, height] of [
      [792, 1224],
      [2592, 1728],
    ]) {
      const { scale, dpi } = ocrScale(width, height);
      assert.ok(width * scale * height * scale <= OCR_MAX_PIXELS * 1.0001, `${width}x${height}`);
      assert.ok(dpi < 300 && dpi > 100, `${width}x${height}: ${dpi}`);
    }
    assert.equal(ocrScale(792, 1224).dpi, 253);
    // A small page still gets 300 dpi, and nonsense sizes don't break it.
    assert.equal(ocrScale(300, 400).dpi, 300);
    assert.equal(ocrScale(0, 0).dpi, 300);
  });

  test("one worker per processor, leaving one, from one to four", () => {
    assert.deepEqual(
      [undefined, 0, Number.NaN, 1, 2, 3, 4, 6, 8, 16].map((n) => ocrWorkerCount(n)),
      [1, 1, 1, 1, 1, 2, 3, 4, 4, 4],
    );
  });

  test("a drawn page becomes a grey PGM image", () => {
    // Two pixels: white and pure red.
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]);
    const { image, pixels } = toGreyPgm(rgba, 2, 1);
    const header = "P5\n2 1\n255\n";
    assert.equal(new TextDecoder().decode(image.subarray(0, header.length)), header);
    assert.equal(image.length, header.length + 2);
    assert.deepEqual([...pixels], [255, 76]);
  });

  test("table rules and boxes are taken out, letters are left", () => {
    const width = 400;
    const height = 300;
    const grey = new Uint8Array(width * height).fill(255);
    const ink = (x: number, y: number) => (grey[y * width + x] = 0);
    // A table rule, two pixels thick, and a box edge down the side.
    for (let x = 20; x < 380; x++) {
      ink(x, 100);
      ink(x, 101);
    }
    for (let y = 10; y < 290; y++) ink(10, y);
    // A thin rule on a skewed scan: down one pixel every 60 across.
    for (let x = 20; x < 380; x++) ink(x, 200 + Math.floor((x - 20) / 60));
    // "Letters": short strokes, which must stay.
    for (let y = 40; y < 70; y++) {
      ink(50, y);
      ink(60, y);
    }
    for (let x = 50; x < 90; x++) ink(x, 40);
    const cleared = removeRules(grey, width, height, 150);
    assert.ok(cleared > 360 * 3, String(cleared));
    const dark = (x: number, y: number) => grey[y * width + x] < 160;
    assert.ok(!dark(200, 100) && !dark(200, 101) && !dark(10, 150), "rules left");
    // The skewed rule is broken up: at most a short stub at each end.
    let longest = 0;
    let left = 0;
    for (let y = 195; y < 210; y++) {
      for (let x = 0, run = 0; x < width; x++) {
        run = dark(x, y) ? run + 1 : 0;
        longest = Math.max(longest, run);
        if (dark(x, y)) left++;
      }
    }
    assert.ok(longest <= 60 && left <= 360 / 3, `skewed rule: longest ${longest}, ${left} pixels left`);
    assert.ok(dark(50, 55) && dark(60, 45) && dark(70, 40), "letters taken out");
  });

  test("a dark background and a black panel aren't taken for rules", () => {
    const width = 400;
    const height = 300;
    // A dark grey photocopy: the whole page darker than a rule, with
    // darker letters on it.
    const photocopy = new Uint8Array(width * height).fill(140);
    for (let y = 50; y < 60; y++) for (let x = 40; x < 300; x += 7) photocopy[y * width + x] = 30;
    const copied = photocopy.slice();
    assert.equal(removeRules(photocopy, width, height, 150), 0);
    assert.deepEqual(photocopy, copied);

    // White words in a black panel (a WARNING label) on a white page, with a
    // thin table rule under it, which still goes.
    const page = new Uint8Array(width * height).fill(255);
    for (let y = 100; y < 160; y++) {
      for (let x = 20; x < 380; x++) page[y * width + x] = x % 9 < 3 && y > 115 && y < 145 ? 255 : 0;
    }
    for (let x = 20; x < 380; x++) page[250 * width + x] = 0;
    const panel = page.slice(100 * width, 160 * width);
    assert.equal(removeRules(page, width, height, 150), 360);
    assert.deepEqual(page.slice(100 * width, 160 * width), panel);
    assert.equal(page[250 * width + 200], 255);
  });
});

describe("what OCR keeps", () => {
  // Tesseract's TSV: level page block paragraph line word left top width height conf text.
  const word = (block: number, paragraph: number, line: number, n: number, conf: number, text: string) =>
    ["5", "1", block, paragraph, line, n, 0, 0, 10, 10, conf, text].join("\t");
  const tsv = [
    ["1", "1", "0", "0", "0", "0", "0", "0", "2550", "3300", "-1", ""].join("\t"),
    word(1, 1, 1, 1, 96, "Fuel"),
    word(1, 1, 1, 2, 95, "pump"),
    word(1, 1, 1, 3, 93, "relay"),
    word(1, 1, 2, 1, 91, "Code"),
    word(1, 1, 2, 2, 88, "PO300"),
    word(1, 1, 2, 3, 30, "~zq"),
    word(1, 1, 2, 4, 90, "|"),
    // Codes and part numbers it read right but isn't sure of.
    word(1, 1, 2, 5, 37, "PB10F,"),
    word(1, 1, 2, 6, MIN_CODE_CONFIDENCE - 1, "P0171"),
    // A photo: a few words, mostly ones it isn't sure of.
    word(2, 1, 1, 1, 20, "Hii"),
    word(2, 1, 1, 2, 92, "i"),
    word(2, 1, 1, 3, 12, "Ba"),
    word(2, 1, 1, 4, 25, "57"),
    word(2, 1, 1, 5, 25, "£5"),
    // A second paragraph.
    word(3, 1, 1, 1, 94, "Torque"),
    word(3, 1, 1, 2, 90, "22O5l23"),
  ].join("\n");

  test("keeps the words it's sure of, lines and paragraphs apart, and fixes digits", () => {
    assert.equal(textFromTsv(tsv), "Fuel pump relay\nCode P0300 PB10F,\n\nTorque 2205123");
    assert.equal(textFromTsv(""), "");
    assert.equal(textFromTsv(word(1, 1, 1, 1, MIN_WORD_CONFIDENCE - 1, "maybe")), "");
    assert.equal(textFromTsv(word(1, 1, 1, 1, MIN_WORD_CONFIDENCE, "sure")), "sure");
  });

  test("only digits in fault codes and part numbers are fixed", () => {
    assert.equal(fixDigitConfusions("PO300 P03O1 U0l00 BO1A2"), "P0300 P0301 U0l00 B01A2");
    // Too few digits to be sure of: left as it is.
    assert.equal(fixDigitConfusions("part 22O5l23, 3OOO rpm"), "part 2205123, 3OOO rpm");
    for (const words of ["BOOST COOLED Oil IOU POOL lOl ODE PODS", "P0300 2205123", "Il1lO"]) {
      assert.equal(fixDigitConfusions(words), words);
    }
  });
});

describe("batches and time left", () => {
  test("ten pages a batch, and never near the 1 MB Server Action limit", () => {
    const short: PageText = { pageNumber: 1, text: "Fuel pump relay" };
    let batch = { pages: 0, bytes: 0 };
    let sent = 0;
    for (let n = 0; n < 25; n++) {
      if (!fitsInBatch(batch, batchBytes(short))) {
        assert.equal(batch.pages, OCR_PAGES_PER_BATCH);
        batch = { pages: 0, bytes: 0 };
        sent++;
      }
      batch = { pages: batch.pages + 1, bytes: batch.bytes + batchBytes(short) };
    }
    assert.equal(sent, 2);
    assert.ok(OCR_PAGES_PER_BATCH <= OCR_MAX_PAGES_PER_BATCH);

    // The biggest pages there can be: every character three bytes as sent.
    const huge: PageText = { pageNumber: 1, text: "€".repeat(MAX_PAGE_TEXT_LENGTH) };
    const size = batchBytes(huge);
    batch = { pages: 0, bytes: 0 };
    let biggest = 0;
    for (let n = 0; n < 12; n++) {
      if (!fitsInBatch(batch, size)) batch = { pages: 0, bytes: 0 };
      batch = { pages: batch.pages + 1, bytes: batch.bytes + size };
      biggest = Math.max(biggest, batch.bytes);
    }
    assert.ok(biggest <= PAGE_BATCH_BYTES && biggest < 1024 * 1024, String(biggest));
    // An empty batch takes any page.
    assert.equal(fitsInBatch({ pages: 0, bytes: 0 }, PAGE_BATCH_BYTES * 2), true);
  });

  test("pages a minute over the last few minutes, from when reading resumed", () => {
    const now = 1_000_000;
    const every2s = Array.from({ length: 30 }, (_, i) => now - i * 2000);
    // 30 pages in the last three minutes.
    assert.equal(Math.round(pagesPerMinute(every2s, now, 0)!), 10);
    // Only the last minute since resuming: 30 pages in a minute.
    assert.equal(Math.round(pagesPerMinute(every2s, now, now - 60_000)!), 30);
    assert.equal(pagesPerMinute(every2s.slice(0, 2), now, 0), null);
    assert.equal(pagesPerMinute(every2s, now, now - 5000), null);
  });

  test("time left reads like a person would say it", () => {
    assert.equal(formatDuration(0), "less than a minute");
    assert.equal(formatDuration(59), "less than a minute");
    assert.equal(formatDuration(80), "about a minute");
    assert.equal(formatDuration(25 * 60), "about 25 minutes");
    assert.equal(formatDuration(60 * 60), "about 1 hour");
    assert.equal(formatDuration(130 * 60), "about 2 hours 10 minutes");
    assert.equal(formatDuration(61 * 60), "about 1 hour 1 minute");
    assert.equal(formatDuration(235 * 60), "about 4 hours");
    assert.equal(formatDuration(14.4 * 3600), "about 14 hours");
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), "less than a minute");
    // 1,000 pages at about a second a page with three workers.
    assert.equal(formatDuration(roughSeconds(1000, 3)), "about 17 minutes");
    assert.equal(roughSeconds(10, 0), 30);
  });

  test("failed pages are listed as ranges", () => {
    assert.equal(describePages([9, 3, 4, 5, 5]), "pages 3-5, 9");
    assert.equal(describePages([12]), "page 12");
  });
});

describe("who can read scanned pages", () => {
  let manualId: string;

  before(async () => {
    manualId = await addManual(adminA, "Who.pdf", ["Text from the PDF", ""]);
  });

  test("only admins signed in with a password, and only in their own shop", async () => {
    const { storage } = fakeStorage();
    const tech: CurrentUser = { ...adminA, role: "tech" };
    const manager: CurrentUser = { ...adminA, role: "manager" };
    const onTablet: CurrentUser = {
      ...adminA,
      bay: { deviceId: randomUUID(), deviceName: "Bay 1", sessionId: randomUUID() },
    };
    for (const actor of [tech, manager, onTablet]) {
      for (const result of [
        await listOcrWork(actor),
        await ocrFileUrl(actor, { manualId }, storage),
        await saveOcrPages(actor, { manualId, pages: [{ pageNumber: 2, text: "sneaky words" }] }),
      ]) {
        assert.ok("error" in result && result.error.includes("admin"), JSON.stringify(result));
      }
    }
    // Another shop's admin can't see it, get its file or give it text.
    assert.equal(await workFor(adminB, manualId), undefined);
    assert.ok("error" in (await ocrFileUrl(adminB, { manualId }, storage)));
    assert.ok("error" in (await saveOcrPages(adminB, { manualId, pages: [{ pageNumber: 2, text: "sneaky" }] })));
    assert.deepEqual(await pageRow(manualId, 2), { text: "", ocrAt: null });

    const link = await ocrFileUrl(adminA, { manualId }, storage);
    assert.ok("url" in link && link.url.includes(storageKeyFor(adminA.shop.id, manualId)), JSON.stringify(link));
    assert.ok("error" in (await ocrFileUrl(adminA, { manualId: "not-an-id" }, storage)));
  });
});

describe("the pages left to read", () => {
  let mixed: string;
  let scanned: string;
  let unfinished: string;

  before(async () => {
    mixed = await addManual(adminA, "Mixed scan.pdf", [
      "Chapter 1. Text from the PDF itself.",
      "",
      "Chapter 2. More text.",
      // A stray mark: nothing search can find.
      " . ",
      // Nothing search can find, but too long to be a stray mark.
      ". ".repeat(60),
      "",
    ]);
    scanned = await addManual(adminA, "All scanned.pdf", ["", "", ""]);
    unfinished = await addManual(adminA, "Unfinished scan.pdf", ["", ""], { finish: false });
  });

  test("lists ready manuals' pages with no text, in order, with totals", async () => {
    const work = await listOcrWork(adminA);
    assert.ok(!("error" in work));
    const mine = work.manuals.filter((manual) => [mixed, scanned, unfinished].includes(manual.id));
    assert.deepEqual(
      mine.map(({ id, title, pageCount, pages }) => ({ id, title, pageCount, pages })),
      [
        { id: scanned, title: "All scanned", pageCount: 3, pages: [1, 2, 3] },
        { id: mixed, title: "Mixed scan", pageCount: 6, pages: [2, 4, 6] },
      ],
    );
    assert.equal(work.pages, work.manuals.reduce((total, manual) => total + manual.pages.length, 0));
  });

  test("finds them by index, under row-level security", async () => {
    let plan = "";
    await systemDb
      .transaction(async (tx) => {
        await enterShop(tx, adminA.shop.id);
        await tx.execute(sql`set local enable_seqscan = off`);
        const result = await tx.execute<{ "QUERY PLAN": string }>(
          sql`explain select manual_id, page_number from manual_pages where ${manualPageToRead}`,
        );
        plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        tx.rollback();
      })
      .catch((error) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    assert.match(plan, /manual_pages_to_read/, plan);
  });
});

describe("saving what OCR read", () => {
  let manualId: string;
  let pagesWithoutTextBefore: number;

  before(async () => {
    manualId = await addManual(adminA, "Save scan.pdf", ["Text from the PDF: zorblaxquin is not here.", "", "", " . ", ""]);
    pagesWithoutTextBefore = (await manualRow(manualId)).pagesWithoutText ?? -1;
    assert.equal(pagesWithoutTextBefore, 4);
  });

  test("refuses malformed batches and pages outside the manual", async () => {
    for (const pages of [
      [],
      [{ pageNumber: 0, text: "x" }],
      [{ pageNumber: 6, text: "x" }],
      [{ pageNumber: 2.5, text: "x" }],
      [{ pageNumber: 2, text: 42 }],
      [null],
      Array.from({ length: OCR_MAX_PAGES_PER_BATCH + 1 }, (_, i) => ({ pageNumber: (i % 5) + 1, text: "x" })),
      "not a list",
    ]) {
      const result = await saveOcrPages(adminA, { manualId, pages: pages as never });
      assert.ok("error" in result, JSON.stringify(pages).slice(0, 60));
    }
    assert.ok("error" in (await saveOcrPages(adminA, { manualId: "nope", pages: [{ pageNumber: 2, text: "x" }] })));
    assert.equal((await pageRow(manualId, 2)).ocrAt, null);
  });

  test("gives text only to pages with none, cleaned and capped, and marks them read", async () => {
    const result = await saveOcrPages(adminA, {
      manualId,
      pages: [
        // Has text from the PDF: left alone.
        { pageNumber: 1, text: "OCR's idea of page one" },
        { pageNumber: 2, text: "Inspect the zorblaxquin\u0000 bracket.  Fault code P0300.\r\nPart 2205123" },
        // A blank page: read, nothing found.
        { pageNumber: 3, text: "" },
        { pageNumber: 4, text: "word ".repeat(MAX_PAGE_TEXT_LENGTH) },
      ],
    });
    assert.deepEqual(result, { saved: 3, withText: 2, skipped: 1, done: false });
    assert.deepEqual(await pageRow(manualId, 1), { text: "Text from the PDF: zorblaxquin is not here.", ocrAt: null });
    const two = await pageRow(manualId, 2);
    assert.equal(two.text, "Inspect the zorblaxquin bracket. Fault code P0300.\nPart 2205123");
    assert.ok(two.ocrAt instanceof Date);
    const three = await pageRow(manualId, 3);
    assert.equal(three.text, "");
    assert.ok(three.ocrAt instanceof Date);
    // A stray mark from the PDF stays, with OCR's words after it.
    const four = await pageRow(manualId, 4);
    assert.ok(four.text.startsWith(".\n\nword word"), four.text.slice(0, 20));
    assert.equal(four.text.length, MAX_PAGE_TEXT_LENGTH);

    // Counted as it goes: two pages have text now.
    const row = await manualRow(manualId);
    assert.equal(row.pagesWithoutText, pagesWithoutTextBefore - 2);
    assert.equal(row.pagesReadByOcr, 2);
    assert.ok(!(await workFor(adminA, manualId))?.pages.includes(2));
    assert.deepEqual((await workFor(adminA, manualId))?.pages, [5]);
  });

  test("never overwrites what an earlier OCR read", async () => {
    const before = await pageRow(manualId, 2);
    const again = await saveOcrPages(adminA, {
      manualId,
      pages: [
        { pageNumber: 2, text: "a second reading" },
        { pageNumber: 3, text: "words on a blank page" },
      ],
    });
    assert.deepEqual(again, { saved: 0, withText: 0, skipped: 2, done: false });
    assert.deepEqual(await pageRow(manualId, 2), before);
    assert.equal((await pageRow(manualId, 3)).text, "");
  });

  test("each batch is recorded with its pages, and the last page counts the manual again", async () => {
    // Off by a few from somewhere else, say: the recount puts it right.
    await systemDb.update(manuals).set({ pagesWithoutText: 99 }).where(eq(manuals.id, manualId));
    const last = await saveOcrPages(adminA, { manualId, pages: [{ pageNumber: 5, text: "Throttle cable quokkaslide" }] });
    assert.deepEqual(last, { saved: 1, withText: 1, skipped: 0, done: true });
    const row = await manualRow(manualId);
    // Only the blank page 3 is left without text.
    assert.equal(row.pagesWithoutText, 1);
    assert.equal(row.pagesReadByOcr, 3);
    assert.equal(await workFor(adminA, manualId), undefined);

    // One row for each batch that changed pages (the batch that changed
    // none wrote nothing), in the same transaction as its text; the last
    // one says the manual is done, with its counts.
    const recorded = () =>
      systemDb
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetId, manualId), eq(auditLog.action, "manual.ocr")))
        .orderBy(auditLog.createdAt, auditLog.id);
    const entries = await recorded();
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.actorUserId, adminA.id);
      assert.equal(entry.shopId, adminA.shop.id);
    }
    assert.deepEqual(
      entries.map((entry) => entry.details),
      [
        { title: "Save scan", fileName: "Save scan.pdf", pages: [2, 3, 4], pagesGainedText: 2 },
        {
          title: "Save scan",
          fileName: "Save scan.pdf",
          pages: [5],
          pagesGainedText: 1,
          finished: true,
          pagesRead: 4,
          pagesWithText: 3,
          pagesWithoutText: 1,
        },
      ],
    );

    // Another tab sending the same page later changes nothing.
    const late = await saveOcrPages(adminA, { manualId, pages: [{ pageNumber: 5, text: "different" }] });
    assert.deepEqual(late, { saved: 0, withText: 0, skipped: 1, done: true });
    assert.equal((await recorded()).length, 2);

    const listed = (await listManuals(adminA.shop.id)).find((manual) => manual.id === manualId);
    assert.equal(listed?.pagesReadByOcr, 3);
    assert.equal(listed?.pagesWithoutText, 1);
  });

  test("what OCR read is searchable, with snippets, and opens at its page", async () => {
    const hits = await searchManuals(adminA.shop.id, "zorblaxquin bracket");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].manualId, manualId);
    assert.equal(hits[0].pageNumber, 2);
    const matched = hits[0].snippet.filter((part) => part.match).map((part) => part.text.toLowerCase());
    assert.ok(matched.includes("zorblaxquin") && matched.includes("bracket"), JSON.stringify(hits[0].snippet));
    for (const query of ["P0300 zorblaxquin", "2205123 zorblaxquin", "quokkaslide"]) {
      const found = await searchManuals(adminA.shop.id, query);
      assert.equal(found[0]?.manualId, manualId, query);
    }
    assert.equal((await searchManuals(adminB.shop.id, "zorblaxquin")).length, 0);
  });

  test("an unfinished manual takes no OCR text", async () => {
    const unfinished = await addManual(adminA, "Not ready scan.pdf", ["", ""], { finish: false });
    const result = await saveOcrPages(adminA, { manualId: unfinished, pages: [{ pageNumber: 1, text: "early" }] });
    assert.ok("error" in result, JSON.stringify(result));
    assert.deepEqual(await pageRow(unfinished, 1), { text: "", ocrAt: null });
  });
});

describe("OCR shop isolation", () => {
  let manualA: string;

  before(async () => {
    manualA = await addManual(adminA, "Isolated scan.pdf", ["", "Text"]);
  });

  test("app code can mark its own shop's pages read, never another shop's", async () => {
    const fromB = await withShop(adminB.shop.id, (tx) =>
      tx.update(manualPages).set({ ocrAt: new Date() }).where(eq(manualPages.manualId, manualA)).returning(),
    );
    assert.equal(fromB.length, 0);
    const counted = await withShop(adminB.shop.id, (tx) =>
      tx.update(manuals).set({ pagesReadByOcr: 5 }).where(eq(manuals.id, manualA)).returning(),
    );
    assert.equal(counted.length, 0);
    assert.deepEqual(await pageRow(manualA, 1), { text: "", ocrAt: null });
    assert.equal((await manualRow(manualA)).pagesReadByOcr, null);

    const fromA = await withShop(adminA.shop.id, (tx) =>
      tx
        .update(manualPages)
        .set({ ocrAt: new Date() })
        .where(and(eq(manualPages.manualId, manualA), eq(manualPages.pageNumber, 1)))
        .returning({ pageNumber: manualPages.pageNumber }),
    );
    assert.deepEqual(fromA, [{ pageNumber: 1 }]);
  });

  test("the new grants don't open up anything else", async () => {
    for (const statement of [
      `update "manual_pages" set "page_number" = 99`,
      `update "manual_pages" set "manual_id" = gen_random_uuid()`,
      `update "manuals" set "title" = 'Renamed'`,
      `update "manuals" set "storage_key" = 'elsewhere'`,
      `delete from "manual_pages"`,
    ]) {
      await assert.rejects(
        withShop(adminA.shop.id, (tx) => tx.execute(sql.raw(statement))),
        (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
        statement,
      );
    }
  });
});
