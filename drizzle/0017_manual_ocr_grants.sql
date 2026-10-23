-- Reading scanned pages with OCR (System Admin > Manuals > Scanned pages):
-- app_user can record that a page was read, for its own shop (row-level
-- security, as before). It could already change a page's text (0009) for
-- the uploader; src/lib/manual-ocr.ts only ever gives text to pages that
-- have none. A manual's counts are worked out again once OCR has read it.
GRANT UPDATE ("ocr_at") ON "manual_pages" TO app_user;
--> statement-breakpoint
GRANT UPDATE ("pages_read_by_ocr") ON "manuals" TO app_user;
