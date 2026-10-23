# forcediagnostics.ai

AI repair diagnosis for powersports service departments: fault codes, photos, video and tech notes in; a ranked diagnosis, parts and labor estimate, and after-action report out.

Live at [forcediagnostics.ai](https://forcediagnostics.ai).

## Stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript
- Tailwind CSS
- Neon Postgres + Drizzle ORM
- Better Auth for sign-in
- Cloudflare R2 for manual PDFs
- Hosted on Vercel

## Development

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and fill it in first. Open [http://localhost:3000](http://localhost:3000). The home page is the sign-in screen (`src/app/page.tsx`); its animated topo background lives in `src/components/topo/`.

Before pushing, run:

```bash
npm run lint
npm test     # needs DATABASE_URL pointing at a disposable Postgres database
npm run build
```

CI (`.github/workflows/ci.yml`) runs the same checks on every push.

## Deployment

Vercel deploys automatically:

- Push to `main` → production (forcediagnostics.ai)
- Push to any other branch → preview deployment with its own URL

Build features on a branch, check the preview, then merge into `main`. Each Vercel build runs `npm run db:migrate` first (see `vercel.json`).

## Database

Postgres on [Neon](https://neon.com) in AWS US East 2 (Ohio), connected through Vercel's Neon integration. The integration sets `DATABASE_URL` for Production and Preview, and each preview deployment gets its own Neon branch, so test links never touch production data.

- Queries go through [Drizzle ORM](https://orm.drizzle.team) over `pg` (`src/db/`), the TCP connection pool Neon recommends for Vercel Fluid compute.
- Functions run in Vercel's `cle1` region (Cleveland, the same AWS region as the database), set in `vercel.json`.
- `GET /api/health` reports whether the app can reach the database.

### Schema changes

Edit `src/db/schema.ts`, then run `npm run db:generate` to write a migration into `drizzle/`. Commit it; the next deploy applies it.

### Keeping shops apart

Every shop-owned table has a `shop_id` and a Postgres row-level security policy. Shop-specific code runs inside `withShop(shopId, tx => …)` (`src/db/index.ts`), which switches to the `app_user` role and sets the shop for that transaction, so the database only returns and accepts that shop's rows even if a query forgets a filter. `systemDb` bypasses this and is only for sign-in and setup. `tests/shop-isolation.test.ts` tries to reach across shops and must keep passing.

When you add a table: give it `shop_id`, add a `pgPolicy` for `appUser` like the existing ones, and grant `app_user` access in a migration.

## Signed-in app

After sign-in staff land on the **Home** tab (`src/app/(app)/home`), where they can change their password and set a bay tablet PIN. Everyone gets the **Library** tab, which searches the shop's manuals (see Manual library below). Admins and managers also get **System Admin** (`src/app/(app)/admin`), showing only the sections their role allows:

- **Accounts** (admins): add staff (no email needed), change names and roles, reset passwords and PINs, disable and re-enable accounts. Admins can't change their own role or disable themselves, and the shop always keeps at least one active admin. Every change is written to the `audit_log` table and shown under Recent account changes.
- **Bay tablets** (managers and admins): pair and remove shared tablets, unlock locked PINs. See below.
- **Manuals** (admins): add the shop's PDF manuals to the library. See below.
- **Permissions** (admins): what each role can do. The table is `src/lib/permissions.ts`; server code checks it with `allows()` / `requireCapability()`, so the page and the rules can't drift apart. Managing accounts, tablets and settings also needs a password sign-in, never a PIN one.

## Sign-in

Staff sign in with company code, username and password through [Better Auth](https://better-auth.com) (`src/lib/auth.ts`); accounts, sessions and password hashes live in the Neon database. Usernames only have to be unique within a shop: they are stored as `<company code>.<username>`. There is no public sign-up.

The first shop and its admin are created once at `/setup`, which needs the one-time setup code and stops working as soon as a shop exists.

`BETTER_AUTH_SECRET` must be set in Vercel (Production and Preview). Changing it signs everyone out.

Wrong passwords are limited to 10 per account per 15 minutes, counted in the app's own `attempt_counters` table (`src/lib/attempts.ts`), on top of Better Auth's per-address limits.

## Bay tablets

Shared tablets in the bays sign people in with a 4–6 digit PIN instead of a password (`src/lib/bay.ts`, `src/lib/pins.ts`, `src/lib/bay-pin-plugin.ts`).

- **Pairing:** a manager adds the tablet under System Admin → Bay tablets on their own computer or phone, which shows a one-time code (8 characters, 10 minutes). Typing it at `/bay` on the tablet gives the tablet a random token in an HttpOnly cookie; the database only stores its SHA-256. Removing the tablet, or pairing it again, signs out everyone on it.
- **PINs:** staff set their own on Home (needs their password), or an admin sets one on the account page. Easy PINs (`1234`, `2580`, years, repeats) are refused (`src/lib/pin-rules.ts`). PINs are hashed like passwords and the `app_user` role can't read the hashes.
- **Signing in:** `/bay` shows the shop's people who have a PIN; pick a name, type the PIN. Tablets only take PINs, never passwords, and a PIN only works on a paired tablet.
- **Lockouts:** 5 wrong PINs in a row lock that PIN for 15 minutes; 10 in a day lock it until a manager or admin unlocks it, a new PIN is set, or the person signs in with their password. A tablet pauses PIN sign-in after 15 wrong PINs in 15 minutes across everyone. After a right PIN, people are told about wrong tries on their PIN since they last used it, apart from their own typos just before.
- **Sessions:** a PIN session is tied to its tablet, lasts at most 12 hours, and ends on the server after 6 minutes without use. After 5 idle minutes the screen locks and ends that session, even across a reload; they type their PIN to carry on where they were, or anyone else taps Not you? to switch. Other tabs on the tablet follow whoever signs in or out. PIN sessions can't change passwords or open account, tablet or settings pages.

## Manual library

The **Library** tab searches every page of the shop's service and owner manuals and opens them at the right page; admins add the PDFs under System Admin → **Manuals**. Manuals are licensed to the dealership, so each shop has its own library: `manuals`, `manual_pages` and `manual_file_names` have a `shop_id` and row-level security like every shop table, and a file added by two shops is stored twice.

- **Files** live in a private Cloudflare R2 bucket under `shops/<shop id>/manuals/<manual id>.pdf`, reached through R2's S3-compatible API with [aws4fetch](https://github.com/mhart/aws4fetch) (`src/lib/storage.ts`). Browsers upload and download straight to and from R2 with presigned URLs, handed out only after a permission check: uploads last an hour and must be sent as `application/pdf`, downloads last 15 minutes. Files never pass through Vercel, which takes at most about 4.5 MB per request. The R2 keys stay on the server.
- **Adding** (`src/app/(app)/admin/manuals/`, `src/lib/manuals.ts`): admins choose PDFs, a whole folder, or drag them in; anything that isn't a PDF is left out. For each file the browser works out its SHA-256 and checks [pdf.js](https://mozilla.github.io/pdf.js/) can open it, then asks the server what to do. A file already in the library is skipped, whatever it's called (see One manual, several names below). One that stopped part way carries on, without uploading again if the whole file already reached R2. Otherwise the browser uploads it, the server checks its size in R2, and the browser reads each page's text with pdf.js and sends it in batches, each well under the 1 MB Server Action limit. Once every page is saved the manual shows in the library and `audit_log` records it (`manual.added`). Pages with no text layer are counted and left for OCR (Scanned pages, below). Two files go at a time. Damaged or password-protected PDFs fail with a reason and a Retry button, and the rest carry on. If the connection drops, files wait and carry on when it's back. Choosing the same folder again retries what failed and leaves the rest alone, and if the tab closes, choosing it again finishes what's left.
- **Search** (`src/lib/library.ts`) is Postgres full-text search over `manual_pages`, one row per page with a stored `tsvector` column and a GIN index. Under row-level security Postgres can't use that index (the match operator isn't leakproof), so search finds pages through the `ready_manual_pages` view (`drizzle/0010_manual_search.sql`), which belongs to the table owner and makes the same shop check itself. It takes web-search syntax: plain words (all must match), `"quoted phrases"`, `or`, `-word`. Fault codes like `P0300` and part numbers like `2205123` match as whole words. Results are the 50 best pages, with the matches highlighted. Filters (below) apply after the index has found the matching pages, in a materialized CTE they can't reach into: otherwise Postgres, guessing a filter leaves a manual or two, reads those manuals' pages one by one, which is slow when it matches hundreds. `tests/manuals.test.ts` checks the plan with and without filters.
- **Viewer** (`/library/<id>?page=N`): pdf.js draws one page at a time and fetches only the parts of the PDF that page needs with HTTP range requests, so a 100 MB manual opens on a bay tablet without downloading all of it. When its link runs out it gets a new one. Scanned-page images (CCITT, JBIG2, JPEG 2000) need pdf.js's WebAssembly decoders, which `npm run dev` and `npm run build` copy into `public/pdfjs/wasm/` (`scripts/copy-pdfjs-wasm.mjs`). **Open full PDF** goes through `/library/<id>/file`, which hands out a fresh link each time.
- **Who can:** everyone can search and read (`library.read`), including PIN sessions on bay tablets. Adding manuals, the model list and reading scanned pages need `settings.manage`: admins, signed in with a password.

### Scanned pages (OCR)

Some manuals are scans: pictures of pages with no text layer, so search can't find anything on them (the 1985-1995 Vol. I service manual is 424 of them). The **Scanned pages** card on System Admin → Manuals reads the words on those pages with [Tesseract.js](https://github.com/naptha/tesseract.js) (OCR, English), in the admin's browser: the PDF comes straight from the shop's R2 bucket, nothing goes to an OCR service, and only the text reaches our server. It's free, and it's private to the shop.

- **What gets read** (`src/lib/manual-ocr.ts`): the pages of ready manuals that have nothing search can find and that OCR hasn't read yet (`manual_pages.ocr_at` is null): a page with no text layer, or only a stray mark or two (under 64 bytes). A partial index, `manual_pages_to_read`, holds just those pages, so finding them never reads the whole table, and building it only checked each page's length (`drizzle/0016_manual_ocr.sql`).
- **In the browser** (`src/app/(app)/admin/manuals/ocr-job.ts`, rules in `src/lib/manual-ocr-rules.ts`): **Read scanned pages** asks the server what's left, then for each manual pdf.js opens the PDF with range requests (only the scanned pages' parts are fetched; a new link every 10 minutes, since links last 15) and draws each page at 300 dpi, or less for pages over 12 million pixels (fold-outs), with pdf.js's print mode so it keeps going in a background tab. pdf.js's image decoders (CCITT and JBIG2, JPEG 2000) are fetched once per tab and handed to it by the job: when one doesn't load, pdf.js would draw the scan blank and OCR would save it as a page with no words, so instead the page is drawn again from a fresh copy of the PDF, and listed with Retry if that fails too. The page is turned grey (a PGM image, much quicker for Tesseract than PNG) and long, thin ruled lines are taken out: Tesseract reads a ruled torque table as a picture and gets little of it, and without the rules it reads the cells. Only lines with light paper either side count, so a dark grey photocopy or white words in a black panel are left as they are. A Tesseract scheduler reads pages with one worker per processor less one, from one to four. From Tesseract's word list (TSV, with a confidence for each word) it keeps the words it's sure of (50 and up; 20 for fault codes and part numbers, which aren't in its dictionary), drops lines that are mostly guesses (what it makes of photos and drawings) and fixes O-for-0 and l-for-1 in codes and part numbers ("PO300" → "P0300"). Text goes to the server ten pages at a time, well under the 1 MB Server Action limit.
- **On the server** the text is cleaned and capped like uploaded text, and only ever goes to a page that's still left to read: text from the PDF or an earlier OCR is never changed (a stray mark from the PDF stays, with OCR's words after it). Each page read gets `ocr_at`, even when OCR found no words (a blank page, a photo), so it isn't read again. A manual's `pages_without_text` and `pages_read_by_ocr` drop and rise as pages are read. Every batch that changes pages is recorded as `manual.ocr` in `audit_log`, with its page numbers, in the same transaction as the text (its words are in search straight away, whether or not the manual is ever finished); the batch that reads a manual's last page counts them again from the pages, and its row says `finished` with the counts (pages read, pages with text, pages still without). Search needs no change: the `tsvector` is generated from the text, so OCR's words are found, highlighted and open at their page like any others.
- **The card** shows how many manuals and pages are left and a rough time; while it reads, the manual and page, pages read, pages a minute and time left, with **Pause** and **Resume** (pausing waits for the pages being read, saves them and stops Tesseract to give its memory back). The tab warns before closing while it reads, not while paused, and holds a screen wake lock so the computer doesn't go to sleep while the tab is in front (browsers let go of it when the tab is hidden; for a long run, leave the tab in front or set the computer not to sleep). If the connection drops it waits and carries on: when a step fails, it asks the server (`/api/health`) whether it's there, since the browser still says it's online when only the shop's internet is down, and waits (checking again after 5 seconds, doubling to a minute) without counting it against the page. If the app is updated mid-run, it stops and says to reload the page. If three manuals, or twenty pages, fail one after another with the connection up and nothing saved in between (file storage down, say), it stops with a note rather than working down the whole list; a damaged or password-protected file, or one missing from storage, is only that manual's problem and doesn't count. A manual or page that can't be read (a file storage won't hand over, a page pdf.js can't draw, a page Tesseract fails on twice) is listed with **Retry**, stays unread, and the rest carry on. If the tab closes, pressing **Read scanned pages** again carries on with what the server says is left; at most the last few unsaved pages are read again. One tab reads at a time (the Web Locks API), and the run keeps going while the admin looks at another part of the app.
- **New uploads** don't run OCR (it's far slower than adding a file): the uploader says how many pages are scanned and points to the card. The admin list says how many pages OCR read ("12 pages read by OCR") and still flags pages without text, saying whether OCR hasn't read them yet or found no words on them (blank pages, pictures).
- **Files:** Tesseract's worker, its WebAssembly engine (the LSTM-only builds, with and without SIMD; it picks one) and the English data (`4.0.0_best_int`, 3 MB) are copied into `public/tesseract/` by `scripts/copy-tesseract.mjs` before `dev` and `build`, from the pinned `tesseract.js`, `tesseract.js-core` and `@tesseract.js-data/eng` packages. Nothing is loaded from a CDN. The browser keeps the English data after the first run.
- **Speed:** about a second a page or a little under with three workers on a 4-core computer (measured in headless Chromium at 300 dpi: 0.8 s a page through a 60-page scanned manual, 0.8–1.1 s on test pages; 2.3 s with one worker), so the 424-page Vol. I manual takes 6 to 8 minutes and 10,000 scanned pages 2 to 3 hours. More cores read faster, up to four workers; 200 dpi would be about a third quicker but reads small print (6–8 pt tables and notes) worse.

### Model list

Polaris's STOP site gives a spreadsheet of which models each manual covers. Saved as CSV (`manual-list - All.csv`) next to the PDFs, it tags every manual with its brand, model years and model numbers, so the Library can filter by them and, later, the diagnosis assistant can read only the manuals for a unit's model number.

- **Adding it:** drop the folder with the PDFs and the CSV on System Admin → Manuals, or choose the CSV on its own with **Choose files**. Any `.csv` with the right header is imported first, before any PDF starts, and gets its own row: "Model list: 440 manuals, 18,203 models (52 brands filled in from model numbers)". A CSV with another header is reported and skipped. The **Model list** card shows how many manuals are added and listed, and (folded away) which manuals aren't in the list and which entries have no PDF yet.
- **Format**, exactly as the export script writes it: UTF-8 (a byte order mark is fine; a list Excel saved again as plain "CSV (Comma delimited)", which is Windows-1252, is skipped with a note to save it as "CSV UTF-8" instead, rather than turning ® into �), CRLF or LF line breaks, fields in double quotes (quotes inside doubled), and the header `"File","Brand","Article","Posted On","Title","Model Years","Year","Model Number","Model Description"`. One row per manual and model; a manual with no models has one row with Year, Model Number and Model Description blank. File is the PDF's file name, Brand Polaris's category code (`ATV`, `RGR`, `RZR`, `GEN`, …; see Vehicles below), Posted On `6/24/2024`, Year `2020`, Model Number `Z24NAE99AK`. Rows with a blank File (manuals with no download) are skipped. A row with the wrong number of columns stops that CSV; a manual with a bad date or a year outside 1950–2100 is left out, with the row number, and the rest go in.
- **How it's read** (`src/lib/csv.ts`, `src/lib/manual-catalog-rules.ts`): the browser parses the CSV (RFC 4180: quoted commas, quotes and line breaks), groups the rows by file and sends them in batches well under the 1 MB Server Action limit, never splitting one file's rows. The server checks every field again (`src/lib/manual-catalog.ts`). Model numbers are stored upper-cased and line breaks in fields become spaces.
- **Matching by file name:** the list is kept apart from the manuals, one entry per file in `manual_catalog_documents` and one row per model in `manual_catalog_models` (both shop-owned, with row-level security), keyed by the lower-cased file name. So it can be imported before or after the PDFs, in any order, and a manual uses the entry for each name it's known by (`manual_file_names`, below) whatever the case. File names are only trimmed, never otherwise tidied, on both sides, so a name with two spaces or a no-break space in it still matches. The Library and the admin list then call the manual by Polaris's subject line ("2027 RZR Pro R Boost / Pro R Boost 4") instead of its file name, with the brand and model years beside it. The PDFs have to keep the names the CSV lists. A browser's copy number counts as the same name: a manual added as `X (1).pdf` (the files downloaded a second time into the same folder) is also known as `X.pdf`, unless another manual already is (`withoutCopyNumber`; `drizzle/0015_manual_copy_numbers.sql` did the same for manuals added before). Only one or two digits count, so a name like `… (2415113).pdf` is left alone.
- **One manual, several names:** Polaris lists some PDFs more than once under different names: the Winch Diagnostic & Troubleshooting Guide is `9860049R01.pdf` and `9860049R01-2.pdf` … `-5.pdf` (entries under XXP, GRL and other brands), and the RZR 800 manual is both `9924882_2014_RGRRZR800.pdf` and `9924882_2014_RZR800.pdf`. The uploader stores each PDF once, so `manual_file_names` keeps every name a manual is known by, one row per name (`shop_id`, `manual_id`, `file_name`, and `file_key`, the lower-cased name). A name belongs to one manual at most (its key is `shop_id` + `file_key`), and a composite foreign key keeps it in its manual's shop; `app_user` can read and add names, never remove or rename one; it can only move one to another manual of the shop (below). A new manual records its own name in the same transaction. When a file turns out to be one already in the library under another name, `startManualUpload` links that name to the manual and the uploader says so ("Same file as 9860049R01.pdf, already in the library. Linked this name to it.", recorded in `audit_log` as `manual.name_linked`), uploading nothing; a name some other ready manual (a different file) already has stays with that one, and the uploader says so too. A name held by a manual that never finished (an upload that stopped and was never tried again) goes to the first ready manual that asks for it, when it finishes or when a copy of it is chosen under that name (`claimName`), so an abandoned row can't keep a newer download out of the model list. So choosing the whole folder again after an upload links every duplicate name, at one short server call per file. `drizzle/0014_manual_file_names_grants.sql` gave every manual added before this its own name (of two that share a name, whatever the case, a ready one keeps it over one that never finished, and otherwise the older one); the duplicates' names come from choosing the folder again.
- **A manual's entries:** with several names, a manual can have several entries. It's called by the title of the entry for its own file name, or failing that its first other listed name (A to Z), or failing both its file name. Its Model Years are its entries' Model Years, or when they differ, the earliest year in them to the latest (the RZR 800 manual's `2013` and `2014` make `2013-2014`), whichever name is its own. Brands are all its entries' brands, once each ("Ranger, RZR, General, Xpedition, ATV"), and the admin list counts each of their models once and shows its other names ("Also named …"). The Model list card counts a manual as "not in the model list" only when none of its names is listed, and an entry as "no PDF added yet" when no manual is known by its name. The SQL for these is in `src/lib/manual-catalog.ts` (small subqueries per manual, by index).
- **Importing again** replaces each listed file's entry and models in one transaction: the same CSV again changes nothing, and a newer CSV wins for the files it lists while the others keep their entries. With two CSVs in one folder (an older `manual-list - ATV.csv`, say), the older file by its date goes first, so the newer one has the last word. Each import is recorded in `audit_log` (`manual_catalog.imported`, with counts).
- **Blank brands** (about 50 "web manuals") are filled in after each import, learned from the entries that do name theirs (`inferBrands`). Words in the title and model descriptions come first ("RANGER", "SPORTSMAN", "GENERATOR"): a word counts only when at least 90% of the named entries using it, and at least two of them, share a brand, and the top brand needs twice the runner-up's words. Failing that, model numbers vote by first letter, but only letters 95% of named entries agree on, since product lines share letters (in Polaris's list `P` covers generators and some ATVs, `R` Rangers and older RZRs); the top brand then needs two-thirds of the entry's model numbers. Anything unclear stays blank: on Polaris's full list this fills in 46 of the 53 blank entries, all correctly, and leaves 7. Filled-in brands show as "(filled in from its models)" on the admin list and are worked out again on every import.
- **Vehicles:** the app calls Polaris's codes by name, from a small table in `src/lib/manual-catalog-rules.ts`: `RGR` Ranger, `RZR` RZR, `GRL` General and `XXP` Xpedition are UTVs (side-by-sides), `ATV` is ATVs and `GEN` Generators. Any other code shows as it is, under Other. The labels show everywhere instead of codes: search results, the list of manuals, the viewer's header and the admin list ("Ranger · 2019-2022 · 17 models", or "Ranger (filled in from its models)").
- **Filters** on the Library: Vehicle, Year, and Model, which matches a model number or its start (`Z24NAE99`) or the start of words in model names (`RZR XP 1000`). Vehicle is one select: All vehicles; UTVs (side-by-sides) with the lines present indented under it (Ranger, RZR, General, Xpedition); ATVs; Generators; and Other with any other codes, each with how many ready manuals it has (a manual listed for a Ranger and a RZR counts once under UTVs). Filters narrow both search results and the list of manuals and live in the address so a filtered search can be shared: `?vehicle=UTV` (or `ATV`, `Generator`, `Other`) for a vehicle, `?brand=RGR` for one line (older `?brand=ATV` links still work), as in `/library?q=carburetor&vehicle=ATV&year=2020`. A manual with several entries shows when one of them matches every filter that's set (an entry with no brand counts as having the brands of the manual's other entries, so the RZR 800 manual, whose 2013 models are listed under a name with no brand, shows for RZR + 2013), and a year and model have to match the same model. Year goes by the models' Year column; an entry with no dated models (a manual listed without any) goes by its Model Years text instead (`2018-2027`, `2020, 2022`). Manuals that aren't in the model list only show without filters. Search still finds pages with the GIN index first and only then filters them (`tests/manuals.test.ts` checks the plan with vehicle filters too). The filters themselves are worked out once per page load, as arrays (the matching entries, then the manuals known by their names), never as subqueries Postgres could join in and run again for every page or entry: when it underestimates a shop's list, as it does until autovacuum has gathered statistics on a fresh import, those joins took seconds to minutes on a list the size of Polaris's. For the diagnosis assistant, `manualsForModel(shopId, modelNumber)` in `src/lib/library.ts` returns the ready manuals that list a model number exactly, under any of their names.

### Setting up R2

1. In the Cloudflare dashboard, open **R2 → Create bucket** and name it, for example `forcediagnostics-manuals`. Leave public access off: no public `r2.dev` URL and no custom domain.
2. In the bucket's **Settings → CORS policy**, add this policy so browsers can upload to it and read pages from it:

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["Content-Type", "Range"],
       "ExposeHeaders": ["Content-Range", "Accept-Ranges", "Content-Length", "ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Any origin is fine here: the bucket isn't public, and every request needs a presigned signature from the app, which is the access control. CORS only decides which websites' scripts may read the responses. To narrow it anyway, list `https://www.forcediagnostics.ai` and the preview URLs instead of `*`.
3. Open **R2 → Manage API tokens → Create API token**. Give it **Object Read & Write** permission, applied to that bucket only. Copy the Access Key ID and Secret Access Key; Cloudflare shows the secret once.
4. In Vercel → Settings → Environment Variables, add these for **Production** and **Preview**, then redeploy:
   - `R2_ACCOUNT_ID`: the Cloudflare account ID (on the R2 overview page)
   - `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: from the token
   - `R2_BUCKET`: the bucket name

   Leave `R2_ENDPOINT` unset; it only points local tests at a stand-in server. Until the four are set, Manuals and the viewer say storage isn't set up, and search still works.

Do the full upload on production (www.forcediagnostics.ai). Each preview deployment has its own Neon branch, so manuals added on a preview vanish with it, while their files stay behind in the bucket. To try the uploader on a preview, use a few files, or give Preview its own `R2_BUCKET`.

### Limits

- OCR reads English, and printed text best: on test scans, 98% of all words, every part number, and most made-up fault codes (B for 8 and S for 5 are its usual slips). Tables are read cell by cell, a row to a line, without their columns lined up. Drawings and wiring diagrams give only their bigger labels, and photos and handwriting little or nothing. Pages scanned sideways read badly (it doesn't turn pages round), and fold-outs bigger than 12 million pixels at 300 dpi are read at a lower resolution. A scanned page whose PDF already has a little text on it (a page number a scanner stamped, say) counts as having text and isn't read.
- Manuals can't be deleted or renamed by hand yet, and a name linked to a manual can't be unlinked; the title comes from the model list, or else from the file name, without `.pdf` and a leading `001 - `-style number. A newer download saved under a name the library already has is added as a manual of its own, but the model list stays with the older one (the uploader says so), unless the older one never finished.
- Model-list entries can't be deleted from the app, only replaced by importing a corrected list. Brand filling goes by first letter only, so a letter two product lines share (if General and RZR model numbers both start with `Z`, say) can tip a web manual into the bigger one when that one has two-thirds of the entries.
- Up to 500 MB per file and 50,000 characters of text per page (the rest of a page is cut off).
- The upload, text reading and OCR run in the admin's browser, so keep that tab open until they finish (OCR carries on where it stopped if it doesn't). OCR keeps the computer awake only while its tab is in front; a long run with the tab hidden needs the computer set not to sleep.
- Page text and its search index take Neon storage, very roughly 5–15 KB per page: around 1 GB for 100,000 pages. Check the Neon plan's storage before a big upload.
- How much of a file the viewer fetches depends on how the PDF was made. Files from Acrobat and most publishing tools group their pages, and a page costs a few hundred KB. A file that lists every page directly under its root makes pdf.js read each page's entry when it opens, which can be most of the file for some converters' output.

## Domain

`forcediagnostics.ai` is registered with Squarespace; DNS records there point to Vercel:

| Type  | Host  | Value                                 |
| ----- | ----- | ------------------------------------- |
| A     | `@`   | `216.150.1.1`                         |
| CNAME | `www` | `99169471362ef23a.vercel-dns-016.com` |

`forcediagnostics.ai` redirects (308) to `www.forcediagnostics.ai`.
