-- System Admin > Sticker & Plate log: app_user can log, read, correct and
-- remove its own shop's entries (row-level security). An entry never
-- changes shop; its customer can be corrected, to another customer of the
-- same shop (its foreign key on customer and shop sees to that).
GRANT SELECT, INSERT, DELETE ON "sticker_plate_log" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("customer_id", "sticker_number", "plate_class", "updated_at") ON "sticker_plate_log" TO app_user;
