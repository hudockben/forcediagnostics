CREATE TABLE "manual_file_names" (
	"shop_id" uuid NOT NULL,
	"manual_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_key" text GENERATED ALWAYS AS (lower("file_name")) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_file_names_pk" PRIMARY KEY("shop_id","file_key"),
	CONSTRAINT "manual_file_names_file_name" CHECK (length("manual_file_names"."file_name") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "manual_file_names" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "manual_file_names" ADD CONSTRAINT "manual_file_names_manual_shop_fk" FOREIGN KEY ("manual_id","shop_id") REFERENCES "public"."manuals"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manual_file_names_manual" ON "manual_file_names" USING btree ("manual_id","shop_id");--> statement-breakpoint
CREATE POLICY "manual_file_names_own_shop" ON "manual_file_names" AS PERMISSIVE FOR SELECT TO "app_user" USING ("manual_file_names"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_file_names_add_own_shop" ON "manual_file_names" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("manual_file_names"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_file_names_move_own_shop" ON "manual_file_names" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("manual_file_names"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("manual_file_names"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);