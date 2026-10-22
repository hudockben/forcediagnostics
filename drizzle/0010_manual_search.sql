-- Library search reads page matches through this view instead of from
-- manual_pages directly. Under row-level security Postgres can't use the GIN
-- index for `search_vector @@ query`: the match isn't marked leakproof, so it
-- has to wait for the policy check and run on every one of the shop's pages.
-- The view belongs to the tables' owner, so their policies don't apply inside
-- it; instead it keeps to the shop withShop set (app.shop_id), the same check
-- the policies make, and to ready manuals. With no shop set it's empty.
--
-- It must stay a plain view (not security_barrier or security_invoker),
-- or the index can't be used again. Only src/lib/library.ts reads it.
CREATE VIEW "ready_manual_pages" AS
SELECT p."manual_id", p."page_number", p."search_vector"
FROM "manual_pages" p
JOIN "manuals" m ON m."id" = p."manual_id" AND m."shop_id" = p."shop_id" AND m."status" = 'ready'
WHERE p."shop_id" = nullif(current_setting('app.shop_id', true), '')::uuid;
--> statement-breakpoint
GRANT SELECT ON "ready_manual_pages" TO app_user;
