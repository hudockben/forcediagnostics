-- System Admin > Supplier: app_user can add, read, change and remove its own
-- shop's suppliers (row-level security). A supplier never changes shop.
GRANT SELECT, INSERT, DELETE ON "suppliers" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("supplier_id", "supplier_code", "supplier_name", "category_code", "category_id", "updated_at") ON "suppliers" TO app_user;
