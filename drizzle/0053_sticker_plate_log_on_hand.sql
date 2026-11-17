-- The Sticker & Plate log keeps the numbers on hand: an entry with no
-- customer is one the shop has and hasn't handed out (received_at, when it
-- came into stock). It replaces the counted stock of 0051, which goes.
ALTER TABLE "sticker_plate_stock" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "sticker_plate_stock_own_shop" ON "sticker_plate_stock" CASCADE;--> statement-breakpoint
DROP TABLE "sticker_plate_stock" CASCADE;--> statement-breakpoint
ALTER TABLE "sticker_plate_log" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sticker_plate_log" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sticker_plate_log_stock" ON "sticker_plate_log" USING btree ("shop_id","plate_class","created_at") WHERE "sticker_plate_log"."received_at" is not null;--> statement-breakpoint
ALTER TABLE "sticker_plate_log" ADD CONSTRAINT "sticker_plate_log_on_hand" CHECK ("sticker_plate_log"."customer_id" is not null or "sticker_plate_log"."received_at" is not null);