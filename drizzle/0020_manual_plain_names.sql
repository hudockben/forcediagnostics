-- A ready manual known by a name with a browser copy number ("X (1).pdf")
-- takes that name without it ("X.pdf", the name the model list has) from a
-- manual that never finished, as finishing a manual now does (takeOwnName in
-- src/lib/manuals.ts). 0015 and the app before this left it with the
-- unfinished one, which kept the ready manual out of the model list. A name
-- a ready manual has stays with it; of two ready manuals that could take a
-- name, the first to be ready gets it. Same pattern as withoutCopyNumber in
-- src/lib/manual-catalog-rules.ts.
--
-- The manuals that never finished are locked first, as claimName locks one,
-- so one finishing on the old deployment while this runs either finishes
-- first and keeps its name, or waits and finds the name taken.
SELECT 1 FROM "manuals" WHERE "status" <> 'ready' FOR NO KEY UPDATE;
--> statement-breakpoint
UPDATE "manual_file_names" p
SET "manual_id" = c."manual_id"
FROM (
  SELECT DISTINCT ON (n."shop_id", "plain_key") n."shop_id", n."manual_id",
    lower(regexp_replace(n."file_name", '\s?\(\d{1,2}\)(\.pdf)$', '\1', 'i')) AS "plain_key"
  FROM "manual_file_names" n
  JOIN "manuals" m ON m."id" = n."manual_id" AND m."shop_id" = n."shop_id" AND m."status" = 'ready'
  WHERE n."file_name" ~* '\s?\(\d{1,2}\)\.pdf$'
  ORDER BY n."shop_id", "plain_key", m."ready_at", n."created_at", n."manual_id"
) c, "manuals" h
WHERE p."shop_id" = c."shop_id" AND p."file_key" = c."plain_key"
  AND h."id" = p."manual_id" AND h."shop_id" = p."shop_id" AND h."status" <> 'ready';
