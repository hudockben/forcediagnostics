CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_code" text,
	"supplier_name" text NOT NULL,
	"category_code" text,
	"category_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_supplier_id" CHECK (length("suppliers"."supplier_id") between 1 and 40),
	CONSTRAINT "suppliers_supplier_name" CHECK (length("suppliers"."supplier_name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_shop_supplier_id" ON "suppliers" USING btree ("shop_id",lower("supplier_id"));--> statement-breakpoint
CREATE INDEX "suppliers_shop_name" ON "suppliers" USING btree ("shop_id",lower("supplier_name"));--> statement-breakpoint
CREATE POLICY "suppliers_own_shop" ON "suppliers" AS PERMISSIVE FOR ALL TO "app_user" USING ("suppliers"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("suppliers"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);