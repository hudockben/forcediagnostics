CREATE TABLE "sticker_plate_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"sticker_number" text NOT NULL,
	"plate_class" integer NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sticker_plate_log_shop_sticker" UNIQUE("shop_id","sticker_number"),
	CONSTRAINT "sticker_plate_log_plate_class" CHECK ("sticker_plate_log"."plate_class" in (1, 2)),
	CONSTRAINT "sticker_plate_log_sticker_number" CHECK (length("sticker_plate_log"."sticker_number") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "sticker_plate_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sticker_plate_log" ADD CONSTRAINT "sticker_plate_log_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_plate_log" ADD CONSTRAINT "sticker_plate_log_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_plate_log" ADD CONSTRAINT "sticker_plate_log_customer_shop_fk" FOREIGN KEY ("customer_id","shop_id") REFERENCES "public"."customers"("id","shop_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sticker_plate_log_customer" ON "sticker_plate_log" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sticker_plate_log_shop_created" ON "sticker_plate_log" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE POLICY "sticker_plate_log_own_shop" ON "sticker_plate_log" AS PERMISSIVE FOR ALL TO "app_user" USING ("sticker_plate_log"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("sticker_plate_log"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);