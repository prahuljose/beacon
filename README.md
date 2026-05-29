# Beacon

A minimal solar dashboard companion to my Flutter app, hosted at
[beacon.dpdns.org](https://beacon.dpdns.org).

Reads live data from GoodWe SEMS via a small Vercel serverless function —
credentials live server-side, never in the browser. Auto-refreshes every 15s
while the tab is visible.

## Stack

- Static HTML + Tailwind (CDN) + Chart.js (CDN). No build step.
- Two Vercel serverless functions for the SEMS proxy.
- Git → GitHub → Vercel → Cloudflare DNS → `beacon.dpdns.org`.

## Setup

### 1. Add env vars on Vercel

Project → **Settings → Environment Variables** (Production):

| Name | Value |
|---|---|
| `SEMS_EMAIL` | Your SEMS portal email |
| `SEMS_PASSWORD` | Your SEMS portal password |
| `SEMS_STATION_ID` | Your power-station UUID (find it in the SEMS portal URL) |

After adding, **redeploy** so the function picks them up.

### 2. Push

```sh
git add . && git commit -m "scaffold" && git push
```

Vercel deploys on push; the live URL updates in seconds.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/monitor` | Live station data — KPIs, inverter snapshot, environmental |
| `GET /api/pac?date=YYYY-MM-DD` | Intraday power curve samples (default: today) |

Both functions cache the SEMS session in memory while warm; cold starts log in
fresh. Each response is edge-cached for 10s + 30s stale-while-revalidate so a
warm window of rapid client polls doesn't hammer SEMS.

## Local dev

```sh
npm i -g vercel
vercel link
vercel env pull
vercel dev
```

`vercel env pull` writes the production env vars into `.env.local` for local
runs (already gitignored).

## Project layout

```
beacon/
├── index.html          dashboard markup
├── app.js              client logic (fetch + render + poll)
├── api/
│   ├── monitor.js      GET /api/monitor
│   └── pac.js          GET /api/pac
├── lib/
│   └── sems.js         shared SEMS client (login, session cache, retry)
├── package.json        type:module so api/*.js can use ESM
└── .gitignore
```
