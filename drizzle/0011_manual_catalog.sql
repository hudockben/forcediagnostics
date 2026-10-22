CREATE TABLE "manual_catalog_documents" (
	"shop_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_key" text GENERATED ALWAYS AS (lower("file_name")) STORED NOT NULL,
	"brand" text,
	"inferred_brand" boolean DEFAULT false NOT NULL,
	"article" text,
	"title" text,
	"posted_on" date,
	"model_years" text,
	"import_id" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_catalog_documents_pk" PRIMARY KEY("shop_id","file_key"),
	CONSTRAINT "manual_catalog_documents_file_name" CHECK (length("manual_catalog_documents"."file_name") between 1 and 255),
	CONSTRAINT "manual_catalog_documents_inferred_brand" CHECK (not "manual_catalog_documents"."inferred_brand" or "manual_catalog_documents"."brand" is not null)
);
--> statement-breakpoint
ALTER TABLE "manual_catalog_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manual_catalog_models" (
	"shop_id" uuid NOT NULL,
	"file_key" text NOT NULL,
	"model_year" integer,
	"model_number" text,
	"model_description" text,
	"model_words" text GENERATED ALWAYS AS (' ' || upper(regexp_replace(coalesce("model_number", '') || ' ' || coalesce("model_description", ''), '[^A-Za-z0-9]+', ' ', 'g')) || ' ') STORED,
	CONSTRAINT "manual_catalog_models_year" CHECK ("manual_catalog_models"."model_year" between 1950 and 2100)
);
--> statement-breakpoint
ALTER TABLE "manual_catalog_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "manual_catalog_documents" ADD CONSTRAINT "manual_catalog_documents_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_catalog_models" ADD CONSTRAINT "manual_catalog_models_document_fk" FOREIGN KEY ("shop_id","file_key") REFERENCES "public"."manual_catalog_documents"("shop_id","file_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manual_catalog_models_document" ON "manual_catalog_models" USING btree ("shop_id","file_key");--> statement-breakpoint
CREATE INDEX "manual_catalog_models_number" ON "manual_catalog_models" USING btree ("shop_id","model_number");--> statement-breakpoint
CREATE INDEX "manual_catalog_models_year" ON "manual_catalog_models" USING btree ("shop_id","model_year");--> statement-breakpoint
CREATE POLICY "manual_catalog_documents_own_shop" ON "manual_catalog_documents" AS PERMISSIVE FOR SELECT TO "app_user" USING ("manual_catalog_documents"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_catalog_documents_add_own_shop" ON "manual_catalog_documents" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("manual_catalog_documents"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_catalog_documents_update_own_shop" ON "manual_catalog_documents" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("manual_catalog_documents"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("manual_catalog_documents"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_catalog_documents_remove_own_shop" ON "manual_catalog_documents" AS PERMISSIVE FOR DELETE TO "app_user" USING ("manual_catalog_documents"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_catalog_models_own_shop" ON "manual_catalog_models" AS PERMISSIVE FOR SELECT TO "app_user" USING ("manual_catalog_models"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_catalog_models_add_own_shop" ON "manual_catalog_models" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("manual_catalog_models"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_catalog_models_remove_own_shop" ON "manual_catalog_models" AS PERMISSIVE FOR DELETE TO "app_user" USING ("manual_catalog_models"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);