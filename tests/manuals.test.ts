// The manual library: adding manuals step by step (with a stand-in for file
// storage), page text checks, full-text search, and that manuals and their
// pages stay inside their own shop. Needs DATABASE_URL pointing at a
// disposable Postgres database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";

import { enterShop, systemDb, withShop } from "../src/db";
import { auditLog, manualCatalogDocuments, manualFileNames, manualPages, manuals, shops, users } from "../src/db/schema";
import { SEARCH_LIMIT, cleanSearchQuery, listReadyManuals, searchManuals, searchQuery } from "../src/lib/library";
import {
  MAX_PAGES_PER_BATCH,
  MAX_PAGE_TEXT_LENGTH,
  cleanPageText,
  parseSnippet,
  titleFromFileName,
} from "../src/lib/manual-rules";
import {
  confirmManualUpload,
  finishManual,
  listManuals,
  saveManualPages,
  startManualUpload,
  storageKeyFor,
} from "../src/lib/manuals";
import { ADMIN_SECTIONS, can, needsPasswordSession } from "../src/lib/permissions";
import { ROLES } from "../src/lib/roles";
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
    async downloadUrl(key) {
      return `https://storage.test/${key}?signature=get`;
    },
    async size(key) {
      return objects.get(key) ?? null;
    },
  };
  return { objects, storage };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Adds a manual all the way to ready, through the same steps the uploader uses.
async function addManual(actor: CurrentUser, fileName: string, pages: string[]) {
  const { objects, storage } = fakeStorage();
  const sizeBytes = 1000 + pages.join("").length;
  const start = await startManualUpload(actor, { fileName, sizeBytes, sha256: sha(fileName + randomUUID()) }, storage);
  assert.ok("next" in start && start.next === "upload", JSON.stringify(start));
  objects.set(storageKeyFor(actor.shop.id, start.manualId), sizeBytes);
  const confirmed = await confirmManualUpload(actor, { manualId: start.manualId, pageCount: pages.length }, storage);
  assert.deepEqual(confirmed, { next: "extract" });
  const saved = await saveManualPages(actor, {
    manualId: start.manualId,
    pages: pages.map((text, index) => ({ pageNumber: index + 1, text })),
  });
  assert.deepEqual(saved, { saved: pages.length });
  const finished = await finishManual(actor, { manualId: start.manualId });
  assert.ok("added" in finished && finished.added, JSON.stringify(finished));
  return start.manualId;
}

before(async () => {
  adminA = await createShopWithAdmin(`ma${suffix}`);
  adminB = await createShopWithAdmin(`mb${suffix}`);
});

after(async () => {
  await systemDb.delete(shops).where(eq(shops.id, adminA.shop.id));
  await systemDb.delete(shops).where(eq(shops.id, adminB.shop.id));
  await systemDb.$client.end();
});

describe("manual titles and page text", () => {
  test("titles drop .pdf and the download's numbering", () => {
    assert.equal(titleFromFileName("001 - 2019 Sportsman 570 Service Manual.pdf"), "2019 Sportsman 570 Service Manual");
    assert.equal(titleFromFileName("281 - RZR XP 1000 Owner's Manual.PDF"), "RZR XP 1000 Owner's Manual");
    assert.equal(titleFromFileName("2019 - RZR Owner's Manual.pdf"), "2019 - RZR Owner's Manual");
    assert.equal(titleFromFileName("Ranger  1000   Service.pdf"), "Ranger 1000 Service");
    assert.equal(titleFromFileName("C:\\Manuals\\002 - General.pdf"), "General");
    assert.equal(titleFromFileName("001 - .pdf"), "001 - .pdf");
    assert.equal(titleFromFileName(".pdf"), ".pdf");
  });

  test("page text loses NULs and control characters and is capped", () => {
    assert.equal(cleanPageText("P0\u0000300  code\r\nnext\u0002line\u0003"), "P0300 code\nnext line");
    assert.equal(cleanPageText("x".repeat(MAX_PAGE_TEXT_LENGTH + 10)).length, MAX_PAGE_TEXT_LENGTH);
  });

  test("snippets split into plain and matched parts", () => {
    assert.deepEqual(parseSnippet("check the \u0002fuel\u0003 \u0002pump\u0003 relay"), [
      { text: "check the ", match: false },
      { text: "fuel", match: true },
      { text: " ", match: false },
      { text: "pump", match: true },
      { text: " relay", match: false },
    ]);
    assert.deepEqual(parseSnippet("<b>not html</b>"), [{ text: "<b>not html</b>", match: false }]);
  });
});

describe("who can use the library", () => {
  test("everyone can read it, on a bay tablet too; only admins add manuals", () => {
    for (const role of ROLES) {
      assert.equal(can(role, "library.read"), true, role);
      assert.equal(can(role, "settings.manage"), role === "admin", role);
    }
    assert.equal(needsPasswordSession("library.read"), false);
    assert.equal(needsPasswordSession("settings.manage"), true);
    assert.deepEqual(
      ADMIN_SECTIONS.find((section) => section.href === "/admin/manuals")?.capability,
      "settings.manage",
    );
  });
});

describe("starting an upload", () => {
  test("a new file gets a row and an upload URL for a key built from IDs", async () => {
    const { storage } = fakeStorage();
    const start = await startManualUpload(
      adminA,
      { fileName: "001 - Sportsman 450 Service Manual.pdf", sizeBytes: 5000, sha256: sha("new") },
      storage,
    );
    assert.ok("next" in start && start.next === "upload");
    const [row] = await systemDb.select().from(manuals).where(eq(manuals.id, start.manualId));
    assert.equal(row.shopId, adminA.shop.id);
    assert.equal(row.status, "uploading");
    assert.equal(row.title, "Sportsman 450 Service Manual");
    assert.equal(row.uploadedByUserId, adminA.id);
    assert.equal(row.storageKey, `shops/${adminA.shop.id}/manuals/${start.manualId}.pdf`);
    assert.ok(start.uploadUrl.includes(row.storageKey));
  });

  test("an unfinished file resumes: upload again, or skip the upload if it's stored", async () => {
    const { objects, storage } = fakeStorage();
    const input = { fileName: "Resume me.pdf", sizeBytes: 7000, sha256: sha("resume") };
    const first = await startManualUpload(adminA, input, storage);
    assert.ok("next" in first && first.next === "upload");
    const key = storageKeyFor(adminA.shop.id, first.manualId);

    // Nothing arrived: a fresh upload URL for the same manual.
    const again = await startManualUpload(adminA, { ...input, fileName: "Renamed.pdf" }, storage);
    assert.ok("next" in again && again.next === "upload");
    assert.equal(again.manualId, first.manualId);

    // Part of it arrived: upload again.
    objects.set(key, 3000);
    const partial = await startManualUpload(adminA, input, storage);
    assert.ok("next" in partial && partial.next === "upload");

    // All of it arrived: go straight to confirming.
    objects.set(key, input.sizeBytes);
    const stored = await startManualUpload(adminA, input, storage);
    assert.deepEqual(stored, { next: "confirm", manualId: first.manualId });

    const rows = await systemDb.select().from(manuals).where(eq(manuals.sha256, input.sha256));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fileName, "Resume me.pdf");
  });

  test("a file already in the library is skipped, whatever it's called", async () => {
    const id = await addManual(adminA, "Skip me.pdf", ["page one"]);
    const [row] = await systemDb.select().from(manuals).where(eq(manuals.id, id));
    const { storage } = fakeStorage();
    const again = await startManualUpload(
      adminA,
      { fileName: "SKIP ME.pdf", sizeBytes: row.sizeBytes, sha256: row.sha256 },
      storage,
    );
    assert.deepEqual(again, { next: "skip", manualId: id, title: "Skip me", message: "Already in the library as Skip me" });
    // Under another name, the name is linked to it (see the model list tests).
    const copy = await startManualUpload(
      adminA,
      { fileName: "Copy of skip me.pdf", sizeBytes: row.sizeBytes, sha256: row.sha256 },
      storage,
    );
    assert.deepEqual(copy, {
      next: "skip",
      manualId: id,
      title: "Skip me",
      message: "Same file as Skip me.pdf, already in the library. Linked this name to it.",
    });
  });

  test("two tabs starting the same file share one row", async () => {
    const { storage } = fakeStorage();
    const input = { fileName: "Race.pdf", sizeBytes: 4000, sha256: sha("race") };
    const results = await Promise.all([1, 2, 3].map(() => startManualUpload(adminA, input, storage)));
    const ids = new Set(results.map((r) => ("manualId" in r ? r.manualId : r.error)));
    assert.equal(ids.size, 1, JSON.stringify(results));
    assert.ok(results.every((r) => "next" in r && r.next === "upload"));
    const rows = await systemDb.select().from(manuals).where(eq(manuals.sha256, input.sha256));
    assert.equal(rows.length, 1);
  });

  test("each shop keeps its own copy of the same file", async () => {
    const { storage } = fakeStorage();
    const input = { fileName: "Shared.pdf", sizeBytes: 4000, sha256: sha("both shops") };
    const a = await startManualUpload(adminA, input, storage);
    const b = await startManualUpload(adminB, input, storage);
    assert.ok("manualId" in a && "manualId" in b);
    assert.notEqual(a.manualId, b.manualId);
    assert.ok("uploadUrl" in b && b.uploadUrl.includes(`shops/${adminB.shop.id}/`));
  });

  test("refuses files that can't be manuals", async () => {
    const { storage } = fakeStorage();
    const good = { fileName: "Ok.pdf", sizeBytes: 100, sha256: sha("ok") };
    for (const input of [
      { ...good, fileName: "notes.docx" },
      { ...good, sizeBytes: 0 },
      { ...good, sizeBytes: 1.5 },
      { ...good, sizeBytes: 600 * 1024 * 1024 },
      { ...good, sha256: "not-a-hash" },
      { ...good, fileName: `${"x".repeat(300)}.pdf` },
    ]) {
      const result = await startManualUpload(adminA, input, storage);
      assert.ok("error" in result, JSON.stringify(input).slice(0, 80));
    }
  });
});

describe("confirming an upload", () => {
  test("needs the whole file in storage and a sane page count", async () => {
    const { objects, storage } = fakeStorage();
    const start = await startManualUpload(
      adminA,
      { fileName: "Confirm.pdf", sizeBytes: 9000, sha256: sha("confirm") },
      storage,
    );
    assert.ok("manualId" in start);
    const key = storageKeyFor(adminA.shop.id, start.manualId);
    const confirm = (pageCount: number) =>
      confirmManualUpload(adminA, { manualId: start.manualId, pageCount }, storage);

    assert.ok("error" in (await confirm(10)), "nothing stored yet");
    objects.set(key, 8999);
    assert.ok("error" in (await confirm(10)), "wrong size");
    objects.set(key, 9000);
    for (const pageCount of [0, -1, 2.5, Number.NaN, 1_000_000]) {
      assert.ok("error" in (await confirm(pageCount)), String(pageCount));
    }
    assert.deepEqual(await confirm(10), { next: "extract" });
    assert.ok("error" in (await confirm(11)), "page count can't change");
    assert.deepEqual(await confirm(10), { next: "extract" });

    const [row] = await systemDb.select().from(manuals).where(eq(manuals.id, start.manualId));
    assert.equal(row.status, "extracting");
    assert.equal(row.pageCount, 10);
  });

  test("can't confirm another shop's manual", async () => {
    const { objects, storage } = fakeStorage();
    const start = await startManualUpload(
      adminA,
      { fileName: "Mine.pdf", sizeBytes: 100, sha256: sha("mine") },
      storage,
    );
    assert.ok("manualId" in start);
    objects.set(storageKeyFor(adminA.shop.id, start.manualId), 100);
    const result = await confirmManualUpload(adminB, { manualId: start.manualId, pageCount: 1 }, storage);
    assert.ok("error" in result);
    assert.ok("error" in (await confirmManualUpload(adminB, { manualId: "nope", pageCount: 1 }, storage)));
  });
});

describe("saving page text", () => {
  let manualId: string;

  before(async () => {
    const { objects, storage } = fakeStorage();
    const start = await startManualUpload(
      adminA,
      { fileName: "Pages.pdf", sizeBytes: 300, sha256: sha("pages") },
      storage,
    );
    assert.ok("manualId" in start);
    manualId = start.manualId;
    // Not confirmed yet: no text accepted.
    const early = await saveManualPages(adminA, { manualId, pages: [{ pageNumber: 1, text: "x" }] });
    assert.ok("error" in early);
    objects.set(storageKeyFor(adminA.shop.id, manualId), 300);
    assert.deepEqual(await confirmManualUpload(adminA, { manualId, pageCount: 3 }, storage), { next: "extract" });
  });

  const storedText = async (pageNumber: number) => {
    const [row] = await systemDb
      .select({ text: manualPages.text })
      .from(manualPages)
      .where(and(eq(manualPages.manualId, manualId), eq(manualPages.pageNumber, pageNumber)));
    return row?.text;
  };

  test("strips NULs, caps long pages and keeps one copy of a repeated page", async () => {
    const result = await saveManualPages(adminA, {
      manualId,
      pages: [
        { pageNumber: 1, text: "Fault U0\u0000100\u0000" },
        { pageNumber: 2, text: "word ".repeat(MAX_PAGE_TEXT_LENGTH) },
        { pageNumber: 1, text: "Fault U0100 again" },
      ],
    });
    assert.deepEqual(result, { saved: 2 });
    assert.equal(await storedText(1), "Fault U0100 again");
    assert.equal((await storedText(2))?.length, MAX_PAGE_TEXT_LENGTH);
  });

  test("a retried batch replaces the text", async () => {
    await saveManualPages(adminA, { manualId, pages: [{ pageNumber: 1, text: "Fault U0\u0000100" }] });
    assert.equal(await storedText(1), "Fault U0100");
  });

  test("refuses pages outside the manual and malformed batches", async () => {
    for (const pages of [
      [{ pageNumber: 0, text: "x" }],
      [{ pageNumber: 4, text: "x" }],
      [{ pageNumber: 1.5, text: "x" }],
      [{ pageNumber: 1, text: 42 }],
      [null],
      [],
      Array.from({ length: MAX_PAGES_PER_BATCH + 1 }, () => ({ pageNumber: 1, text: "x" })),
      "not a list",
    ]) {
      const result = await saveManualPages(adminA, { manualId, pages: pages as never });
      assert.ok("error" in result, JSON.stringify(pages).slice(0, 60));
    }
    assert.ok("error" in (await saveManualPages(adminB, { manualId, pages: [{ pageNumber: 3, text: "x" }] })));
    assert.equal(await storedText(3), undefined);
  });

  test("finishing needs every page, counts pages without text, and is recorded once", async () => {
    const early = await finishManual(adminA, { manualId });
    assert.ok("error" in early && early.error.includes("2 of 3"), JSON.stringify(early));

    // A scanned page: nothing a search could find.
    await saveManualPages(adminA, { manualId, pages: [{ pageNumber: 3, text: " . " }] });
    assert.deepEqual(await finishManual(adminB, { manualId }), {
      error: "That manual isn't in the library. Add the file again.",
    });
    assert.deepEqual(await finishManual(adminA, { manualId }), {
      added: true,
      pageCount: 3,
      pagesWithoutText: 1,
      nameTaken: null,
    });
    assert.deepEqual(await finishManual(adminA, { manualId }), {
      added: false,
      pageCount: 3,
      pagesWithoutText: 1,
      nameTaken: null,
    });

    const [row] = await systemDb.select().from(manuals).where(eq(manuals.id, manualId));
    assert.equal(row.status, "ready");
    assert.ok(row.readyAt);
    const entries = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, manualId));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "manual.added");
    assert.equal(entries[0].actorUserId, adminA.id);

    // Ready manuals take no more text; a tab still reading it is told it's done.
    assert.deepEqual(await saveManualPages(adminA, { manualId, pages: [{ pageNumber: 1, text: "x" }] }), {
      saved: 0,
      done: true,
    });
    assert.equal(await storedText(1), "Fault U0100");
  });
});

describe("searching the library", () => {
  let fuelManual: string;
  let otherManual: string;

  before(async () => {
    fuelManual = await addManual(adminA, "010 - Sportsman 570 Service Manual.pdf", [
      "Contents. Safety. Maintenance. Fuel system overview.",
      "Fuel pump relay test. If the engine misfires and sets code P0300, check the fuel pump relay. Replace with part 2205123.",
      "Wiring diagram. Relay locations.",
    ]);
    otherManual = await addManual(adminA, "011 - RZR Owner's Manual.pdf", [
      "Carburetor cleaning: remove the carburetor, clean the carburetor bowl.",
      "Store the vehicle with a full fuel tank. Mention carburetor once.",
    ]);
  });

  test("finds the page with the words, best match first, with a snippet", async () => {
    const hits = await searchManuals(adminA.shop.id, "fuel pump relay");
    assert.ok(hits.length > 0);
    assert.equal(hits[0].manualId, fuelManual);
    assert.equal(hits[0].pageNumber, 2);
    assert.equal(hits[0].title, "Sportsman 570 Service Manual");
    assert.equal(hits[0].pageCount, 3);
    const matched = hits[0].snippet.filter((part) => part.match).map((part) => part.text.toLowerCase());
    assert.ok(matched.includes("fuel") && matched.includes("pump") && matched.includes("relay"), JSON.stringify(hits[0].snippet));
    // Every word has to be on the page.
    assert.ok(hits.every((hit) => hit.manualId === fuelManual && hit.pageNumber === 2));
  });

  test("finds fault codes, part numbers and quoted phrases", async () => {
    for (const query of ["P0300", "p0300", "2205123", '"pump relay"']) {
      const hits = await searchManuals(adminA.shop.id, query);
      assert.equal(hits.length, 1, query);
      assert.equal(hits[0].pageNumber, 2, query);
    }
    assert.equal((await searchManuals(adminA.shop.id, '"relay pump"')).length, 0);
  });

  test("a long search cut short never ends in half an emoji", () => {
    // ?q=<199 x>😀 from a hand-made link: cut at 200 UTF-16 units, the
    // emoji's second half would go and links built from it would throw.
    const cut = cleanSearchQuery(`${"x".repeat(199)}\u{1F600}`);
    assert.equal(cut, "x".repeat(199));
    assert.doesNotThrow(() => encodeURIComponent(cut));
    assert.equal(cleanSearchQuery(`${"x".repeat(198)}\u{1F600}`), `${"x".repeat(198)}\u{1F600}`);
  });

  test("a NUL in the search is dropped instead of breaking it", async () => {
    assert.equal(cleanSearchQuery("  P03\u000000 "), "P0300");
    assert.deepEqual(await searchManuals(adminA.shop.id, "\u0000"), []);
    assert.deepEqual(await searchManuals(adminA.shop.id, "a\u0000b"), []);
    const hits = await searchManuals(adminA.shop.id, "P03\u000000");
    assert.equal(hits[0]?.manualId, fuelManual);
    assert.equal(hits[0]?.pageNumber, 2);
  });

  test("uses the page text index under row-level security, with filters too", async () => {
    // Test tables are small enough to read straight through, so this adds a
    // big manual known by two names, each with a big model list entry (in a
    // transaction that's rolled back), and rules out reading whole tables,
    // leaving the index unless row-level security or the filters stop it.
    let plan = "";
    let filteredPlan = "";
    let yearPlan = "";
    let vehiclePlans: string[] = [];
    await systemDb
      .transaction(async (tx) => {
        const [big] = await tx
          .insert(manuals)
          .values({
            shopId: adminA.shop.id,
            title: "Big",
            fileName: "Big.pdf",
            sha256: sha("big"),
            sizeBytes: 1,
            storageKey: "shops/x/manuals/big.pdf",
            status: "ready",
            pageCount: 3000,
          })
          .returning({ id: manuals.id });
        await tx.execute(sql`
          insert into manual_pages (manual_id, shop_id, page_number, text)
          select ${big.id}::uuid, ${adminA.shop.id}::uuid, n, 'Torque the bracket bolts to spec, page ' || n
          from generate_series(1, 3000) n
        `);
        // Known by three names, each in the model list, one with no brand.
        await tx.insert(manualFileNames).values([
          { shopId: adminA.shop.id, manualId: big.id, fileName: "Big.pdf" },
          { shopId: adminA.shop.id, manualId: big.id, fileName: "Big-2.pdf" },
          { shopId: adminA.shop.id, manualId: big.id, fileName: "Big-3.pdf" },
        ]);
        await tx.insert(manualCatalogDocuments).values([
          { shopId: adminA.shop.id, fileName: "Big.pdf", brand: "ATV", importId: randomUUID() },
          { shopId: adminA.shop.id, fileName: "Big-2.pdf", brand: "RGR", importId: randomUUID() },
          { shopId: adminA.shop.id, fileName: "Big-3.pdf", brand: null, importId: randomUUID() },
        ]);
        await tx.execute(sql`
          insert into manual_catalog_models (shop_id, file_key, model_year, model_number, model_description)
          select ${adminA.shop.id}::uuid, 'big.pdf', 2000 + n % 25, 'A' || n, 'SPORTSMAN ' || n || ' ULTIMATE TRAIL'
          from generate_series(1, 5000) n
        `);
        await tx.execute(sql`
          insert into manual_catalog_models (shop_id, file_key, model_year, model_number, model_description)
          select ${adminA.shop.id}::uuid, 'big-2.pdf', 2000 + n % 25, 'R' || n, 'RANGER ' || n || ' CREW'
          from generate_series(1, 5000) n
        `);
        await tx.execute(
          sql`analyze manuals, manual_pages, manual_file_names, manual_catalog_documents, manual_catalog_models`,
        );
        await enterShop(tx, adminA.shop.id);
        await tx.execute(sql`set local enable_seqscan = off`);
        const explain = async (filters: Parameters<typeof searchQuery>[2]) => {
          const result = await tx.execute<{ "QUERY PLAN": string }>(
            sql`explain ${searchQuery("fuel pump", SEARCH_LIMIT, filters)}`,
          );
          return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        };
        plan = await explain({});
        filteredPlan = await explain({ brand: "ATV", year: 2020, model: "sportsman ultimate" });
        // Year alone also reads Model Years text.
        yearPlan = await explain({ year: 2020 });
        vehiclePlans = [
          await explain({ vehicle: "UTV" }),
          await explain({ vehicle: "Other", year: 2020 }),
          await explain({ vehicle: "ATV", model: "ranger crew" }),
          await explain({ brand: "RGR", year: 2021, model: "ranger" }),
          // An entry with no brand takes its manual's other brands.
          await explain({ vehicle: "UTV", year: 2013 }),
        ];
        tx.rollback();
      })
      .catch((error) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    assert.match(plan, /Bitmap Index Scan on manual_pages_search/, plan);
    assert.match(filteredPlan, /Bitmap Index Scan on manual_pages_search/, filteredPlan);
    assert.match(yearPlan, /Bitmap Index Scan on manual_pages_search/, yearPlan);
    assert.equal(vehiclePlans.length, 5);
    for (const vehiclePlan of vehiclePlans) {
      assert.match(vehiclePlan, /Bitmap Index Scan on manual_pages_search/, vehiclePlan);
    }
    // The filters are worked out once, as a list of manuals, never joined
    // in to run again for each matching page.
    for (const once of [filteredPlan, yearPlan, ...vehiclePlans]) {
      assert.match(once, /InitPlan/, once);
      assert.match(once, /manual_id = ANY/, once);
      assert.doesNotMatch(once, /Semi Join/, once);
    }
  });

  test("ranks pages that are more about the words higher", async () => {
    const hits = await searchManuals(adminA.shop.id, "carburetor");
    assert.deepEqual(
      hits.map((hit) => [hit.manualId, hit.pageNumber]),
      [
        [otherManual, 1],
        [otherManual, 2],
      ],
    );
    assert.ok(hits[0].rank > hits[1].rank);
  });

  test("leaves out unfinished manuals, other shops and empty searches", async () => {
    const { storage } = fakeStorage();
    const start = await startManualUpload(
      adminA,
      { fileName: "Unfinished.pdf", sizeBytes: 100, sha256: sha("unfinished") },
      storage,
    );
    assert.ok("manualId" in start);
    await systemDb.update(manuals).set({ status: "extracting", pageCount: 1 }).where(eq(manuals.id, start.manualId));
    await systemDb
      .insert(manualPages)
      .values({ manualId: start.manualId, shopId: adminA.shop.id, pageNumber: 1, text: "zylophonic gasket" });
    assert.equal((await searchManuals(adminA.shop.id, "zylophonic")).length, 0);

    assert.equal((await searchManuals(adminB.shop.id, "fuel pump relay")).length, 0);
    assert.deepEqual(await searchManuals(adminA.shop.id, "   "), []);
    assert.deepEqual(await searchManuals(adminA.shop.id, "the"), []);

    const ready = await listReadyManuals(adminA.shop.id);
    assert.ok(ready.some((manual) => manual.id === fuelManual));
    assert.ok(!ready.some((manual) => manual.id === start.manualId));
    assert.ok((await listManuals(adminA.shop.id)).some((manual) => manual.id === start.manualId));
    assert.ok(!(await listManuals(adminB.shop.id)).some((manual) => manual.id === fuelManual));
  });
});

describe("manual library shop isolation", () => {
  let manualA: string;

  before(async () => {
    manualA = await addManual(adminA, "Private.pdf", ["Shop A's licensed manual text"]);
  });

  test("can't read another shop's manuals or pages", async () => {
    await withShop(adminB.shop.id, async (tx) => {
      const visibleManuals = await tx.select({ shopId: manuals.shopId }).from(manuals);
      assert.ok(visibleManuals.every((m) => m.shopId === adminB.shop.id));
      assert.equal((await tx.select().from(manuals).where(eq(manuals.id, manualA))).length, 0);
      assert.equal((await tx.select().from(manualPages).where(eq(manualPages.manualId, manualA))).length, 0);
      const pages = await tx.select({ shopId: manualPages.shopId }).from(manualPages);
      assert.ok(pages.every((p) => p.shopId === adminB.shop.id));
    });
  });

  test("search only sees its own shop's pages", async () => {
    // ready_manual_pages skips row-level security so search can use its
    // index, and keeps to the current shop itself.
    const manualB = await addManual(adminB, "Shop B.pdf", ["Shop B's licensed manual text"]);
    const visible = async (shopId: string) =>
      (
        await withShop(shopId, (tx) =>
          tx.execute<{ manual_id: string }>(sql`select distinct manual_id from ready_manual_pages`),
        )
      ).rows.map((row) => row.manual_id);
    const seenByB = await visible(adminB.shop.id);
    const seenByA = await visible(adminA.shop.id);
    assert.deepEqual(seenByB, [manualB]);
    assert.ok(seenByA.includes(manualA) && !seenByA.includes(manualB), JSON.stringify(seenByA));

    // With no shop set, it's empty.
    const noShop = await systemDb.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      return tx.execute<{ n: number }>(sql`select count(*)::int as n from ready_manual_pages`);
    });
    assert.equal(noShop.rows[0].n, 0);

    const hitsFor = async (shopId: string) => (await searchManuals(shopId, "licensed")).map((hit) => hit.manualId);
    assert.deepEqual(await hitsFor(adminA.shop.id), [manualA]);
    assert.deepEqual(await hitsFor(adminB.shop.id), [manualB]);
  });

  test("can't add manuals or pages to another shop", async () => {
    const rlsDenied = (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501";
    await assert.rejects(
      withShop(adminB.shop.id, (tx) =>
        tx.insert(manuals).values({
          shopId: adminA.shop.id,
          title: "Sneaky",
          fileName: "Sneaky.pdf",
          sha256: sha("sneaky"),
          sizeBytes: 1,
          storageKey: "shops/x/manuals/y.pdf",
        }),
      ),
      rlsDenied,
    );
    await assert.rejects(
      withShop(adminB.shop.id, (tx) =>
        tx.insert(manualPages).values({ manualId: manualA, shopId: adminA.shop.id, pageNumber: 2, text: "x" }),
      ),
      rlsDenied,
    );
    // Its own shop ID on someone else's manual: the manual/shop key doesn't match.
    await assert.rejects(
      withShop(adminB.shop.id, (tx) =>
        tx.insert(manualPages).values({ manualId: manualA, shopId: adminB.shop.id, pageNumber: 2, text: "x" }),
      ),
      (error: Error & { cause?: { code?: string } }) => error.cause?.code === "23503",
    );
  });

  test("can't change another shop's manuals or pages", async () => {
    const updatedManuals = await withShop(adminB.shop.id, (tx) =>
      tx.update(manuals).set({ status: "uploading" }).where(eq(manuals.id, manualA)).returning(),
    );
    assert.equal(updatedManuals.length, 0);
    const updatedPages = await withShop(adminB.shop.id, (tx) =>
      tx.update(manualPages).set({ text: "defaced" }).where(eq(manualPages.manualId, manualA)).returning(),
    );
    assert.equal(updatedPages.length, 0);
    const [page] = await systemDb.select().from(manualPages).where(eq(manualPages.manualId, manualA));
    assert.equal(page.text, "Shop A's licensed manual text");
  });

  test("app code can't delete manuals or move their files", async () => {
    for (const statement of [
      `delete from "manual_pages"`,
      `delete from "manuals"`,
      `update "manuals" set "storage_key" = 'elsewhere'`,
      `update "manuals" set "sha256" = '${sha("x")}'`,
      `update "manuals" set "shop_id" = '${adminB.shop.id}'`,
      `update "manual_pages" set "shop_id" = '${adminB.shop.id}'`,
    ]) {
      await assert.rejects(
        withShop(adminA.shop.id, (tx) => tx.execute(sql.raw(statement))),
        (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
        statement,
      );
    }
  });
});
