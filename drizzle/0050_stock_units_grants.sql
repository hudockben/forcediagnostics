-- Unit List: app_user can add, read, correct and remove its own shop's
-- units in stock (row-level security). A unit never changes shop, who added
-- it or when, or the invoice and file it came in on. Every change is
-- written to the Activity log, which can't be changed.
GRANT SELECT, INSERT, DELETE ON "stock_units" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("vin", "unit_year", "model", "model_number", "description", "engine_number", "received_on", "cost_cents", "list_price_cents", "sold_on", "notes", "updated_at") ON "stock_units" TO app_user;
