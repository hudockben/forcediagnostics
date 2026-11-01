CREATE TABLE "unit_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"sold_on" date NOT NULL,
	"salesperson" text,
	"customer_id" uuid,
	"customer_name" text NOT NULL,
	"customer_address" text,
	"customer_phone" text,
	"unit_year" integer,
	"unit_model" text,
	"condition" text NOT NULL,
	"unit_type" text NOT NULL,
	"vin" text,
	"category" text,
	"msrp_cents" integer,
	"sales_price_cents" integer,
	"dealer_cost_cents" integer,
	"unit_labor_cents" integer,
	"rebate_cents" integer,
	"acc_price_cents" integer,
	"acc_cost_cents" integer,
	"acc_labor_cents" integer,
	"esc_price_cents" integer,
	"esc_cost_cents" integer,
	"rewards_cents" integer,
	"holdback_rate_bp" integer NOT NULL,
	"bonus_rate_bp" integer NOT NULL,
	"notes" text,
	"finance_company" text,
	"amount_financed_cents" integer,
	"down_payment_cents" integer,
	"bonus_adjustment_cents" integer,
	"funding_received_on" date,
	"paid_on" date,
	"coms_number" text,
	"import_ref" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_sales_condition" CHECK ("unit_sales"."condition" in ('new', 'used')),
	CONSTRAINT "unit_sales_unit_type" CHECK ("unit_sales"."unit_type" in ('whole_good', 'trade', 'trailer', 'contest', 'free')),
	CONSTRAINT "unit_sales_customer_name" CHECK (length("unit_sales"."customer_name") between 1 and 120),
	CONSTRAINT "unit_sales_vin" CHECK (length("unit_sales"."vin") between 1 and 30),
	CONSTRAINT "unit_sales_unit_year" CHECK ("unit_sales"."unit_year" between 1950 and 2100),
	CONSTRAINT "unit_sales_rates" CHECK ("unit_sales"."holdback_rate_bp" between 0 and 10000 and "unit_sales"."bonus_rate_bp" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "unit_sales" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "unit_sales" ADD CONSTRAINT "unit_sales_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_sales" ADD CONSTRAINT "unit_sales_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_sales" ADD CONSTRAINT "unit_sales_customer_shop_fk" FOREIGN KEY ("customer_id","shop_id") REFERENCES "public"."customers"("id","shop_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "unit_sales_shop_sold" ON "unit_sales" USING btree ("shop_id","sold_on");--> statement-breakpoint
CREATE INDEX "unit_sales_customer" ON "unit_sales" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unit_sales_shop_vin_day" ON "unit_sales" USING btree ("shop_id","vin","sold_on") WHERE "unit_sales"."vin" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "unit_sales_shop_import_ref" ON "unit_sales" USING btree ("shop_id","import_ref") WHERE "unit_sales"."import_ref" is not null;--> statement-breakpoint
CREATE POLICY "unit_sales_own_shop" ON "unit_sales" AS PERMISSIVE FOR ALL TO "app_user" USING ("unit_sales"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("unit_sales"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);