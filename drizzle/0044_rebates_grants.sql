-- Rebates: app_user can save, read, replace and remove its own shop's
-- rebate invoices and their lines (row-level security). An invoice never
-- changes shop or when it was first saved; saving it again replaces its
-- details and its lines, which are only ever added and removed. Every save
-- and removal is written to the Activity log, which can't be changed.
GRANT SELECT, INSERT, DELETE ON "rebate_invoices" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("number", "invoice_type", "invoice_date", "total_cents", "rebate_column", "file_name", "pages", "saved_by_user_id", "updated_at") ON "rebate_invoices" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "rebate_lines" TO app_user;
