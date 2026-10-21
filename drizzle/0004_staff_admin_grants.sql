-- Admin screens may change these columns only. shop_id stays out, so nobody
-- can move an account to another shop; home_location_id stays out until
-- locations get a shop-checked picker.
GRANT UPDATE ("name", "role", "disabled_at", "updated_at") ON "users" TO app_user;
--> statement-breakpoint
-- The audit log can be read and added to, never changed or deleted.
GRANT SELECT, INSERT ON "audit_log" TO app_user;
