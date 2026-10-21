import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_id").on(t.userId)],
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
