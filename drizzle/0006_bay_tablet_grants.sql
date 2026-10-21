-- app_user can read bay tablets and PIN status for its own shop (row-level
-- security), but never the secrets: token_hash and pin_hash are left out of
-- the column grants. Pairing codes, sessions and attempt counters stay
-- owner-only.
GRANT SELECT ("id", "shop_id", "name", "created_by_user_id", "created_at", "paired_at", "last_used_at", "revoked_at") ON "bay_devices" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("name", "revoked_at") ON "bay_devices" TO app_user;
--> statement-breakpoint
GRANT SELECT ("user_id", "shop_id", "pin_set_at", "consecutive_failures", "daily_failures", "locked_until", "locked_at", "failures_since_sign_in", "last_failed_at", "last_failed_device_id") ON "staff_pins" TO app_user;
