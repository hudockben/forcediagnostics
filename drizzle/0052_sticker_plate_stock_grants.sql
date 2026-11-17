-- Sticker & Plate log stock: app_user can read, count and add deliveries to
-- its own shop's stock (row-level security). A row never changes shop or
-- what it counts, and isn't removed; every count and delivery is written to
-- the Activity log, which can't be changed.
GRANT SELECT, INSERT ON "sticker_plate_stock" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("counted", "counted_at", "updated_by_user_id", "updated_at") ON "sticker_plate_stock" TO app_user;
