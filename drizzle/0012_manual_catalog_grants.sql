-- The model list: app_user can read and import its own shop's entries
-- (row-level security). Importing a file's entry again deletes the old one
-- and its models and adds the new ones; in place, only the brand can change,
-- when it's filled in from model numbers. file_key is generated, so it can't
-- be written at all. Manuals' own grants are unchanged.
GRANT SELECT, INSERT, DELETE ON "manual_catalog_documents" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("brand", "inferred_brand") ON "manual_catalog_documents" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "manual_catalog_models" TO app_user;
