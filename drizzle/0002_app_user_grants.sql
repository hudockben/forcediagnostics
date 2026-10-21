-- app_user only gets the tables it needs, and every one of them has a
-- row-level security policy that limits it to the current shop. Sessions,
-- accounts (password hashes), verifications and rate limits stay owner-only.
GRANT SELECT ON "shops" TO app_user;
--> statement-breakpoint
GRANT SELECT ON "users" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "locations" TO app_user;
