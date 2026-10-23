// One manual, several file names: Polaris lists some PDFs more than once
// ("9860049R01.pdf", "9860049R01-2.pdf", …) and the uploader stores each PDF
// once, linking the other names to it. Linking on upload, the migration's
// backfill, the model list under every name (titles, filters, manualsForModel,
// the admin list and summary), the Vehicle filter's table, and that names stay
// inside their own shop. Needs DATABASE_URL pointing at a disposable Postgres
// database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import { TransactionRollbackError, and, asc, eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, manualFileNames, manuals, shops, users } from "../src/db/schema";
import {
  cleanLibraryFilters,
  getReadyManual,
  libraryFilterOptions,
  listReadyManuals,
  manualsForModel,
  searchManuals,
  type LibraryFilters,
} from "../src/lib/library";
import {
  catalogSummary,
  finishCatalogImport,
  manualBrands,
  manualDisplayTitle,
  manualInList,
  manualInferredBrands,
  manualModelCount,
  manualModelYears,
  manualOtherNames,
  saveCatalogBatch,
} from "../src/lib/manual-catalog";
import {
  KNOWN_BRANDS,
  VEHICLE_NAMES,
  brandInfo,
  brandLabels,
  brandsOf,
  catalogBatches,
  compareBrands,
  listsBrands,
  withoutCopyNumber,
  type CatalogFile,
  type CatalogModel,
} from "../src/lib/manual-catalog-rules";
import {
  confirmManualUpload,
  finishManual,
  listManuals,
  saveManualPages,
  startManualUpload,
  storageKeyFor,
  type StartResult,
} from "../src/lib/manuals";
import type { CurrentUser } from "../src/lib/session";
import type { FileStorage } from "../src/lib/storage";

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
let adminA: CurrentUser;
let adminB: CurrentUser;
// For the inferred-brand case, apart from the others' model lists.
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

// Stands in for R2: remembers which objects exist and how big they are, and
// how many upload URLs it handed out.
function fakeStorage() {
  const objects = new Map<string, number>();
  let uploads = 0;
  const storage: FileStorage = {
    async uploadUrl(key) {
      uploads += 1;
      return `https://storage.test/${key}?signature=put`;
    },
    async downloadUrl(key) {
      return `https://storage.test/${key}?signature=get`;
    },
    async size(key) {
      return objects.get(key) ?? null;
    },
  };
  return { objects, storage, uploads: () => uploads };
}

const randomSha = () => createHash("sha256").update(randomUUID()).digest("hex");

// Adds a ready manual through the uploader's steps, and says what finishing
// it returned.
async function addManualFinished(actor: CurrentUser, fileName: string, pages: string[], sha256 = randomSha()) {
  const { objects, storage } = fakeStorage();
  const sizeBytes = 1000 + pages.join("").length;
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
  return { manualId: start.manualId, finished };
}

// Adds a ready manual through the uploader's steps.
async function addManual(actor: CurrentUser, fileName: string, pages: string[], sha256 = randomSha()) {
  return (await addManualFinished(actor, fileName, pages, sha256)).manualId;
}

// An upload that stopped part way (pages that couldn't be read, or the tab
// closed) and was never tried again: its row holds its name, unfinished.
async function addStalled(actor: CurrentUser, fileName: string) {
  const { objects, storage } = fakeStorage();
  const start = await startManualUpload(actor, { fileName, sizeBytes: 700, sha256: randomSha() }, storage);
  assert.ok("next" in start && start.next === "upload", JSON.stringify(start));
  objects.set(storageKeyFor(actor.shop.id, start.manualId), 700);
  assert.deepEqual(await confirmManualUpload(actor, { manualId: start.manualId, pageCount: 3 }, storage), {
    next: "extract",
  });
  await saveManualPages(actor, { manualId: start.manualId, pages: [{ pageNumber: 1, text: "Truncated." }] });
  // Finishing it later, after all (its tab came back).
  const finish = async () => {
    await saveManualPages(actor, {
      manualId: start.manualId,
      pages: [2, 3].map((pageNumber) => ({ pageNumber, text: "The rest." })),
    });
    return finishManual(actor, { manualId: start.manualId });
  };
  return { manualId: start.manualId, finish };
}

// Starts a byte-identical copy of a manual under another name, as choosing
// the file again would.
async function startCopy(actor: CurrentUser, manualId: string, fileName: string, storage = fakeStorage().storage) {
  const [row] = await systemDb.select().from(manuals).where(eq(manuals.id, manualId));
  return startManualUpload(actor, { fileName, sizeBytes: row.sizeBytes, sha256: row.sha256 }, storage);
}

// The names a manual is known by, A to Z.
async function namesOf(manualId: string) {
  const rows = await systemDb
    .select({ fileName: manualFileNames.fileName })
    .from(manualFileNames)
    .where(eq(manualFileNames.manualId, manualId))
    .orderBy(asc(manualFileNames.fileKey));
  return rows.map((row) => row.fileName);
}

async function ownerOf(shopId: string, fileName: string) {
  const [row] = await systemDb
    .select({ manualId: manualFileNames.manualId })
    .from(manualFileNames)
    .where(and(eq(manualFileNames.shopId, shopId), eq(manualFileNames.fileKey, fileName.toLowerCase())));
  return row?.manualId ?? null;
}

const skipped = (result: StartResult) => {
  assert.ok("next" in result && result.next === "skip", JSON.stringify(result));
  return result as Extract<StartResult, { next: "skip" }>;
};

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

async function importEntries(actor: CurrentUser, files: CatalogFile[]) {
  const importId = randomUUID();
  for (const batch of catalogBatches(files)) {
    const saved = await saveCatalogBatch(actor, { importId, files: batch });
    assert.ok("saved" in saved, JSON.stringify(saved));
  }
  const result = await finishCatalogImport(actor, {
    importId,
    fileName: "manual-list - All.csv",
    leftOut: 0,
    rowsWithoutFile: 0,
  });
  assert.ok("manuals" in result, JSON.stringify(result));
}

before(async () => {
  adminA = await createShopWithAdmin(`na${suffix}`);
  adminB = await createShopWithAdmin(`nb${suffix}`);
  adminC = await createShopWithAdmin(`nc${suffix}`);
});

after(async () => {
  for (const admin of [adminA, adminB, adminC]) await systemDb.delete(shops).where(eq(shops.id, admin.shop.id));
  await systemDb.$client.end();
});

describe("the vehicle table", () => {
  test("Polaris's codes have labels and vehicles; other codes show as they are, under Other", () => {
    assert.deepEqual(
      Object.fromEntries(KNOWN_BRANDS.map((code) => [code, brandInfo(code)])),
      {
        ATV: { label: "ATV", vehicle: "ATV" },
        RGR: { label: "Ranger", vehicle: "UTV" },
        RZR: { label: "RZR", vehicle: "UTV" },
        GRL: { label: "General", vehicle: "UTV" },
        XXP: { label: "Xpedition", vehicle: "UTV" },
        GEN: { label: "Generators", vehicle: "Generator" },
      },
    );
    assert.deepEqual(brandInfo("SNO"), { label: "SNO", vehicle: "Other" });
    // Codes match as listed, and nothing on Object's prototype is a code.
    assert.deepEqual(brandInfo("rgr"), { label: "rgr", vehicle: "Other" });
    assert.deepEqual(brandInfo("constructor"), { label: "constructor", vehicle: "Other" });
    assert.deepEqual(VEHICLE_NAMES, {
      UTV: "UTVs (side-by-sides)",
      ATV: "ATVs",
      Generator: "Generators",
      Other: "Other",
    });
  });

  test("vehicles list their lines in order, and brands sort by vehicle", () => {
    assert.deepEqual(brandsOf("UTV"), ["RGR", "RZR", "GRL", "XXP"]);
    assert.deepEqual(brandsOf("ATV"), ["ATV"]);
    assert.deepEqual(brandsOf("Generator"), ["GEN"]);
    assert.deepEqual(
      (["UTV", "ATV", "Generator", "Other"] as const).map(listsBrands),
      [true, false, false, true],
    );
    assert.deepEqual(
      ["SNO", "ATV", "GEN", "XXP", "RGR", "AAA", "GRL", "RZR"].sort(compareBrands),
      ["RGR", "RZR", "GRL", "XXP", "ATV", "GEN", "AAA", "SNO"],
    );
    assert.equal(brandLabels(["XXP", "GEN", "RGR", "SNO"]), "Ranger, Xpedition, Generators, SNO");
    assert.equal(brandLabels([]), "");
  });

  test("the address takes ?vehicle= and ?brand=, old brand links included", () => {
    assert.deepEqual(cleanLibraryFilters({ vehicle: "UTV" }), { vehicle: "UTV" });
    assert.deepEqual(cleanLibraryFilters({ vehicle: " generator " }), { vehicle: "Generator" });
    assert.deepEqual(cleanLibraryFilters({ vehicle: "Other", year: "2020" }), { vehicle: "Other", year: 2020 });
    assert.deepEqual(cleanLibraryFilters({ brand: "ATV" }), { brand: "ATV" });
    assert.deepEqual(cleanLibraryFilters({ brand: "RGR", vehicle: "ATV" }), { brand: "RGR" });
    // What the Vehicle select sends without JavaScript for a line.
    assert.deepEqual(cleanLibraryFilters({ vehicle: "RGR" }), { brand: "RGR" });
    assert.deepEqual(cleanLibraryFilters({ vehicle: ["UTV", "ATV"] }), {});
    assert.deepEqual(cleanLibraryFilters({ vehicle: "V".repeat(41) }), {});
  });
});

describe("linking a copy's name to its manual", () => {
  test("a copy under another name links the name, once, and uploads nothing", async () => {
    const id = await addManual(adminB, "9860049R01.pdf", ["Winch solenoid check."]);
    const { storage, uploads } = fakeStorage();
    const linked = skipped(await startCopy(adminB, id, "9860049R01-2.pdf", storage));
    assert.deepEqual(linked, {
      next: "skip",
      manualId: id,
      title: "9860049R01",
      message: "Same file as 9860049R01.pdf, already in the library. Linked this name to it.",
    });
    // Choosing it again, whatever the case: nothing changes.
    for (const name of ["9860049R01-2.pdf", "9860049r01-2.PDF"]) {
      const again = skipped(await startCopy(adminB, id, name, storage));
      assert.equal(again.message, "Same file as 9860049R01.pdf, already in the library. This name is linked to it.");
    }
    const own = skipped(await startCopy(adminB, id, "9860049R01.pdf", storage));
    assert.equal(own.message, "Already in the library as 9860049R01");
    assert.equal(uploads(), 0);
    assert.deepEqual(await namesOf(id), ["9860049R01-2.pdf", "9860049R01.pdf"]);
    const audit = await systemDb
      .select({ details: auditLog.details, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, id), eq(auditLog.action, "manual.name_linked")));
    assert.deepEqual(audit, [
      { details: { fileName: "9860049R01-2.pdf", manualFileName: "9860049R01.pdf" }, actor: adminB.id },
    ]);
  });

  test("a new manual's own name is recorded with it", async () => {
    const { storage } = fakeStorage();
    const start = await startManualUpload(
      adminB,
      { fileName: "  New Manual.pdf ", sizeBytes: 500, sha256: randomSha() },
      storage,
    );
    assert.ok("next" in start && start.next === "upload");
    assert.deepEqual(await namesOf(start.manualId), ["New Manual.pdf"]);
  });

  test("a name another manual already has is never taken", async () => {
    const first = await addManual(adminB, "Shared name.pdf", ["First file."]);
    const second = await addManual(adminB, "Second.pdf", ["Second file."]);
    // The second file, renamed to the first one's name.
    const copy = skipped(await startCopy(adminB, second, "SHARED NAME.pdf"));
    assert.equal(
      copy.message,
      "Same file as Second.pdf, already in the library. A different manual is already called SHARED NAME.pdf, so this name stays with that one.",
    );
    assert.equal(await ownerOf(adminB.shop.id, "Shared name.pdf"), first);
    assert.deepEqual(await namesOf(second), ["Second.pdf"]);

    // A different file under a name that's taken is added as its own manual,
    // and told the name stays with the other one.
    const third = await addManual(adminB, "shared name.PDF", ["Third file, a newer download."]);
    assert.equal(await ownerOf(adminB.shop.id, "Shared name.pdf"), first);
    assert.deepEqual(await namesOf(third), []);
    const again = await finishManual(adminB, { manualId: third });
    assert.ok("nameTaken" in again && again.nameTaken === "shared name.PDF" && !again.added, JSON.stringify(again));
    const own = await finishManual(adminB, { manualId: first });
    assert.ok("nameTaken" in own && own.nameTaken === null, JSON.stringify(own));
  });

  test("a ready manual takes its name from one that never finished, never from a ready one", async () => {
    const { objects, storage } = fakeStorage();
    // An upload that stopped after its row was made and was never tried again.
    const stalledInput = { fileName: "Revised.pdf", sizeBytes: 700, sha256: randomSha() };
    const stalled = await startManualUpload(adminB, stalledInput, storage);
    assert.ok("next" in stalled && stalled.next === "upload");
    // A newer download of it: different bytes, the same name (whatever the
    // case). Until it's ready the name stays where it is.
    const newer = await startManualUpload(adminB, { fileName: "revised.PDF", sizeBytes: 900, sha256: randomSha() }, storage);
    assert.ok("next" in newer && newer.next === "upload" && newer.manualId !== stalled.manualId);
    assert.equal(await ownerOf(adminB.shop.id, "Revised.pdf"), stalled.manualId);
    objects.set(storageKeyFor(adminB.shop.id, newer.manualId), 900);
    assert.deepEqual(await confirmManualUpload(adminB, { manualId: newer.manualId, pageCount: 1 }, storage), {
      next: "extract",
    });
    await saveManualPages(adminB, { manualId: newer.manualId, pages: [{ pageNumber: 1, text: "Revised text." }] });
    const finished = await finishManual(adminB, { manualId: newer.manualId });
    assert.deepEqual(finished, { added: true, pageCount: 1, pagesWithoutText: 0, nameTaken: null });
    assert.equal(await ownerOf(adminB.shop.id, "Revised.pdf"), newer.manualId);
    assert.deepEqual(await namesOf(stalled.manualId), []);

    // The stalled one finishing after all (its tab came back) doesn't take
    // the name back from a ready manual.
    objects.set(storageKeyFor(adminB.shop.id, stalled.manualId), stalledInput.sizeBytes);
    await confirmManualUpload(adminB, { manualId: stalled.manualId, pageCount: 1 }, storage);
    await saveManualPages(adminB, { manualId: stalled.manualId, pages: [{ pageNumber: 1, text: "Old text." }] });
    const late = await finishManual(adminB, { manualId: stalled.manualId });
    assert.ok("nameTaken" in late && late.added && late.nameTaken === "Revised.pdf", JSON.stringify(late));
    assert.equal(await ownerOf(adminB.shop.id, "Revised.pdf"), newer.manualId);

    // A copy of a ready manual takes a name the same way.
    const kept = await addManual(adminB, "Kept.pdf", ["Kept file."]);
    const held = await startManualUpload(adminB, { fileName: "Kept-2.pdf", sizeBytes: 600, sha256: randomSha() }, storage);
    assert.ok("next" in held && held.next === "upload");
    const linked = skipped(await startCopy(adminB, kept, "Kept-2.pdf"));
    assert.equal(linked.message, "Same file as Kept.pdf, already in the library. Linked this name to it.");
    assert.equal(await ownerOf(adminB.shop.id, "Kept-2.pdf"), kept);
    const audit = await systemDb
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, kept), eq(auditLog.action, "manual.name_linked")));
    assert.deepEqual(audit, [
      { details: { fileName: "Kept-2.pdf", manualFileName: "Kept.pdf", takenFromManualId: held.manualId } },
    ]);
  });

  test("an unfinished copy links its name and carries on with the same row", async () => {
    const { objects, storage } = fakeStorage();
    const input = { fileName: "Part.pdf", sizeBytes: 800, sha256: randomSha() };
    const first = await startManualUpload(adminB, input, storage);
    assert.ok("next" in first && first.next === "upload");
    const copy = await startManualUpload(adminB, { ...input, fileName: "Part-2.pdf" }, storage);
    assert.deepEqual(copy, { next: "upload", manualId: first.manualId, uploadUrl: first.uploadUrl });
    objects.set(storageKeyFor(adminB.shop.id, first.manualId), input.sizeBytes);
    assert.deepEqual(await startManualUpload(adminB, { ...input, fileName: "Part-3.pdf" }, storage), {
      next: "confirm",
      manualId: first.manualId,
    });
    assert.deepEqual(await namesOf(first.manualId), ["Part-2.pdf", "Part-3.pdf", "Part.pdf"]);
  });

  test("three tabs starting the same new file under three names share one row and every name", async () => {
    const { storage } = fakeStorage();
    const sha256 = randomSha();
    const names = ["Race.pdf", "Race-2.pdf", "Race-3.pdf"];
    const results = await Promise.all(
      names.map((fileName) => startManualUpload(adminB, { fileName, sizeBytes: 900, sha256 }, storage)),
    );
    const ids = new Set(results.map((result) => ("manualId" in result ? result.manualId : result.error)));
    assert.equal(ids.size, 1, JSON.stringify(results));
    const [id] = ids;
    assert.deepEqual(await namesOf(id), ["Race-2.pdf", "Race-3.pdf", "Race.pdf"]);
  });
});

describe("the migration's backfill", () => {
  test("every manual added before it gets its own name; a ready one, then the older, keeps a shared one", async () => {
    // The INSERT from the migration, run as written against stand-ins for
    // manuals and manual_file_names: temporary tables come first on the
    // search path, so it reads and writes only them.
    const migration = readFileSync(new URL("../drizzle/0014_manual_file_names_grants.sql", import.meta.url), "utf8");
    const [backfill] = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.replace(/^--.*$/gm, "").trim())
      .filter((statement) => statement.startsWith("INSERT INTO"));
    assert.ok(backfill, "the migration has a backfill");

    const shopId = adminA.shop.id;
    const manual = (fileName: string, createdAt: string, status = "ready") => ({
      id: randomUUID(),
      shopId,
      title: fileName,
      fileName,
      sha256: randomSha(),
      sizeBytes: 1,
      storageKey: `shops/${shopId}/manuals/x.pdf`,
      status,
      createdAt: new Date(createdAt),
    });
    const older = manual("9924882_2014_RZR800.pdf", "2026-10-01T00:00:00Z");
    const newer = manual("9924882_2014_rzr800.PDF", "2026-10-02T00:00:00Z");
    const other = manual("9942508.pdf", "2026-10-03T00:00:00Z");
    // An upload that never finished, then a ready manual under its name.
    const stalled = manual("Revised.pdf", "2026-09-30T00:00:00Z", "uploading");
    const finished = manual("revised.pdf", "2026-10-04T00:00:00Z");
    let names: { manualId: string; fileName: string; fileKey: string }[] = [];
    let again = 0;
    await systemDb
      .transaction(async (tx) => {
        await tx.execute(sql`create temp table manuals (like public.manuals including all) on commit drop`);
        await tx.execute(
          sql`create temp table manual_file_names (like public.manual_file_names including all) on commit drop`,
        );
        await tx.execute(sql`
          insert into pg_temp.manuals (id, shop_id, title, file_name, sha256, size_bytes, storage_key, status, page_count, created_at)
          values ${sql.join(
            [newer, older, other, stalled, finished].map(
              (m) =>
                sql`(${m.id}, ${m.shopId}, ${m.title}, ${m.fileName}, ${m.sha256}, ${m.sizeBytes}, ${m.storageKey}, ${m.status}, 1, ${m.createdAt})`,
            ),
            sql`, `,
          )}
        `);
        await tx.execute(sql.raw(backfill));
        const read = async () =>
          (
            await tx.execute<{ manual_id: string; file_name: string; file_key: string }>(
              sql`select manual_id, file_name, file_key from pg_temp.manual_file_names order by file_key`,
            )
          ).rows.map((row) => ({ manualId: row.manual_id, fileName: row.file_name, fileKey: row.file_key }));
        names = await read();
        // Running it again (a retried deploy) changes nothing.
        await tx.execute(sql.raw(backfill));
        again = (await read()).length;
        tx.rollback();
      })
      .catch((error) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    assert.deepEqual(names, [
      { manualId: older.id, fileName: older.fileName, fileKey: "9924882_2014_rzr800.pdf" },
      { manualId: other.id, fileName: other.fileName, fileKey: "9942508.pdf" },
      { manualId: finished.id, fileName: finished.fileName, fileKey: "revised.pdf" },
    ]);
    assert.equal(again, 3);
    // The real tables were never touched.
    assert.equal((await systemDb.select().from(manuals).where(eq(manuals.id, older.id))).length, 0);
  });
});

describe("the model list under every name", () => {
  const ids: Record<string, string> = {};
  const WINCH = "Winch Diagnostic & Troubleshooting Guide";

  before(async () => {
    ids.winch = await addManual(adminA, "9860049R01.pdf", ["Spoolgrind winch solenoid test.", "Contactor."]);
    for (const n of [2, 3, 4, 5]) skipped(await startCopy(adminA, ids.winch, `9860049R01-${n}.pdf`));
    ids.rzr800 = await addManual(adminA, "9924882_2014_RGRRZR800.pdf", ["Spoolgrind clutch."]);
    skipped(await startCopy(adminA, ids.rzr800, "9924882_2014_RZR800.pdf"));
    // Its own name isn't in the list, two of its other names are.
    ids.aliased = await addManual(adminA, "Own name.pdf", ["Spoolgrind both."]);
    skipped(await startCopy(adminA, ids.aliased, "z-listed.pdf"));
    skipped(await startCopy(adminA, ids.aliased, "b-listed.pdf"));
    ids.gen = await addManual(adminA, "gen-1.pdf", ["Spoolgrind generator."]);
    ids.snow = await addManual(adminA, "snow.pdf", ["Spoolgrind track."]);
    ids.notes = await addManual(adminA, "Notes.pdf", ["Spoolgrind notes."]);
    const winchEntry = (fileName: string, brand: string, models: CatalogModel[], modelYears: string) =>
      entry(fileName, models, { brand, title: WINCH, article: "9860049R01", modelYears });
    await importEntries(adminA, [
      winchEntry("9860049R01.pdf", "RZR", [[2011, "Z11WIN0001", "RZR TRAIL WINCH"], [2022, "Z22WIN0002", "RZR PRO WINCH"]], "2011-2026"),
      // The same model as under RZR, which counts once.
      winchEntry("9860049R01-2.pdf", "RGR", [[2011, "Z11WIN0001", "RZR TRAIL WINCH"], [2019, "R19WIN0003", "RANGER XP WINCH"]], "2011-2026"),
      winchEntry("9860049R01-3.pdf", "XXP", [[2024, "X24WIN0004", "XPEDITION ADV WINCH"]], "2024-2026"),
      winchEntry("9860049R01-4.pdf", "GRL", [[2020, "G20WIN0005", "GENERAL 4 WINCH"]], "2020-2026"),
      winchEntry("9860049R01-5.pdf", "ATV", [[2015, "A15WIN0006", "SPORTSMAN WINCH"]], "2011-2026"),
      entry("9924882_2014_RGRRZR800.pdf", [[2013, "R13EIGHT01", "RZR S EIGHT HUNDRED"]], {
        title: "RZR 800 (2013)",
        modelYears: "2013",
      }),
      entry("9924882_2014_RZR800.pdf", [[2014, "Z14EIGHT01", "RZR S EIGHT HUNDRED"]], {
        brand: "RZR",
        title: "RZR 800 (2014)",
        modelYears: "2014",
      }),
      entry("z-listed.pdf", [[2018, "A18ZED0001", "SPORTSMAN ZED"]], { brand: "ATV", title: "Zed title", modelYears: "2018" }),
      entry("b-listed.pdf", [[2018, "P18BEE0001", "GENERATOR BEE"]], { brand: "GEN", title: "Bee title", modelYears: "2018" }),
      entry("gen-1.pdf", [[2020, "P20GENTEST", "GENERATOR TEST"]], { brand: "GEN", title: "Test Generator" }),
      entry("snow.pdf", [[2020, "S20SNOW001", "INDY"]], { brand: "SNO", title: "Indy Snowmobile" }),
      entry("9999999.pdf", [], { brand: "ATV", title: "Not downloaded yet" }),
    ]);
  });

  const listIds = async (filters: LibraryFilters) =>
    (await listReadyManuals(adminA.shop.id, filters)).map((manual) => manual.id).sort();
  const searchIds = async (filters: LibraryFilters) =>
    (await searchManuals(adminA.shop.id, "spoolgrind", filters)).map((hit) => hit.manualId).sort();
  const sorted = (...names: string[]) => names.map((name) => ids[name]).sort();

  test("a manual is named by its own name's entry, else its first listed name, else its file", async () => {
    const ready = Object.fromEntries((await listReadyManuals(adminA.shop.id)).map((manual) => [manual.id, manual]));
    const shown = (name: string) => {
      const { title, brands, modelYears } = ready[ids[name]];
      return { title, brands, modelYears };
    };
    assert.deepEqual(shown("winch"), { title: WINCH, brands: ["RGR", "RZR", "GRL", "XXP", "ATV"], modelYears: "2011-2026" });
    // Its entries say 2013 and 2014.
    assert.deepEqual(shown("rzr800"), { title: "RZR 800 (2013)", brands: ["RZR"], modelYears: "2013-2014" });
    assert.deepEqual(shown("aliased"), { title: "Bee title", brands: ["ATV", "GEN"], modelYears: "2018" });
    assert.deepEqual(shown("notes"), { title: "Notes", brands: [], modelYears: null });
    assert.equal(brandLabels(ready[ids.winch].brands), "Ranger, RZR, General, Xpedition, ATV");

    const hits = Object.fromEntries((await searchManuals(adminA.shop.id, "spoolgrind")).map((hit) => [hit.manualId, hit]));
    assert.deepEqual(
      [hits[ids.winch].title, hits[ids.winch].brands, hits[ids.winch].modelYears],
      [WINCH, ["RGR", "RZR", "GRL", "XXP", "ATV"], "2011-2026"],
    );
    assert.equal(hits[ids.aliased].title, "Bee title");
    const viewer = await getReadyManual(adminA.shop.id, ids.winch);
    assert.deepEqual([viewer?.title, viewer?.brands.length], [WINCH, 5]);
  });

  test("a vehicle or brand matches when any of a manual's entries has it", async () => {
    assert.deepEqual(await listIds({ vehicle: "UTV" }), sorted("winch", "rzr800"));
    assert.deepEqual(await listIds({ brand: "XXP" }), sorted("winch"));
    assert.deepEqual(await listIds({ brand: "GRL" }), sorted("winch"));
    assert.deepEqual(await listIds({ brand: "RGR" }), sorted("winch"));
    assert.deepEqual(await listIds({ brand: "RZR" }), sorted("winch", "rzr800"));
    // ATVs never show a generator, Generators never an ATV-only manual.
    assert.deepEqual(await listIds({ vehicle: "ATV" }), sorted("winch", "aliased"));
    assert.deepEqual(await listIds({ vehicle: "Generator" }), sorted("gen", "aliased"));
    assert.deepEqual(await listIds({ vehicle: "Other" }), sorted("snow"));
    assert.deepEqual(await listIds({ brand: "SNO" }), sorted("snow"));
    // Search narrows the same way.
    assert.deepEqual(await searchIds({}), sorted("winch", "rzr800", "aliased", "gen", "snow", "notes"));
    assert.deepEqual(await searchIds({ vehicle: "UTV" }), sorted("winch", "rzr800"));
    assert.deepEqual(await searchIds({ brand: "XXP" }), sorted("winch"));
    assert.deepEqual(await searchIds({ vehicle: "ATV" }), sorted("winch", "aliased"));
  });

  test("year and model match any entry's models, together on one model and with the vehicle", async () => {
    assert.deepEqual(await listIds({ year: 2024 }), sorted("winch"));
    assert.deepEqual(await listIds({ model: "xpedition" }), sorted("winch"));
    assert.deepEqual(await listIds({ year: 2024, model: "xpedition" }), sorted("winch"));
    assert.deepEqual(await listIds({ year: 2014 }), sorted("rzr800"));
    assert.deepEqual(await listIds({ model: "Z14EIGHT" }), sorted("rzr800"));
    assert.deepEqual(await listIds({ year: 2018 }), sorted("aliased"));
    // Two of its models, but not one model: no match.
    assert.deepEqual(await listIds({ year: 2015, model: "xpedition" }), []);
    // One entry has to match every filter: its 2015 models are ATVs.
    assert.deepEqual(await listIds({ vehicle: "ATV", year: 2015 }), sorted("winch"));
    assert.deepEqual(await listIds({ vehicle: "UTV", year: 2015 }), []);
    // An entry with no brand has the brands of its manual's other entries:
    // the RZR 800's 2013 models are listed under a name with none.
    assert.deepEqual(await listIds({ brand: "RZR", year: 2013 }), sorted("rzr800"));
    assert.deepEqual(await listIds({ vehicle: "UTV", year: 2013 }), sorted("rzr800"));
    assert.deepEqual(await listIds({ brand: "RZR", model: "R13EIGHT" }), sorted("rzr800"));
    assert.deepEqual(await searchIds({ vehicle: "UTV", year: 2013, model: "rzr s eight" }), sorted("rzr800"));
    // Never brands its manual doesn't have.
    assert.deepEqual(await listIds({ vehicle: "ATV", year: 2013 }), []);
    assert.deepEqual(await listIds({ brand: "RGR", model: "R13EIGHT" }), []);
    assert.deepEqual(await listIds({ brand: "XXP", model: "xpedition adv" }), sorted("winch"));
    assert.deepEqual(await searchIds({ vehicle: "UTV", year: 2022, model: "rzr pro" }), sorted("winch"));
  });

  test("manualsForModel finds a manual by any of its entries' models", async () => {
    const found = async (number: string) => (await manualsForModel(adminA.shop.id, number)).map((m) => m.id);
    assert.deepEqual(await found("X24WIN0004"), [ids.winch]);
    assert.deepEqual(await found("a15win0006"), [ids.winch]);
    // Listed under two of its names, found once.
    assert.deepEqual(await found("Z11WIN0001"), [ids.winch]);
    assert.deepEqual(await found("Z14EIGHT01"), [ids.rzr800]);
    assert.deepEqual(await found("P18BEE0001"), [ids.aliased]);
    assert.deepEqual((await manualsForModel(adminA.shop.id, "X24WIN0004"))[0].title, WINCH);
    assert.deepEqual(await manualsForModel(adminB.shop.id, "X24WIN0004"), []);
  });

  test("the admin list shows every brand, each model once, and the other names", async () => {
    const list = Object.fromEntries((await listManuals(adminA.shop.id)).map((manual) => [manual.id, manual]));
    const winch = list[ids.winch];
    assert.deepEqual(
      {
        title: winch.title,
        inList: winch.inList,
        brands: [...winch.brands].sort(compareBrands),
        inferred: winch.inferredBrands,
        models: winch.models,
        otherNames: winch.otherNames,
      },
      {
        title: WINCH,
        inList: true,
        brands: ["RGR", "RZR", "GRL", "XXP", "ATV"],
        inferred: [],
        models: 6,
        otherNames: ["9860049R01-2.pdf", "9860049R01-3.pdf", "9860049R01-4.pdf", "9860049R01-5.pdf"],
      },
    );
    assert.deepEqual([list[ids.aliased].inList, list[ids.aliased].models], [true, 2]);
    assert.deepEqual([list[ids.notes].inList, list[ids.notes].brands, list[ids.notes].otherNames], [false, [], []]);
  });

  test("the details read the same in a query of manuals alone", async () => {
    // listManuals joins users; a query with one table makes Drizzle write
    // its columns without the table name, which the pieces must survive.
    const [alone] = await withShop(adminA.shop.id, (tx) =>
      tx
        .select({
          title: manualDisplayTitle,
          modelYears: manualModelYears,
          inList: manualInList,
          brands: manualBrands,
          inferred: manualInferredBrands,
          models: manualModelCount,
          otherNames: manualOtherNames,
        })
        .from(manuals)
        .where(eq(manuals.id, ids.winch)),
    );
    assert.deepEqual(
      { ...alone, brands: [...alone.brands].sort(compareBrands) },
      {
        title: WINCH,
        modelYears: "2011-2026",
        inList: true,
        brands: ["RGR", "RZR", "GRL", "XXP", "ATV"],
        inferred: [],
        models: 6,
        otherNames: ["9860049R01-2.pdf", "9860049R01-3.pdf", "9860049R01-4.pdf", "9860049R01-5.pdf"],
      },
    );
  });

  test("the summary goes by every name", async () => {
    const summary = await catalogSummary(adminA.shop.id);
    assert.equal(summary.manuals, 6);
    assert.equal(summary.entries, 12);
    assert.deepEqual(
      summary.notListed.map((manual) => manual.id),
      [ids.notes],
    );
    assert.deepEqual(summary.missingPdfs, [{ fileName: "9999999.pdf", title: "Not downloaded yet" }]);
  });

  test("filter options count each manual once per vehicle and per brand", async () => {
    const options = await libraryFilterOptions(adminA.shop.id);
    assert.equal(options.manuals, 6);
    assert.deepEqual(options.vehicles, [
      { vehicle: "UTV", manuals: 2 },
      { vehicle: "ATV", manuals: 2 },
      { vehicle: "Generator", manuals: 2 },
      { vehicle: "Other", manuals: 1 },
    ]);
    assert.deepEqual(options.brands, [
      { brand: "RGR", manuals: 1 },
      { brand: "RZR", manuals: 2 },
      { brand: "GRL", manuals: 1 },
      { brand: "XXP", manuals: 1 },
      { brand: "ATV", manuals: 2 },
      { brand: "GEN", manuals: 2 },
      { brand: "SNO", manuals: 1 },
    ]);
    assert.deepEqual(options.years, [2024, 2022, 2020, 2019, 2018, 2015, 2014, 2013, 2011]);
  });
});

describe("filled-in brands under several names", () => {
  const listIds = async (actor: CurrentUser, filters: LibraryFilters) =>
    (await listReadyManuals(actor.shop.id, filters)).map((manual) => manual.id);

  test("a brand shows as filled in only when no entry of the manual gives it", async () => {
    const id = await addManual(adminC, "web-diesel.pdf", ["Diesel web manual."]);
    await importEntries(adminC, [
      entry("rgr-a.pdf", [[2019, "R19DIESEL1", "RANGER DIESEL CREW"]], { brand: "RGR" }),
      entry("rgr-b.pdf", [[2020, "R20DIESEL1", "RANGER DIESEL"]], { brand: "RGR" }),
      entry("web-diesel.pdf", [[2021, "X21WEB0001", "DIESEL"]], { title: "Diesel Web Manual", modelYears: "2019-2022" }),
    ]);
    const shown = async () => {
      const manual = (await listManuals(adminC.shop.id)).find((m) => m.id === id)!;
      return { brands: manual.brands, inferred: manual.inferredBrands };
    };
    assert.deepEqual(await shown(), { brands: ["RGR"], inferred: ["RGR"] });
    assert.deepEqual(await listIds(adminC, { brand: "RGR" }), [id]);
    // Another name for it whose entry gives the brand outright.
    skipped(await startCopy(adminC, id, "web-diesel-2.pdf"));
    await importEntries(adminC, [entry("web-diesel-2.pdf", [], { brand: "RGR", title: "Diesel Web Manual 2" })]);
    assert.deepEqual(await shown(), { brands: ["RGR"], inferred: [] });
  });
});

describe("file names shop isolation", () => {
  const rlsDenied = (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501";
  let manualA: string;

  before(async () => {
    manualA = await addManual(adminA, "Isolated.pdf", ["Shop A's licensed manual text"]);
  });

  test("can't read another shop's names", async () => {
    await withShop(adminB.shop.id, async (tx) => {
      const names = await tx.select({ shopId: manualFileNames.shopId }).from(manualFileNames);
      assert.ok(names.length > 0 && names.every((name) => name.shopId === adminB.shop.id));
      const asked = await tx.select().from(manualFileNames).where(eq(manualFileNames.manualId, manualA));
      assert.equal(asked.length, 0);
    });
    const noShop = await systemDb.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      return tx.select().from(manualFileNames);
    });
    assert.equal(noShop.length, 0);
  });

  test("can't add a name to another shop, or link one to another shop's manual", async () => {
    await assert.rejects(
      withShop(adminB.shop.id, (tx) =>
        tx.insert(manualFileNames).values({ shopId: adminA.shop.id, manualId: manualA, fileName: "Sneaky.pdf" }),
      ),
      rlsDenied,
    );
    // Its own shop ID on shop A's manual: the manual/shop key doesn't match.
    await assert.rejects(
      withShop(adminB.shop.id, (tx) =>
        tx.insert(manualFileNames).values({ shopId: adminB.shop.id, manualId: manualA, fileName: "Sneaky.pdf" }),
      ),
      (error: Error & { cause?: { code?: string } }) => error.cause?.code === "23503",
    );
    assert.deepEqual(await namesOf(manualA), ["Isolated.pdf"]);
  });

  test("the same file in another shop is that shop's own manual, under its own names", async () => {
    const copy = await startCopy(adminB, manualA, "Isolated-2.pdf");
    assert.ok("next" in copy && copy.next === "upload", JSON.stringify(copy));
    assert.notEqual(copy.manualId, manualA);
    assert.deepEqual(await namesOf(manualA), ["Isolated.pdf"]);
    assert.deepEqual(await namesOf(copy.manualId), ["Isolated-2.pdf"]);
    // And shop B can have a name shop A has.
    const same = await startCopy(adminB, copy.manualId, "Isolated.pdf");
    assert.ok("next" in same && same.next === "upload");
    assert.equal(await ownerOf(adminB.shop.id, "Isolated.pdf"), copy.manualId);
    assert.equal(await ownerOf(adminA.shop.id, "Isolated.pdf"), manualA);
  });

  test("app code can't remove a name, rename one or move one to another shop", async () => {
    for (const statement of [
      `delete from "manual_file_names"`,
      `update "manual_file_names" set "file_name" = 'x.pdf'`,
      `update "manual_file_names" set "shop_id" = '${adminB.shop.id}'`,
    ]) {
      await assert.rejects(
        withShop(adminA.shop.id, (tx) => tx.execute(sql.raw(statement))),
        rlsDenied,
        statement,
      );
    }
    // Only manual_id can change, and only to a manual in the name's shop.
    await assert.rejects(
      withShop(adminB.shop.id, (tx) => tx.execute(sql`update "manual_file_names" set "manual_id" = ${manualA}`)),
      (error: Error & { cause?: { code?: string } }) => error.cause?.code === "23503",
    );
    assert.deepEqual(await namesOf(manualA), ["Isolated.pdf"]);
  });
});

describe("browser copy numbers", () => {
  test("only a browser's one- or two-digit copy number comes off", () => {
    assert.equal(withoutCopyNumber("9921315_WIRE DIAGRAMS (1).pdf"), "9921315_WIRE DIAGRAMS.pdf");
    assert.equal(withoutCopyNumber("9942477r02 (12).pdf"), "9942477r02.pdf");
    // Firefox leaves out the space; the extension can be upper case.
    assert.equal(withoutCopyNumber("9942508(1).PDF"), "9942508.PDF");
    assert.equal(withoutCopyNumber("9942508.pdf"), null);
    // A part number in brackets is part of the name.
    assert.equal(withoutCopyNumber("2020 RZR APEX RC LE (2415113).pdf"), null);
    assert.equal(withoutCopyNumber("9923416 - CH 1-5.pdf"), null);
    assert.equal(withoutCopyNumber("Notes (1).txt"), null);
  });

  test("a manual added as 'X (1).pdf' is also known as 'X.pdf' and gets its entry", async () => {
    const plain = `99${suffix}_WIRE DIAGRAMS.pdf`;
    const id = await addManual(adminB, `99${suffix}_WIRE DIAGRAMS (1).pdf`, ["Wiring for the copy-number test."]);
    assert.deepEqual((await namesOf(id)).sort(), [plain, `99${suffix}_WIRE DIAGRAMS (1).pdf`].sort());
    await importEntries(adminB, [
      entry(plain, [[2012, `R12CN${suffix}`, "RANGER 800 EFI"]], { brand: "RGR", title: "2012 Ranger 800 Wiring Diagrams", modelYears: "2012" }),
    ]);
    const listed = (await listManuals(adminB.shop.id)).find((manual) => manual.id === id);
    assert.equal(listed?.title, "2012 Ranger 800 Wiring Diagrams");
    assert.deepEqual(listed?.brands, ["RGR"]);
    assert.deepEqual(
      (await manualsForModel(adminB.shop.id, `R12CN${suffix}`)).map((manual) => manual.id),
      [id],
    );
    const summary = await catalogSummary(adminB.shop.id);
    assert.ok(!summary.notListed.some((manual) => manual.id === id), JSON.stringify(summary.notListed));
    assert.ok(!summary.missingPdfs.some((missing) => missing.fileName === plain), JSON.stringify(summary.missingPdfs));
  });

  test("the plain name stays with a ready manual that already has it, and finishing says so", async () => {
    const plain = `98${suffix}.pdf`;
    const first = await addManual(adminB, plain, ["The original."]);
    // A newer download into the same folder: a different file, numbered.
    const second = await addManualFinished(adminB, `98${suffix} (1).pdf`, ["A different file under a numbered name."]);
    assert.equal(second.finished.nameTaken, plain);
    assert.equal(await ownerOf(adminB.shop.id, plain), first);
    assert.deepEqual(await namesOf(second.manualId), [`98${suffix} (1).pdf`]);
    // Finishing it again says the same.
    const again = await finishManual(adminB, { manualId: second.manualId });
    assert.ok("nameTaken" in again && !again.added && again.nameTaken === plain, JSON.stringify(again));
    // Choosing the numbered copy of the first file again links only that name.
    skipped(await startCopy(adminB, first, `98${suffix} (2).pdf`));
    assert.equal(await ownerOf(adminB.shop.id, plain), first);
    assert.equal(await ownerOf(adminB.shop.id, `98${suffix} (2).pdf`), first);
  });

  test("a ready 'X (1).pdf' takes 'X.pdf' from a manual that never finished, with its entry", async () => {
    const plain = `97${suffix}.pdf`;
    const model = `A24CN${suffix}`;
    await importEntries(adminB, [
      entry(plain, [[2024, model, "SPORTSMAN 570"]], { brand: "ATV", title: "2024 Sportsman 570", modelYears: "2024" }),
    ]);
    const stalled = await addStalled(adminB, plain);
    assert.equal(await ownerOf(adminB.shop.id, plain), stalled.manualId);
    // Downloaded again into the same folder, which still has the old file:
    // different bytes, saved as "(1)".
    const { manualId, finished } = await addManualFinished(adminB, `97${suffix} (1).pdf`, ["The complete download."]);
    assert.deepEqual(finished, { added: true, pageCount: 1, pagesWithoutText: 0, nameTaken: null });
    assert.equal(await ownerOf(adminB.shop.id, plain), manualId);
    assert.deepEqual(await namesOf(stalled.manualId), []);

    const listed = (await listManuals(adminB.shop.id)).find((manual) => manual.id === manualId);
    assert.deepEqual([listed?.title, listed?.brands, listed?.inList], ["2024 Sportsman 570", ["ATV"], true]);
    const atvs = (await listReadyManuals(adminB.shop.id, { vehicle: "ATV", year: 2024 })).map((manual) => manual.id);
    assert.ok(atvs.includes(manualId), JSON.stringify(atvs));
    assert.deepEqual(
      (await manualsForModel(adminB.shop.id, model)).map((manual) => manual.id),
      [manualId],
    );
    const summary = await catalogSummary(adminB.shop.id);
    assert.ok(!summary.notListed.some((manual) => manual.id === manualId), JSON.stringify(summary.notListed));
    assert.ok(summary.notListed.some((manual) => manual.id === stalled.manualId), JSON.stringify(summary.notListed));

    // The old download finishing after all doesn't take the name back from a
    // ready manual, and says so.
    const late = await stalled.finish();
    assert.ok("nameTaken" in late && late.added && late.nameTaken === plain, JSON.stringify(late));
    assert.equal(await ownerOf(adminB.shop.id, plain), manualId);
  });

  test("of two numbered names, the ready manual's takes the plain name from one that never finished", async () => {
    const plain = `96${suffix}.pdf`;
    // As migration 0015 decides between two numbered names.
    const stalled = await addStalled(adminB, `96${suffix} (1).pdf`);
    assert.equal(await ownerOf(adminB.shop.id, plain), stalled.manualId);
    const { manualId, finished } = await addManualFinished(adminB, `96${suffix} (2).pdf`, ["The ready one."]);
    assert.ok("nameTaken" in finished && finished.nameTaken === null, JSON.stringify(finished));
    assert.equal(await ownerOf(adminB.shop.id, plain), manualId);
    assert.deepEqual(await namesOf(stalled.manualId), [`96${suffix} (1).pdf`]);
  });

  test("a copy of a ready manual chosen as 'X (1).pdf' takes 'X.pdf' from a manual that never finished", async () => {
    const plain = `95${suffix}.pdf`;
    const stalled = await addStalled(adminB, plain);
    const ready = await addManual(adminB, `95${suffix}-ready.pdf`, ["Ready file."]);
    const linked = skipped(await startCopy(adminB, ready, `95${suffix} (1).pdf`));
    assert.equal(linked.message, `Same file as 95${suffix}-ready.pdf, already in the library. Linked this name to it.`);
    assert.equal(await ownerOf(adminB.shop.id, plain), ready);
    assert.deepEqual(await namesOf(stalled.manualId), []);

    // A copy of a manual that isn't ready yet takes nothing.
    const otherPlain = `94${suffix}.pdf`;
    const otherStalled = await addStalled(adminB, otherPlain);
    const unfinished = await addStalled(adminB, `94${suffix}-unfinished.pdf`);
    const [row] = await systemDb.select().from(manuals).where(eq(manuals.id, unfinished.manualId));
    const copy = await startManualUpload(
      adminB,
      { fileName: `94${suffix} (1).pdf`, sizeBytes: row.sizeBytes, sha256: row.sha256 },
      fakeStorage().storage,
    );
    assert.ok("manualId" in copy && copy.manualId === unfinished.manualId, JSON.stringify(copy));
    assert.equal(await ownerOf(adminB.shop.id, otherPlain), otherStalled.manualId);
  });
});

describe("the copy-number migration", () => {
  test("numbered names also get their plain name, never one another manual has", async () => {
    const migration = readFileSync(new URL("../drizzle/0015_manual_copy_numbers.sql", import.meta.url), "utf8");
    const [backfill] = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.replace(/^--.*$/gm, "").trim())
      .filter((statement) => statement.startsWith("INSERT INTO"));
    assert.ok(backfill, "the migration has a backfill");

    const shopId = adminA.shop.id;
    const manual = (fileName: string, createdAt: string, status = "ready") => ({
      id: randomUUID(),
      fileName,
      status,
      createdAt: new Date(createdAt),
    });
    const numbered = manual("9921315_WIRE DIAGRAMS (1).pdf", "2026-10-01T00:00:00Z");
    const firefox = manual("9942508(1).PDF", "2026-10-01T00:00:01Z");
    const original = manual("9950200.pdf", "2026-10-01T00:00:02Z");
    const different = manual("9950200 (1).pdf", "2026-10-01T00:00:03Z");
    const stalled = manual("9950300 (1).pdf", "2026-09-01T00:00:00Z", "uploading");
    const ready = manual("9950300 (2).pdf", "2026-10-02T00:00:00Z");
    const partNumber = manual("2020 RZR APEX RC LE (2415113).pdf", "2026-10-03T00:00:00Z");
    const all = [numbered, firefox, original, different, stalled, ready, partNumber];

    let names: { manualId: string; fileName: string }[] = [];
    let again = 0;
    await systemDb
      .transaction(async (tx) => {
        await tx.execute(sql`create temp table manuals (like public.manuals including all) on commit drop`);
        await tx.execute(
          sql`create temp table manual_file_names (like public.manual_file_names including all) on commit drop`,
        );
        await tx.execute(sql`
          insert into pg_temp.manuals (id, shop_id, title, file_name, sha256, size_bytes, storage_key, status, page_count, created_at)
          values ${sql.join(
            all.map(
              (m) =>
                sql`(${m.id}, ${shopId}, ${m.fileName}, ${m.fileName}, ${randomSha()}, 1, ${"shops/x/manuals/x.pdf"}, ${m.status}, 1, ${m.createdAt})`,
            ),
            sql`, `,
          )}
        `);
        // Each manual is known by its own name, as 0014 left them.
        await tx.execute(sql`
          insert into pg_temp.manual_file_names (shop_id, manual_id, file_name, created_at)
          select shop_id, id, file_name, created_at from pg_temp.manuals
        `);
        await tx.execute(sql.raw(backfill));
        const read = async () =>
          (
            await tx.execute<{ manual_id: string; file_name: string }>(
              sql`select manual_id, file_name from pg_temp.manual_file_names order by file_key`,
            )
          ).rows.map((row) => ({ manualId: row.manual_id, fileName: row.file_name }));
        names = await read();
        // Running it again (a retried deploy) changes nothing.
        await tx.execute(sql.raw(backfill));
        again = (await read()).length;
        tx.rollback();
      })
      .catch((error) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    const owner = (fileName: string) => names.find((name) => name.fileName.toLowerCase() === fileName.toLowerCase())?.manualId;
    assert.equal(owner("9921315_WIRE DIAGRAMS.pdf"), numbered.id);
    assert.equal(owner("9942508.pdf"), firefox.id);
    // The plain name already belonged to a different file.
    assert.equal(owner("9950200.pdf"), original.id);
    // Two numbered names for one plain name: the ready manual gets it.
    assert.equal(owner("9950300.pdf"), ready.id);
    // A part number in brackets isn't a copy number.
    assert.equal(owner("2020 RZR APEX RC LE.pdf"), undefined);
    assert.equal(names.length, all.length + 3);
    assert.equal(again, names.length);
  });
});

describe("the plain-name repair migration", () => {
  test("a ready numbered manual takes its plain name from one that never finished, never from a ready one", async () => {
    // Every statement of the migration, run as written against stand-ins
    // for manuals and manual_file_names (temporary tables come first on the
    // search path), with the names as 0014, 0015 and the app left them.
    const migration = readFileSync(new URL("../drizzle/0020_manual_plain_names.sql", import.meta.url), "utf8");
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.replace(/^--.*$/gm, "").trim())
      .filter(Boolean);
    assert.ok(statements.some((statement) => statement.startsWith("UPDATE")), "the migration has the repair");

    type Row = { id: string; shopId: string; fileName: string; status: string; readyAt: string | null; names: string[] };
    const manual = (shopId: string, fileName: string, status: string, readyAt: string | null = null, extra: string[] = []): Row => ({
      id: randomUUID(),
      shopId,
      fileName,
      status,
      readyAt,
      names: [fileName, ...extra],
    });
    const a = adminA.shop.id;
    const b = adminB.shop.id;
    const m = {
      // An unfinished X.pdf, then a ready "X (1).pdf": 0015 gave neither the other's name.
      stalled: manual(a, "9960100.pdf", "uploading"),
      numbered: manual(a, "9960100 (1).pdf", "ready", "2026-10-01T00:00:00Z"),
      // Firefox leaves out the space; names match whatever the case.
      stalledCase: manual(a, "9960200.PDF", "extracting"),
      firefox: manual(a, "9960200(1).pdf", "ready", "2026-10-01T00:00:00Z"),
      // The app since 0015: the stalled "(1)" got the plain name first.
      stalledOne: manual(a, "9960300 (1).pdf", "uploading", null, ["9960300.pdf"]),
      readyTwo: manual(a, "9960300 (2).pdf", "ready", "2026-10-02T00:00:00Z"),
      // Two ready manuals could take it: the first to be ready does.
      stalledFour: manual(a, "9960400.pdf", "uploading"),
      laterReady: manual(a, "9960400 (1).pdf", "ready", "2026-10-03T00:00:00Z"),
      firstReady: manual(a, "9960400 (2).pdf", "ready", "2026-10-02T00:00:00Z"),
      // A ready manual keeps its name.
      original: manual(a, "9960500.pdf", "ready", "2026-09-01T00:00:00Z"),
      newer: manual(a, "9960500 (1).pdf", "ready", "2026-10-01T00:00:00Z"),
      // Nothing ready to take it.
      stalledSix: manual(a, "9960600.pdf", "uploading"),
      stalledSixCopy: manual(a, "9960600 (1).pdf", "extracting"),
      // Three digits isn't a browser's copy number.
      stalledSeven: manual(a, "9960700.pdf", "uploading"),
      partNumber: manual(a, "9960700 (123).pdf", "ready", "2026-10-01T00:00:00Z"),
      // A numbered name linked to a ready manual (a copy chosen under it).
      stalledEight: manual(a, "9960800.pdf", "uploading"),
      linked: manual(a, "Winch.pdf", "ready", "2026-10-01T00:00:00Z", ["9960800 (1).pdf"]),
      // Another shop's unfinished manual under the same name as shop A's.
      otherShop: manual(b, "9960100.pdf", "uploading"),
    };
    const all = Object.values(m);

    let names: { manualId: string; fileKey: string }[] = [];
    let again: typeof names = [];
    await systemDb
      .transaction(async (tx) => {
        await tx.execute(sql`create temp table manuals (like public.manuals including all) on commit drop`);
        await tx.execute(
          sql`create temp table manual_file_names (like public.manual_file_names including all) on commit drop`,
        );
        await tx.execute(sql`
          insert into pg_temp.manuals (id, shop_id, title, file_name, sha256, size_bytes, storage_key, status, page_count, ready_at)
          values ${sql.join(
            all.map(
              (row) =>
                sql`(${row.id}, ${row.shopId}, ${row.fileName}, ${row.fileName}, ${randomSha()}, 1, ${"shops/x/manuals/x.pdf"}, ${row.status}, 1, ${row.readyAt})`,
            ),
            sql`, `,
          )}
        `);
        await tx.execute(sql`
          insert into pg_temp.manual_file_names (shop_id, manual_id, file_name)
          values ${sql.join(
            all.flatMap((row) => row.names.map((name) => sql`(${row.shopId}, ${row.id}, ${name})`)),
            sql`, `,
          )}
        `);
        // Each plain name is held by the manual that had it first, so 0015's
        // ON CONFLICT DO NOTHING (and the app before this) never gave it to
        // the numbered ones.
        const read = async () =>
          (
            await tx.execute<{ manual_id: string; file_key: string }>(
              sql`select manual_id, file_key from pg_temp.manual_file_names order by shop_id, file_key`,
            )
          ).rows.map((row) => ({ manualId: row.manual_id, fileKey: row.file_key }));
        for (const statement of statements) await tx.execute(sql.raw(statement));
        names = await read();
        // Running it again (a retried deploy) changes nothing.
        for (const statement of statements) await tx.execute(sql.raw(statement));
        again = await read();
        tx.rollback();
      })
      .catch((error) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    const owner = (shopId: string, fileName: string) => {
      const ids = new Set(all.filter((row) => row.shopId === shopId).map((row) => row.id));
      return names.find((name) => ids.has(name.manualId) && name.fileKey === fileName.toLowerCase())?.manualId;
    };
    assert.equal(owner(a, "9960100.pdf"), m.numbered.id);
    assert.equal(owner(a, "9960200.pdf"), m.firefox.id);
    assert.equal(owner(a, "9960300.pdf"), m.readyTwo.id);
    assert.equal(owner(a, "9960300 (1).pdf"), m.stalledOne.id);
    assert.equal(owner(a, "9960400.pdf"), m.firstReady.id);
    assert.equal(owner(a, "9960500.pdf"), m.original.id);
    assert.equal(owner(a, "9960600.pdf"), m.stalledSix.id);
    assert.equal(owner(a, "9960700.pdf"), m.stalledSeven.id);
    assert.equal(owner(a, "9960800.pdf"), m.linked.id);
    assert.equal(owner(b, "9960100.pdf"), m.otherShop.id);
    // Names only moved: none added or lost.
    assert.equal(names.length, all.reduce((total, row) => total + row.names.length, 0));
    assert.deepEqual(again, names);
    // The real tables were never touched.
    assert.equal((await systemDb.select().from(manuals).where(eq(manuals.id, m.numbered.id))).length, 0);
  });
});
