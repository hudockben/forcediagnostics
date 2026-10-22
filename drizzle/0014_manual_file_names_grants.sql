-- The names manuals are known by: app_user can read its own shop's and add
-- new ones (row-level security), never remove one. Only manual_id can
-- change, so that a ready manual can take its name from one that never
-- finished (see claimName in src/lib/manuals.ts); a name a ready manual has
-- stays with it. The foreign key keeps a name in its manual's shop. file_key
-- is generated, so it can't be written at all.
GRANT SELECT, INSERT ON "manual_file_names" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("manual_id") ON "manual_file_names" TO app_user;
--> statement-breakpoint
-- Every manual added so far is known by its own file name. If two of a
-- shop's manuals have the same name (whatever the case), a ready one keeps
-- it over one that never finished, and otherwise the older one. Names of
-- byte-identical copies are linked when the folder is chosen again (see
-- startManualUpload in src/lib/manuals.ts).
INSERT INTO "manual_file_names" ("shop_id", "manual_id", "file_name", "created_at")
SELECT "shop_id", "id", "file_name", "created_at"
FROM "manuals"
WHERE length("file_name") BETWEEN 1 AND 255
ORDER BY "status" = 'ready' DESC, "created_at", "id"
ON CONFLICT ("shop_id", "file_key") DO NOTHING;
--> statement-breakpoint
-- Statistics for the new table straight away, rather than when autovacuum
-- gets to it: until then Postgres plans the Library's queries as if it were
-- nearly empty.
ANALYZE "manual_file_names";
