-- Role that app code switches to (SET LOCAL ROLE) for shop-specific queries.
-- It can't log in and has no privileges beyond the grants in 0002, so
-- row-level security policies always apply to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- Lets the connecting (owner) role switch to app_user.
GRANT app_user TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user;
