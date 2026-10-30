CREATE TABLE "customer_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"relation_date" date,
	"year" integer,
	"make" text,
	"model" text,
	"model_number" text,
	"vin" text,
	"color" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_vehicles_id_shop" UNIQUE("id","shop_id"),
	CONSTRAINT "customer_vehicles_relation" CHECK ("customer_vehicles"."relation" in ('bought', 'sold', 'owned')),
	CONSTRAINT "customer_vehicles_year" CHECK ("customer_vehicles"."year" between 1950 and 2100),
	CONSTRAINT "customer_vehicles_vin" CHECK ("customer_vehicles"."vin" ~ '^[A-HJ-NPR-Z0-9]{17}$')
);
--> statement-breakpoint
ALTER TABLE "customer_vehicles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"notes" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_id_shop" UNIQUE("id","shop_id"),
	CONSTRAINT "customers_name" CHECK (length("customers"."name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "diagnosis_conversations" ADD COLUMN "customer_vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_vehicles" ADD CONSTRAINT "customer_vehicles_customer_shop_fk" FOREIGN KEY ("customer_id","shop_id") REFERENCES "public"."customers"("id","shop_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_vehicles_customer" ON "customer_vehicles" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_vehicles_shop_vin" ON "customer_vehicles" USING btree ("shop_id","vin");--> statement-breakpoint
CREATE INDEX "customers_shop_name" ON "customers" USING btree ("shop_id",lower("name"));--> statement-breakpoint
ALTER TABLE "diagnosis_conversations" ADD CONSTRAINT "diagnosis_conversations_customer_vehicle_fk" FOREIGN KEY ("customer_vehicle_id","shop_id") REFERENCES "public"."customer_vehicles"("id","shop_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnosis_conversations_customer_vehicle" ON "diagnosis_conversations" USING btree ("customer_vehicle_id");--> statement-breakpoint
CREATE POLICY "customer_vehicles_own_shop" ON "customer_vehicles" AS PERMISSIVE FOR ALL TO "app_user" USING ("customer_vehicles"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("customer_vehicles"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "customers_own_shop" ON "customers" AS PERMISSIVE FOR ALL TO "app_user" USING ("customers"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("customers"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);