-- A sticker number is logged once however it's spaced or dashed ("A 12-345"
-- and "A12345" are one sticker): the unique key goes on the number without
-- them, as stickerKey in src/lib/sticker-log-rules.ts writes it.
ALTER TABLE "sticker_plate_log" DROP CONSTRAINT "sticker_plate_log_shop_sticker";--> statement-breakpoint
CREATE UNIQUE INDEX "sticker_plate_log_shop_sticker_key" ON "sticker_plate_log" USING btree ("shop_id",regexp_replace("sticker_number", '[^A-Z0-9]', '', 'g'));