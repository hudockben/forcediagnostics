import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { ROLES, type Role } from "../lib/roles";

// Row-level security: app code runs tenant queries as `app_user` with the
// shop ID set for the transaction (see withShop in ./index.ts). Policies only
// let that role see rows from its own shop, even if a query forgets a filter.
// The role is created in drizzle/0000_app_user_role.sql.
export const appUser = pgRole("app_user").existing();

const currentShopId = sql`nullif(current_setting('app.shop_id', true), '')::uuid`;

export { ROLES, type Role } from "../lib/roles";

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
