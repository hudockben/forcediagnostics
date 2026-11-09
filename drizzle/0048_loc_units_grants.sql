-- LOC: app_user can add, read, change and remove its own shop's units on
-- the line of credit (row-level security). A unit never changes shop, or
-- who added it and when. A trade-in's tie to the NUSR sale it came in on
-- can be undone (the sale removed, the unit still on the lot), never moved
-- to another shop's sale (its foreign key on sale and shop sees to that).
-- Every change is written to the Activity log, which can't be changed.
GRANT SELECT, INSERT, DELETE ON "loc_units" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("stock_number", "vin", "unit_year", "model", "category", "condition", "cost_cents", "free_floor_ends", "received_on", "on_loc", "paid_off_on", "sold_on", "notes", "trade_sale_id", "updated_at") ON "loc_units" TO app_user;
