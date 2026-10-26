import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  CONVERSATION_STATUSES,
  TURN_STATUSES,
  type ConversationStatus,
  type DiagnosisReply,
  type FeedbackEntry,
  type ProgressStep,
  type SeenSources,
  type StepCheckEntry,
  type TurnStatus,
  type TurnUsage,
} from "../lib/diagnose-rules";
import { MANUAL_STATUSES, type ManualStatus } from "../lib/manual-rules";
import { ROLES, type Role } from "../lib/roles";

// Row-level security: app code runs tenant queries as `app_user` with the
// shop ID set for the transaction (see withShop in ./index.ts). Policies only
// let that role see rows from its own shop, even if a query forgets a filter.
// The role is created in drizzle/0000_app_user_role.sql.
export const appUser = pgRole("app_user").existing();

const currentShopId = sql`nullif(current_setting('app.shop_id', true), '')::uuid`;

export { ROLES, type Role } from "../lib/roles";
export { MANUAL_STATUSES, type ManualStatus } from "../lib/manual-rules";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// A shop is one dealership. Its company code is what staff type to sign in.
export const shops = pgTable(
  "shops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("shops_code_format", sql`${t.code} ~ '^[a-z0-9]{2,16}$'`),
    pgPolicy("shops_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.id} = ${currentShopId}`,
    }),
  ],
);

// Stores under a shop, for shops with more than one.
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("locations_shop_name").on(t.shopId, t.name),
    pgPolicy("locations_own_shop", {
      for: "all",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

// The tables below are Better Auth's (see src/lib/auth.ts). Property names
// must match Better Auth's field names; column names are ours.

// Staff accounts. `username` is stored as "<company code>.<username>" so it is
// unique across shops while staff only ever type their own username.
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<Role>(),
    homeLocationId: uuid("home_location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    username: text("username").notNull().unique(),
    displayUsername: text("display_username"),
    // Better Auth requires an email; staff without one get a placeholder on
    // the reserved .invalid domain, which can never receive mail.
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // Set when an admin disables the account; disabled accounts can't sign in.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("users_shop_id").on(t.shopId),
    // Lets other tables tie a row to a user *and* that user's shop.
    unique("users_id_shop").on(t.id, t.shopId),
    check(
      "users_role",
      sql`${t.role} in (${sql.raw(ROLES.map((r) => `'${r}'`).join(", "))})`,
    ),
    pgPolicy("users_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    // Admin screens edit names, roles and disabled state; a user can never be
    // moved to another shop. Which columns are editable is set by the grant in
    // drizzle/0004_staff_admin_grants.sql.
    pgPolicy("users_update_own_shop", {
      for: "update",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

// Who did what to which record, per shop. Rows are only ever added.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_shop_created").on(t.shopId, t.createdAt),
    pgPolicy("audit_log_read_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("audit_log_add_own_shop", {
      for: "insert",
      to: appUser,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Set for PIN sessions on a bay tablet (see src/lib/bay.ts).
    deviceId: uuid("device_id").references(() => bayDevices.id, { onDelete: "cascade" }),
    // Last request seen, so idle PIN sessions can be ended on the server too.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_id").on(t.userId), index("sessions_device_id").on(t.deviceId)],
).enableRLS();

// Holds password hashes. app_user has no access; only auth code reads it.
export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_id").on(t.userId)],
).enableRLS();

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier").on(t.identifier)],
).enableRLS();

// Sign-in attempt counters, so rate limits hold across server instances.
export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
}).enableRLS();

// A shared bay tablet. The tablet holds a random token in an HttpOnly cookie;
// only its SHA-256 is stored here.
export const bayDevices = pgTable(
  "bay_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").unique(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("bay_devices_shop").on(t.shopId),
    pgPolicy("bay_devices_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("bay_devices_update_own_shop", {
      for: "update",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

// One-time codes for pairing a tablet, shown on a manager's screen and typed
// on the tablet. Only the code's SHA-256 is stored. Owner-only.
export const bayPairings = pgTable(
  "bay_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => bayDevices.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("bay_pairings_device").on(t.deviceId)],
).enableRLS();

// Each person's bay tablet PIN and its wrong-PIN counters. app_user may read
// the status columns for its own shop (granted per column), never pin_hash.
export const staffPins = pgTable(
  "staff_pins",
  {
    userId: text("user_id").primaryKey(),
    shopId: uuid("shop_id").notNull(),
    pinHash: text("pin_hash").notNull(),
    pinSetAt: timestamp("pin_set_at", { withTimezone: true }).notNull().defaultNow(),
    // Wrong PINs in a row; the 5th locks the PIN for 15 minutes.
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    // Wrong PINs in the current 24-hour window, never forgiven by a correct
    // PIN; the 10th locks the PIN until it's unlocked.
    dailyFailures: integer("daily_failures").notNull().default(0),
    dailyWindowStartedAt: timestamp("daily_window_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    // Shown to the person at their next sign-in, so they notice guessing.
    failuresSinceSignIn: integer("failures_since_sign_in").notNull().default(0),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    lastFailedDeviceId: uuid("last_failed_device_id").references(() => bayDevices.id, {
      onDelete: "set null",
    }),
    // The wrong tries before the latest run of them on one tablet, so the
    // person's own typos just before a right PIN can't hide someone else's.
    earlierFailures: integer("earlier_failures").notNull().default(0),
    earlierFailedAt: timestamp("earlier_failed_at", { withTimezone: true }),
    earlierFailedDeviceId: uuid("earlier_failed_device_id").references(() => bayDevices.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    // The PIN row can only ever belong to the user's own shop.
    foreignKey({
      name: "staff_pins_user_shop_fk",
      columns: [t.userId, t.shopId],
      foreignColumns: [users.id, users.shopId],
    }).onDelete("cascade"),
    index("staff_pins_shop").on(t.shopId),
    pgPolicy("staff_pins_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

// Attempt counters for the app's own limits (password sign-in per account,
// PIN guesses per tablet, pairing codes per address). Kept apart from Better
// Auth's rate_limits table, which it prunes after a minute. Owner-only.
export const attemptCounters = pgTable("attempt_counters", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStartedAt: bigint("window_started_at", { mode: "number" }).notNull(),
  lastAttemptAt: bigint("last_attempt_at", { mode: "number" }).notNull(),
}).enableRLS();

// Postgres full-text search document. Drizzle has no built-in type for it.
const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

// A service or owner manual in the shop's library. The PDF itself lives in
// private object storage under storage_key (see src/lib/storage.ts); its text
// is in manual_pages. Manuals are licensed to the dealership, so each shop
// has its own copy even of the same file.
export const manuals = pgTable(
  "manuals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    fileName: text("file_name").notNull(),
    // SHA-256 of the file (hex), so adding the same file again is skipped.
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    // uploading: the row exists, the file may not have arrived yet.
    // extracting: the file is stored and its text is being saved page by page.
    // ready: every page is saved; it shows up in the library.
    status: text("status").notNull().$type<ManualStatus>().default("uploading"),
    pageCount: integer("page_count"),
    // Pages with no text layer (usually scanned), which search can't find.
    // Counted again when OCR has read a manual's scanned pages.
    pagesWithoutText: integer("pages_without_text"),
    // Scanned pages OCR found text on (see src/lib/manual-ocr.ts); null
    // until OCR has read any of its pages.
    pagesReadByOcr: integer("pages_read_by_ocr"),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => [
    unique("manuals_shop_sha256").on(t.shopId, t.sha256),
    // Lets manual_pages tie a page to a manual *and* that manual's shop.
    unique("manuals_id_shop").on(t.id, t.shopId),
    check(
      "manuals_status",
      sql`${t.status} in (${sql.raw(MANUAL_STATUSES.map((s) => `'${s}'`).join(", "))})`,
    ),
    check("manuals_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("manuals_size_bytes", sql`${t.sizeBytes} > 0`),
    check("manuals_page_count", sql`${t.pageCount} >= 1`),
    pgPolicy("manuals_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("manuals_add_own_shop", {
      for: "insert",
      to: appUser,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
    // Which columns can change is set by the grant in
    // drizzle/0009_manual_library_grants.sql.
    pgPolicy("manuals_update_own_shop", {
      for: "update",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

// A page OCR still has to read: nothing search can find on it (no text
// layer, or only a stray mark or two) and OCR hasn't read it yet. The short
// text check comes first because it's cheap: Postgres knows a text's length
// without reading it, so the index on this doesn't read every page's words
// when it's built. Queries for these pages must use exactly this condition
// (manualPageToRead) for Postgres to use that index.
function pageToRead(page: { ocrAt: AnyPgColumn; text: AnyPgColumn; searchVector: AnyPgColumn }) {
  return sql`${page.ocrAt} is null and octet_length(${page.text}) < 64 and length(${page.searchVector}) = 0`;
}

// The text of each page of a manual, for full-text search.
export const manualPages = pgTable(
  "manual_pages",
  {
    manualId: uuid("manual_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    pageNumber: integer("page_number").notNull(),
    text: text("text").notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', "text")`,
    ),
    // When OCR read this page (a scanned page with no text layer), even if
    // it found no words, so it isn't read again. Null for every other page.
    ocrAt: timestamp("ocr_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: "manual_pages_pk", columns: [t.manualId, t.pageNumber] }),
    // The scanned pages OCR still has to read (see pageToRead above), so
    // finding them never reads the whole table: it only ever holds those.
    index("manual_pages_to_read").on(t.manualId, t.pageNumber).where(pageToRead(t)),
    // A page can only ever belong to a manual in its own shop.
    foreignKey({
      name: "manual_pages_manual_shop_fk",
      columns: [t.manualId, t.shopId],
      foreignColumns: [manuals.id, manuals.shopId],
    }).onDelete("cascade"),
    index("manual_pages_search").using("gin", t.searchVector),
    check("manual_pages_page_number", sql`${t.pageNumber} >= 1`),
    pgPolicy("manual_pages_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("manual_pages_add_own_shop", {
      for: "insert",
      to: appUser,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("manual_pages_update_own_shop", {
      for: "update",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

export const manualPageToRead = pageToRead(manualPages);

// Every file name a manual is known by: its own, and the names of
// byte-identical copies that were added after it (Polaris lists some PDFs
// several times, as "9860049R01.pdf", "9860049R01-2.pdf", …). Each PDF is
// stored once, so this is how the model list finds a manual under any of its
// names. A name belongs to one manual at most.
export const manualFileNames = pgTable(
  "manual_file_names",
  {
    shopId: uuid("shop_id").notNull(),
    manualId: uuid("manual_id").notNull(),
    // As the file was called, only trimmed, e.g. "9860049R01-2.pdf".
    fileName: text("file_name").notNull(),
    // Worked out by Postgres, the same way as manual_catalog_documents.file_key.
    fileKey: text("file_key")
      .notNull()
      .generatedAlwaysAs(sql`lower("file_name")`),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "manual_file_names_pk", columns: [t.shopId, t.fileKey] }),
    // A name can only ever belong to a manual in its own shop.
    foreignKey({
      name: "manual_file_names_manual_shop_fk",
      columns: [t.manualId, t.shopId],
      foreignColumns: [manuals.id, manuals.shopId],
    }).onDelete("cascade"),
    index("manual_file_names_manual").on(t.manualId, t.shopId),
    check("manual_file_names_file_name", sql`length(${t.fileName}) between 1 and 255`),
    pgPolicy("manual_file_names_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    // Names are added, and never removed; the grants are in
    // drizzle/0014_manual_file_names_grants.sql.
    pgPolicy("manual_file_names_add_own_shop", {
      for: "insert",
      to: appUser,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
    // Only manual_id can change: a ready manual takes its name from one that
    // never finished (see claimName in src/lib/manuals.ts).
    pgPolicy("manual_file_names_move_own_shop", {
      for: "update",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

// The shop's model list: Polaris's spreadsheet of which models each manual
// covers, imported under System Admin > Manuals (src/lib/manual-catalog.ts).
// One row per file, kept apart from manuals so the list can come before or
// after the PDFs, in any order. A manual finds its entries by file name:
// file_key is the lower-cased name, matched against manual_file_names.file_key
// for each name the manual is known by.
export const manualCatalogDocuments = pgTable(
  "manual_catalog_documents",
  {
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    // As listed, e.g. "9942508.pdf".
    fileName: text("file_name").notNull(),
    // Worked out by Postgres, so it always matches manual_file_names.file_key.
    fileKey: text("file_key")
      .notNull()
      .generatedAlwaysAs(sql`lower("file_name")`),
    // Polaris's category code as listed ("ATV", "RZR", "GEN"), shown as is.
    brand: text("brand"),
    // The list left the brand blank and it was worked out from the model
    // numbers (see inferBrands in src/lib/manual-catalog-rules.ts).
    inferredBrand: boolean("inferred_brand").notNull().default(false),
    // Polaris's part number for the manual.
    article: text("article"),
    // Polaris's subject line, which the library shows instead of the file name.
    title: text("title"),
    // The title as upper-case words between spaces, like
    // manual_catalog_models.model_words, for the Model filter: older models'
    // descriptions often shorten the name the title spells out ("SPM XP 850"
    // for the "2009 SPORTSMAN XP 850 Service Manual").
    titleWords: text("title_words").generatedAlwaysAs(
      sql`' ' || upper(regexp_replace(coalesce("title", ''), '[^A-Za-z0-9]+', ' ', 'g')) || ' '`,
    ),
    postedOn: date("posted_on"),
    // Free text as listed: "2020, 2022" or "2018-2027".
    modelYears: text("model_years"),
    // The import that last wrote this entry, for that import's counts.
    importId: uuid("import_id").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "manual_catalog_documents_pk", columns: [t.shopId, t.fileKey] }),
    check("manual_catalog_documents_file_name", sql`length(${t.fileName}) between 1 and 255`),
    check("manual_catalog_documents_inferred_brand", sql`not ${t.inferredBrand} or ${t.brand} is not null`),
    pgPolicy("manual_catalog_documents_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("manual_catalog_documents_add_own_shop", {
      for: "insert",
      to: appUser,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
    // Only the brand can change in place (filling in a blank one);
    // the column grant is in drizzle/0012_manual_catalog_grants.sql.
    pgPolicy("manual_catalog_documents_update_own_shop", {
      for: "update",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
    // Importing a file's entry again replaces it: delete, then add.
    pgPolicy("manual_catalog_documents_remove_own_shop", {
      for: "delete",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

// The models each model-list entry covers: one row per model number.
export const manualCatalogModels = pgTable(
  "manual_catalog_models",
  {
    shopId: uuid("shop_id").notNull(),
    fileKey: text("file_key").notNull(),
    modelYear: integer("model_year"),
    // Upper-cased, e.g. "Z24NAE99AK".
    modelNumber: text("model_number"),
    // e.g. "SPORTSMAN 850 ULTIMATE TRAIL - CHALK GLO".
    modelDescription: text("model_description"),
    // The number and description as upper-case words between spaces
    // (" Z24NAE99AK RZR XP 1000 EPS "), so the Library's Model filter can
    // match the start of any word with LIKE '% RZR%'.
    modelWords: text("model_words").generatedAlwaysAs(
      sql`' ' || upper(regexp_replace(coalesce("model_number", '') || ' ' || coalesce("model_description", ''), '[^A-Za-z0-9]+', ' ', 'g')) || ' '`,
    ),
  },
  (t) => [
    // A model can only ever belong to an entry in its own shop.
    foreignKey({
      name: "manual_catalog_models_document_fk",
      columns: [t.shopId, t.fileKey],
      foreignColumns: [manualCatalogDocuments.shopId, manualCatalogDocuments.fileKey],
    }).onDelete("cascade"),
    index("manual_catalog_models_document").on(t.shopId, t.fileKey),
    index("manual_catalog_models_number").on(t.shopId, t.modelNumber),
    index("manual_catalog_models_year").on(t.shopId, t.modelYear),
    check("manual_catalog_models_year", sql`${t.modelYear} between 1950 and 2100`),
    pgPolicy("manual_catalog_models_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("manual_catalog_models_add_own_shop", {
      for: "insert",
      to: appUser,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("manual_catalog_models_remove_own_shop", {
      for: "delete",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);


// Diagnose: a tech and Claude talking a unit's problem through, one
// conversation per unit and complaint (src/lib/diagnose.ts). The shop's
// record of it, so anyone in the shop can pick it up again.
export const diagnosisConversations = pgTable(
  "diagnosis_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    // Who started it.
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    // The unit, once the tech or Claude has identified it.
    unitModelNumber: text("unit_model_number"),
    unitYear: integer("unit_year"),
    // As shown: "2019 RZR XP 1000 EPS — Z19VDE99AM".
    unitLabel: text("unit_label"),
    // The unit's VIN, when the tech gave one (17 characters, upper case; see
    // src/lib/vin.ts). Set when the conversation starts, or when the unit is
    // looked up or changed by VIN.
    unitVin: text("unit_vin"),
    // The manuals Claude's tools search and read. Null: the whole library.
    scopeManualIds: uuid("scope_manual_ids").array(),
    // Whether web search was declared when it started. The tool list stays
    // the same for a conversation's whole life (changing it would break
    // Claude's replayed history); turning web search off later removes it
    // with a tool_removal message instead, recorded here.
    webSearch: boolean("web_search").notNull(),
    webSearchRemoved: boolean("web_search_removed").notNull().default(false),
    status: text("status").notNull().$type<ConversationStatus>().default("open"),
    // Totals over its finished messages.
    techMessages: integer("tech_messages").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    webSearches: integer("web_searches").notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    // The size of Claude's prompt at the last message, for the length cap.
    contextTokens: integer("context_tokens").notNull().default(0),
    // "This was it": the cause the tech confirmed, for AI-accuracy figures.
    outcome: jsonb("outcome").$type<{
      title: string;
      likelihood: string;
      rank: number;
      seq: number;
      userId: string;
      at: string;
    } | null>(),
    // Every "Ruled out" / "This was it" press, in order.
    feedback: jsonb("feedback").$type<FeedbackEntry[]>().notNull().default([]),
    // Every tick on one of Claude's checks (done, and OK or a problem found),
    // in order: what the bay tablet and the office PC both show.
    stepChecks: jsonb("step_checks").$type<StepCheckEntry[]>().notNull().default([]),
    // App notes for Claude's next message (a unit changed by the tech, say),
    // cleared once a message carrying them finishes.
    pendingNotes: jsonb("pending_notes").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Lets diagnosis_turns tie a turn to a conversation *and* its shop.
    unique("diagnosis_conversations_id_shop").on(t.id, t.shopId),
    foreignKey({
      name: "diagnosis_conversations_user_shop_fk",
      columns: [t.userId, t.shopId],
      foreignColumns: [users.id, users.shopId],
    }).onDelete("cascade"),
    index("diagnosis_conversations_shop_updated").on(t.shopId, t.updatedAt),
    check(
      "diagnosis_conversations_status",
      sql`${t.status} in (${sql.raw(CONVERSATION_STATUSES.map((s) => `'${s}'`).join(", "))})`,
    ),
    // 17 letters and digits, never I, O or Q.
    check("diagnosis_conversations_unit_vin", sql`${t.unitVin} ~ '^[A-HJ-NPR-Z0-9]{17}$'`),
    pgPolicy("diagnosis_conversations_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("diagnosis_conversations_add_own_shop", {
      for: "insert",
      to: appUser,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
    // Which columns can change is set by the grants in
    // drizzle/0019_diagnosis_grants.sql, 0023_diagnosis_vin_grants.sql and
    // 0025_diagnosis_step_checks_grants.sql.
    pgPolicy("diagnosis_conversations_update_own_shop", {
      for: "update",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);

// One tech message and Claude's work on it. history holds the exact API
// messages this message added (the tech's, then Claude's replies and the
// tool results), replayed unchanged ahead of every later message. It's
// json, not jsonb: json keeps the text as written, so key order and every
// byte of Claude's blocks come back the same.
export const diagnosisTurns = pgTable(
  "diagnosis_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    seq: integer("seq").notNull(),
    userId: text("user_id").notNull(),
    techText: text("tech_text").notNull(),
    // Set when it finishes; failed and stopped turns are never replayed.
    history: json("history").$type<unknown[]>(),
    reply: jsonb("reply").$type<DiagnosisReply>(),
    progress: jsonb("progress").$type<ProgressStep[]>().notNull().default([]),
    // The manual pages and web pages the tools showed Claude, which its
    // citations are checked against.
    seen: jsonb("seen").$type<SeenSources>().notNull().default({ pages: [], urls: [] }),
    usage: jsonb("usage").$type<TurnUsage>(),
    webSearches: integer("web_searches").notNull().default(0),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    status: text("status").notNull().$type<TurnStatus>().default("running"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(1),
    // Bumped while the server works on it; a running turn whose heartbeat
    // stopped (a crash, a timeout) is marked failed when someone looks.
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("diagnosis_turns_conversation_seq").on(t.conversationId, t.seq),
    // A turn can only ever belong to a conversation in its own shop.
    foreignKey({
      name: "diagnosis_turns_conversation_shop_fk",
      columns: [t.conversationId, t.shopId],
      foreignColumns: [diagnosisConversations.id, diagnosisConversations.shopId],
    }).onDelete("cascade"),
    foreignKey({
      name: "diagnosis_turns_user_shop_fk",
      columns: [t.userId, t.shopId],
      foreignColumns: [users.id, users.shopId],
    }).onDelete("cascade"),
    index("diagnosis_turns_shop_created").on(t.shopId, t.createdAt),
    check("diagnosis_turns_seq", sql`${t.seq} >= 1`),
    check(
      "diagnosis_turns_status",
      sql`${t.status} in (${sql.raw(TURN_STATUSES.map((s) => `'${s}'`).join(", "))})`,
    ),
    pgPolicy("diagnosis_turns_own_shop", {
      for: "select",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("diagnosis_turns_add_own_shop", {
      for: "insert",
      to: appUser,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
    pgPolicy("diagnosis_turns_update_own_shop", {
      for: "update",
      to: appUser,
      using: sql`${t.shopId} = ${currentShopId}`,
      withCheck: sql`${t.shopId} = ${currentShopId}`,
    }),
  ],
);
