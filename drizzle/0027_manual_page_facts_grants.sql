-- Diagnose's part sheet: app_user can read its own shop's page readings
-- (row-level security), claim a page to read it (an insert, or an upsert
-- that takes over a failed or stalled one) and save what was read. A
-- reading is never deleted (it goes with its page) and never changes page
-- or shop.
GRANT SELECT, INSERT ON "manual_page_facts" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("status", "facts", "dropped", "error", "attempts", "input_tokens", "output_tokens", "cost_cents", "attempted_at", "updated_at") ON "manual_page_facts" TO app_user;
