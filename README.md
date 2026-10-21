# forcediagnostics.ai

AI repair diagnosis for powersports service departments: fault codes, photos, video and tech notes in; a ranked diagnosis, parts and labor estimate, and after-action report out.

Live at [forcediagnostics.ai](https://forcediagnostics.ai).

## Stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript
- Tailwind CSS
- Neon Postgres + Drizzle ORM
- Better Auth for sign-in
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

After sign-in staff land on the **Home** tab (`src/app/(app)/home`), where they can change their password and set a bay tablet PIN. Admins and managers also get **System Admin** (`src/app/(app)/admin`), showing only the sections their role allows:

- **Accounts** (admins): add staff (no email needed), change names and roles, reset passwords and PINs, disable and re-enable accounts. Admins can't change their own role or disable themselves, and the shop always keeps at least one active admin. Every change is written to the `audit_log` table and shown under Recent account changes.
- **Bay tablets** (managers and admins): pair and remove shared tablets, unlock locked PINs. See below.
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

## Domain

`forcediagnostics.ai` is registered with Squarespace; DNS records there point to Vercel:

| Type  | Host  | Value                                 |
| ----- | ----- | ------------------------------------- |
| A     | `@`   | `216.150.1.1`                         |
| CNAME | `www` | `99169471362ef23a.vercel-dns-016.com` |

`forcediagnostics.ai` redirects (308) to `www.forcediagnostics.ai`.
