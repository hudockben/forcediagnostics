CREATE TABLE "manual_pages" (
	"manual_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"text" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
	CONSTRAINT "manual_pages_pk" PRIMARY KEY("manual_id","page_number"),
	CONSTRAINT "manual_pages_page_number" CHECK ("manual_pages"."page_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "manual_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manuals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"page_count" integer,
	"pages_without_text" integer,
	"uploaded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "manuals_shop_sha256" UNIQUE("shop_id","sha256"),
	CONSTRAINT "manuals_id_shop" UNIQUE("id","shop_id"),
	CONSTRAINT "manuals_status" CHECK ("manuals"."status" in ('uploading', 'extracting', 'ready')),
	CONSTRAINT "manuals_sha256_format" CHECK ("manuals"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "manuals_size_bytes" CHECK ("manuals"."size_bytes" > 0),
	CONSTRAINT "manuals_page_count" CHECK ("manuals"."page_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "manuals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "manual_pages" ADD CONSTRAINT "manual_pages_manual_shop_fk" FOREIGN KEY ("manual_id","shop_id") REFERENCES "public"."manuals"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuals" ADD CONSTRAINT "manuals_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manuals" ADD CONSTRAINT "manuals_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manual_pages_search" ON "manual_pages" USING gin ("search_vector");--> statement-breakpoint
CREATE POLICY "manual_pages_own_shop" ON "manual_pages" AS PERMISSIVE FOR SELECT TO "app_user" USING ("manual_pages"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_pages_add_own_shop" ON "manual_pages" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("manual_pages"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_pages_update_own_shop" ON "manual_pages" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("manual_pages"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("manual_pages"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manuals_own_shop" ON "manuals" AS PERMISSIVE FOR SELECT TO "app_user" USING ("manuals"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manuals_add_own_shop" ON "manuals" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("manuals"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manuals_update_own_shop" ON "manuals" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("manuals"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("manuals"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);