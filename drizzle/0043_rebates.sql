-- A sale's id and shop, unique, for the rebate lines saved against it to
-- point at (before the foreign key that does).
ALTER TABLE "unit_sales" ADD CONSTRAINT "unit_sales_id_shop" UNIQUE("id","shop_id");--> statement-breakpoint
CREATE TABLE "rebate_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"number" text,
	"invoice_type" text,
	"invoice_date" date,
	"total_cents" integer,
	"rebate_column" text NOT NULL,
	"file_name" text NOT NULL,
	"pages" integer NOT NULL,
	"saved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rebate_invoices_id_shop" UNIQUE("id","shop_id"),
	CONSTRAINT "rebate_invoices_column" CHECK ("rebate_invoices"."rebate_column" in ('holdback', 'retailRewards', 'addlHoldback')),
	CONSTRAINT "rebate_invoices_number" CHECK (length("rebate_invoices"."number") between 1 and 20),
	CONSTRAINT "rebate_invoices_file_name" CHECK (length("rebate_invoices"."file_name") between 1 and 200),
	CONSTRAINT "rebate_invoices_pages" CHECK ("rebate_invoices"."pages" between 0 and 1000)
);
--> statement-breakpoint
ALTER TABLE "rebate_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rebate_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line" integer NOT NULL,
	"page" integer NOT NULL,
	"part" text,
	"vin_read" text NOT NULL,
	"model_code" text,
	"programs" text[] DEFAULT '{}'::text[] NOT NULL,
	"dates" text[] DEFAULT '{}'::text[] NOT NULL,
	"purchased" text[] DEFAULT '{}'::text[] NOT NULL,
	"names" text[] DEFAULT '{}'::text[] NOT NULL,
	"other" text[] DEFAULT '{}'::text[] NOT NULL,
	"unit_price_cents" integer,
	"amount_cents" integer,
	"amount_text" text DEFAULT '' NOT NULL,
	"amount_sure" boolean DEFAULT true NOT NULL,
	"sale_id" uuid,
	"match_how" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rebate_lines_line" CHECK ("rebate_lines"."line" between 1 and 100000 and "rebate_lines"."page" between 0 and 1000),
	CONSTRAINT "rebate_lines_vin_read" CHECK (length("rebate_lines"."vin_read") between 1 and 30),
	CONSTRAINT "rebate_lines_match_how" CHECK ("rebate_lines"."match_how" in ('vin', 'read', 'typo', 'name'))
);
--> statement-breakpoint
ALTER TABLE "rebate_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rebate_invoices" ADD CONSTRAINT "rebate_invoices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_invoices" ADD CONSTRAINT "rebate_invoices_saved_by_user_id_users_id_fk" FOREIGN KEY ("saved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_lines" ADD CONSTRAINT "rebate_lines_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_lines" ADD CONSTRAINT "rebate_lines_invoice_shop_fk" FOREIGN KEY ("invoice_id","shop_id") REFERENCES "public"."rebate_invoices"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_lines" ADD CONSTRAINT "rebate_lines_sale_shop_fk" FOREIGN KEY ("sale_id","shop_id") REFERENCES "public"."unit_sales"("id","shop_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rebate_invoices_shop_number" ON "rebate_invoices" USING btree ("shop_id","number") WHERE "rebate_invoices"."number" is not null;--> statement-breakpoint
CREATE INDEX "rebate_invoices_shop_date" ON "rebate_invoices" USING btree ("shop_id","invoice_date");--> statement-breakpoint
CREATE UNIQUE INDEX "rebate_lines_invoice_line" ON "rebate_lines" USING btree ("invoice_id","line");--> statement-breakpoint
CREATE INDEX "rebate_lines_sale" ON "rebate_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE POLICY "rebate_invoices_own_shop" ON "rebate_invoices" AS PERMISSIVE FOR ALL TO "app_user" USING ("rebate_invoices"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("rebate_invoices"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "rebate_lines_own_shop" ON "rebate_lines" AS PERMISSIVE FOR ALL TO "app_user" USING ("rebate_lines"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("rebate_lines"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);