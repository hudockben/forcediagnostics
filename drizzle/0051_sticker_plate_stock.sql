CREATE TABLE "sticker_plate_stock" (
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"counted" integer NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sticker_plate_stock_pk" PRIMARY KEY("shop_id","kind"),
	CONSTRAINT "sticker_plate_stock_kind" CHECK ("sticker_plate_stock"."kind" in ('sticker', '1', '2')),
	CONSTRAINT "sticker_plate_stock_counted" CHECK ("sticker_plate_stock"."counted" between 0 and 100000)
);
--> statement-breakpoint
ALTER TABLE "sticker_plate_stock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sticker_plate_stock" ADD CONSTRAINT "sticker_plate_stock_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_plate_stock" ADD CONSTRAINT "sticker_plate_stock_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "sticker_plate_stock_own_shop" ON "sticker_plate_stock" AS PERMISSIVE FOR ALL TO "app_user" USING ("sticker_plate_stock"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid) WITH CHECK ("sticker_plate_stock"."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid);