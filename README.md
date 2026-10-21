# forcediagnostics.ai

AI repair diagnosis for powersports service departments: fault codes, photos, video and tech notes in; a ranked diagnosis, parts and labor estimate, and after-action report out.

Live at [forcediagnostics.ai](https://forcediagnostics.ai).

## Stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript
- Tailwind CSS
- Neon Postgres + Drizzle ORM
- Hosted on Vercel

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The home page is the sign-in screen (`src/app/page.tsx`); its animated topo background lives in `src/components/topo/`.

Before pushing, run:

```bash
npm run lint
npm run build
```

## Deployment

Vercel deploys automatically:

- Push to `main` → production (forcediagnostics.ai)
- Push to any other branch → preview deployment with its own URL

Build features on a branch, check the preview, then merge into `main`.

## Database

Postgres on [Neon](https://neon.com) in AWS US East 2 (Ohio), connected through Vercel's Neon integration. The integration sets `DATABASE_URL` for Production and Preview, and each preview deployment gets its own Neon branch, so test links never touch production data.

- Queries go through [Drizzle ORM](https://orm.drizzle.team) over `pg` (`src/db/`), the TCP connection pool Neon recommends for Vercel Fluid compute.
- Functions run in Vercel's `cle1` region (Cleveland, the same AWS region as the database), set in `vercel.json`.
- `GET /api/health` reports whether the app can reach the database.

For local development, copy `.env.example` to `.env.local` and fill in `DATABASE_URL`.

## Domain

`forcediagnostics.ai` is registered with Squarespace; DNS records there point to Vercel:

| Type  | Host  | Value                                 |
| ----- | ----- | ------------------------------------- |
| A     | `@`   | `216.150.1.1`                         |
| CNAME | `www` | `99169471362ef23a.vercel-dns-016.com` |

`forcediagnostics.ai` redirects (308) to `www.forcediagnostics.ai`.
