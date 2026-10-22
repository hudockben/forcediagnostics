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

The **Library** tab searches every page of the shop's service and owner manuals and opens them at the right page; admins add the PDFs under System Admin → **Manuals**. Manuals are licensed to the dealership, so each shop has its own library: `manuals` and `manual_pages` have a `shop_id` and row-level security like every shop table, and a file added by two shops is stored twice.

- **Files** live in a private Cloudflare R2 bucket under `shops/<shop id>/manuals/<manual id>.pdf`, reached through R2's S3-compatible API with [aws4fetch](https://github.com/mhart/aws4fetch) (`src/lib/storage.ts`). Browsers upload and download straight to and from R2 with presigned URLs, handed out only after a permission check: uploads last an hour and must be sent as `application/pdf`, downloads last 15 minutes. Files never pass through Vercel, which takes at most about 4.5 MB per request. The R2 keys stay on the server.
- **Adding** (`src/app/(app)/admin/manuals/`, `src/lib/manuals.ts`): admins choose PDFs, a whole folder, or drag them in; anything that isn't a PDF is left out. For each file the browser works out its SHA-256 and checks [pdf.js](https://mozilla.github.io/pdf.js/) can open it, then asks the server what to do. A file already in the library is skipped, whatever it's called. One that stopped part way carries on, without uploading again if the whole file already reached R2. Otherwise the browser uploads it, the server checks its size in R2, and the browser reads each page's text with pdf.js and sends it in batches, each well under the 1 MB Server Action limit. Once every page is saved the manual shows in the library and `audit_log` records it (`manual.added`). Two files go at a time. Damaged or password-protected PDFs fail with a reason and a Retry button, and the rest carry on. If the connection drops, files wait and carry on when it's back. Choosing the same folder again retries what failed and leaves the rest alone, and if the tab closes, choosing it again finishes what's left.
- **Search** (`src/lib/library.ts`) is Postgres full-text search over `manual_pages`, one row per page with a stored `tsvector` column and a GIN index. Under row-level security Postgres can't use that index (the match operator isn't leakproof), so search finds pages through the `ready_manual_pages` view (`drizzle/0010_manual_search.sql`), which belongs to the table owner and makes the same shop check itself. It takes web-search syntax: plain words (all must match), `"quoted phrases"`, `or`, `-word`. Fault codes like `P0300` and part numbers like `2205123` match as whole words. Results are the 50 best pages, with the matches highlighted.
- **Viewer** (`/library/<id>?page=N`): pdf.js draws one page at a time and fetches only the parts of the PDF that page needs with HTTP range requests, so a 100 MB manual opens on a bay tablet without downloading all of it. When its link runs out it gets a new one. Scanned-page images (CCITT, JBIG2, JPEG 2000) need pdf.js's WebAssembly decoders, which `npm run dev` and `npm run build` copy into `public/pdfjs/wasm/` (`scripts/copy-pdfjs-wasm.mjs`). **Open full PDF** goes through `/library/<id>/file`, which hands out a fresh link each time.
- **Who can:** everyone can search and read (`library.read`), including PIN sessions on bay tablets. Adding manuals needs `settings.manage`: admins, signed in with a password.

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

- No OCR yet: scanned pages with no text layer show in the viewer but search can't find them. The Manuals list says how many pages of each manual that is.
- Manuals can't be deleted or renamed yet; the title comes from the file name, without `.pdf` and a leading `001 - `-style number.
- Up to 500 MB per file and 50,000 characters of text per page (the rest of a page is cut off).
- The upload and text reading run in the admin's browser, so keep that tab open until it finishes.
- Page text and its search index take Neon storage, very roughly 5–15 KB per page: around 1 GB for 100,000 pages. Check the Neon plan's storage before a big upload.
- How much of a file the viewer fetches depends on how the PDF was made. Files from Acrobat and most publishing tools group their pages, and a page costs a few hundred KB. A file that lists every page directly under its root makes pdf.js read each page's entry when it opens, which can be most of the file for some converters' output.

## Domain

`forcediagnostics.ai` is registered with Squarespace; DNS records there point to Vercel:

| Type  | Host  | Value                                 |
| ----- | ----- | ------------------------------------- |
| A     | `@`   | `216.150.1.1`                         |
| CNAME | `www` | `99169471362ef23a.vercel-dns-016.com` |

`forcediagnostics.ai` redirects (308) to `www.forcediagnostics.ai`.
