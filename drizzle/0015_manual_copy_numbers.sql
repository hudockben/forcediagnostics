-- A manual saved by the browser as "X (1).pdf" (Polaris's manuals downloaded
-- a second time into the same folder) is also known as "X.pdf", the name the
-- model list has, unless some manual already is. Same pattern as
-- withoutCopyNumber in src/lib/manual-catalog-rules.ts: one or two digits, so
-- "... (2415113).pdf" is left alone. When two names lose their numbers to the
-- same name, a ready manual gets it over one that never finished, and
-- otherwise the older name.
INSERT INTO "manual_file_names" ("shop_id", "manual_id", "file_name", "created_at")
SELECT n."shop_id", n."manual_id", regexp_replace(n."file_name", '\s?\(\d{1,2}\)(\.pdf)$', '\1', 'i'), n."created_at"
FROM "manual_file_names" n
JOIN "manuals" m ON m."id" = n."manual_id" AND m."shop_id" = n."shop_id"
WHERE n."file_name" ~* '\s?\(\d{1,2}\)\.pdf$'
ORDER BY m."status" = 'ready' DESC, n."created_at", n."manual_id"
ON CONFLICT ("shop_id", "file_key") DO NOTHING;
--> statement-breakpoint
ANALYZE "manual_file_names";
