# Force Diagnostics

Production rates and KPI diagnostics for construction crews.

Live at [forcediagnostics.ai](https://forcediagnostics.ai).

## Stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript
- Tailwind CSS
- Hosted on Vercel

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The home page is `src/app/page.tsx`.

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

## Domain

`forcediagnostics.ai` is registered with Squarespace; DNS records there point to Vercel:

| Type  | Host  | Value                                 |
| ----- | ----- | ------------------------------------- |
| A     | `@`   | `216.150.1.1`                         |
| CNAME | `www` | `99169471362ef23a.vercel-dns-016.com` |

`forcediagnostics.ai` redirects (308) to `www.forcediagnostics.ai`.
