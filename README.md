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

## Sign-in

Staff sign in with company code, username and password through [Better Auth](https://better-auth.com) (`src/lib/auth.ts`); accounts, sessions and password hashes live in the Neon database. Usernames only have to be unique within a shop: they are stored as `<company code>.<username>`. There is no public sign-up.

The first shop and its admin are created once at `/setup`, which needs the one-time setup code and stops working as soon as a shop exists.

`BETTER_AUTH_SECRET` must be set in Vercel (Production and Preview). Changing it signs everyone out.

## Domain

`forcediagnostics.ai` is registered with Squarespace; DNS records there point to Vercel:

| Type  | Host  | Value                                 |
| ----- | ----- | ------------------------------------- |
| A     | `@`   | `216.150.1.1`                         |
| CNAME | `www` | `99169471362ef23a.vercel-dns-016.com` |

`forcediagnostics.ai` redirects (308) to `www.forcediagnostics.ai`.
