-- Sticker & Plate log: a sticker has no class (null); a plate is Class 1 or
-- Class 2. The check on plate_class (1 or 2) lets null through.
ALTER TABLE "sticker_plate_log" ALTER COLUMN "plate_class" DROP NOT NULL;
