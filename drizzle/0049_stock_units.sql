CREATE TABLE "stock_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"vin" text NOT NULL,
	"unit_year" integer,
	"model" text NOT NULL,
	"model_number" text,
	"description" text,
	"engine_number" text,
	"received_on" date NOT NULL,
	"cost_cents" integer,
	"list_price_cents" integer,
	"sold_on" date,
	"notes" text,
	"invoice_number" text,
	"invoice_date" date,
	"file_name" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_units_vin" CHECK (length("stock_units"."vin") between 1 and 30),
	CONSTRAINT "stock_units_model" CHECK (length("stock_units"."model") between 1 and 120),
	CONSTRAINT "stock_units_unit_year" CHECK ("stock_units"."unit_year" between 1950 and 2100),
	CONSTRAINT "stock_units_texts" CHECK (length("stock_units"."model_number") between 1 and 20 and length("stock_units"."description") between 1 and 120 and length("stock_units"."engine_number") between 1 and 30 and length("stock_units"."notes") between 1 and 1000),
	CONSTRAINT "stock_units_invoice" CHECK (length("stock_units"."invoice_number") between 1 and 20 and length("stock_units"."file_name") between 1 and 200),
	CONSTRAINT "stock_units_amounts" CHECK ("stock_units"."cost_cents" between 0 and 1000000000 and "stock_units"."list_price_cents" between 0 and 1000000000)
);
--> statement-breakpoint
ALTER TABLE "stock_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_units_shop_vin" ON "stock_units" USING btree ("shop_id","vin");--> statement-breakpoint
CREATE INDEX "stock_units_shop_received" ON "stock_units" USING btree ("shop_id","received_on");--> statement-breakpoint
CREATE INDEX "stock_units_shop_model_number" ON "stock_units" USING btree ("shop_id","model_number");--> statement-breakpoint
CREATE POLICY "stock_units_own_shop" ON "stock_units" AS PERMISSIVE FOR ALL TO "app_user" USING ("stock_units"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("stock_units"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);