-- The manual library: app_user can add manuals and their page text for its
-- own shop (row-level security) and move a manual through its upload steps.
-- Nothing can be deleted yet, and a manual's file, hash and storage key never
-- change once its row exists.
GRANT SELECT, INSERT ON "manuals" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("status", "page_count", "pages_without_text", "updated_at", "ready_at") ON "manuals" TO app_user;
--> statement-breakpoint
-- Pages are saved with an upsert, so a retried batch replaces the text.
GRANT SELECT, INSERT ON "manual_pages" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("text") ON "manual_pages" TO app_user;
