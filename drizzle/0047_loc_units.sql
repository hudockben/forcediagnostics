CREATE TABLE "loc_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"stock_number" text,
	"vin" text,
	"unit_year" integer,
	"model" text NOT NULL,
	"category" text,
	"condition" text NOT NULL,
	"cost_cents" integer NOT NULL,
	"free_floor_ends" date,
	"received_on" date,
	"on_loc" boolean NOT NULL,
	"paid_off_on" date,
	"sold_on" date,
	"notes" text,
	"trade_sale_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loc_units_condition" CHECK ("loc_units"."condition" in ('new', 'used')),
	CONSTRAINT "loc_units_model" CHECK (length("loc_units"."model") between 1 and 120),
	CONSTRAINT "loc_units_stock_number" CHECK (length("loc_units"."stock_number") between 1 and 20),
	CONSTRAINT "loc_units_vin" CHECK (length("loc_units"."vin") between 1 and 30),
	CONSTRAINT "loc_units_unit_year" CHECK ("loc_units"."unit_year" between 1950 and 2100),
	CONSTRAINT "loc_units_cost" CHECK ("loc_units"."cost_cents" between 0 and 1000000000),
	CONSTRAINT "loc_units_paid_off" CHECK (not ("loc_units"."on_loc" and "loc_units"."paid_off_on" is not null))
);
--> statement-breakpoint
ALTER TABLE "loc_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loc_units" ADD CONSTRAINT "loc_units_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loc_units" ADD CONSTRAINT "loc_units_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loc_units" ADD CONSTRAINT "loc_units_trade_sale_shop_fk" FOREIGN KEY ("trade_sale_id","shop_id") REFERENCES "public"."unit_sales"("id","shop_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loc_units_shop_stock" ON "loc_units" USING btree ("shop_id",lower("stock_number")) WHERE "loc_units"."stock_number" is not null and ("loc_units"."sold_on" is null or "loc_units"."on_loc");--> statement-breakpoint
CREATE INDEX "loc_units_shop_sold" ON "loc_units" USING btree ("shop_id","sold_on");--> statement-breakpoint
CREATE INDEX "loc_units_trade_sale" ON "loc_units" USING btree ("trade_sale_id");--> statement-breakpoint
CREATE POLICY "loc_units_own_shop" ON "loc_units" AS PERMISSIVE FOR ALL TO "app_user" USING ("loc_units"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("loc_units"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);