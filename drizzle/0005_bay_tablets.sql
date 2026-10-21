CREATE TABLE "attempt_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_started_at" bigint NOT NULL,
	"last_attempt_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bay_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paired_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "bay_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "bay_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bay_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bay_pairings_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "bay_pairings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_pins" (
	"user_id" text PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"pin_hash" text NOT NULL,
	"pin_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"daily_failures" integer DEFAULT 0 NOT NULL,
	"daily_window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"failures_since_sign_in" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone,
	"last_failed_device_id" uuid
);
--> statement-breakpoint
ALTER TABLE "staff_pins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_shop" UNIQUE("id","shop_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "bay_devices" ADD CONSTRAINT "bay_devices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bay_devices" ADD CONSTRAINT "bay_devices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bay_pairings" ADD CONSTRAINT "bay_pairings_device_id_bay_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."bay_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_last_failed_device_id_bay_devices_id_fk" FOREIGN KEY ("last_failed_device_id") REFERENCES "public"."bay_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_user_shop_fk" FOREIGN KEY ("user_id","shop_id") REFERENCES "public"."users"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bay_devices_shop" ON "bay_devices" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "bay_pairings_device" ON "bay_pairings" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "staff_pins_shop" ON "staff_pins" USING btree ("shop_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_bay_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."bay_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_device_id" ON "sessions" USING btree ("device_id");--> statement-breakpoint
CREATE POLICY "bay_devices_own_shop" ON "bay_devices" AS PERMISSIVE FOR SELECT TO "app_user" USING ("bay_devices"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "bay_devices_update_own_shop" ON "bay_devices" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("bay_devices"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("bay_devices"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "staff_pins_own_shop" ON "staff_pins" AS PERMISSIVE FOR SELECT TO "app_user" USING ("staff_pins"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);