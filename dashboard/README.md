# Crypto Revenue Dashboard — Cloudflare Workers deployment package

The dashboard, packaged to run as a **server deployment** on Jesse's
Investing Journal Worker at
`investing-journal.longfund.workers.dev/dashboard/*` — not a static
rebuild. The live pipelines (DeFiLlama revenue/buybacks, CoinGecko
prices, token rights, pair-series charting) run in the Worker exactly
as they did in the Muse artifact; only the platform shim changed.

## What changed vs the Muse artifact (and what did not)

| Muse artifact | This package |
| --- | --- |
| `defineAction` / RPC (`@hatch/space-sdk`) | Plain exported handlers in `src/worker.ts`; HTTP routes `/dashboard/api/getDashboard`, `/api/getPrices`, `/api/getPairSeries`, `/api/refreshDashboard` (GET or POST JSON; pair series also accepts query params) |
| `ctx.db` over SQLite `snapshots` | D1 binding `DB`, same table (`migrations/0001_snapshots.sql`), newest-row reads, `v !== 7` payloads ignored, prune to newest 60 after every write |
| `ctx.invalidateQueries()` | Gone — the client refetches on its own intervals, as before |
| Module-level 8s price cache | Cache API (`caches.default`, key `https://cache.internal/prices/v1`, 8s TTL) + per-isolate L1 |
| Module-level 30-min series cache | Cache API (`https://cache.internal/series/v1/<cgId>`, 30-min TTL) + per-isolate L1 |
| `space.json` managed cron, daily 06:00 | Wrangler cron trigger in `wrangler.toml` (`scheduled()` calls the refresh handler directly) |
| Client: SDK RPC client, `spaceQueryClient`, `[data-generated-space-root]` mount, `SafeAreaTopScrim` | Client: plain `fetch` to `./api/*` (`client/src/api.ts`, same call/response shapes via `client/src/types.ts`), plain `QueryClient`, normal `#root` mount, `env(safe-area-inset-top)` spacer |

Preserved exactly:

- All four actions and their request/response shapes:
  `getDashboard {}`, `getPrices {}`, `getPairSeries {baseId, quoteId, days}`,
  `refreshDashboard {}` → `{ ok, fetchedAt, error }`.
- Dashboard payload **v7** with per-source timestamps
  (`revenueFetchedAt`, `buybacksFetchedAt`, `pricesUpdatedAt` stamped
  separately, to the second).
- Top 50 by trailing-7d DeFiLlama revenue, dynamic discovery/backfill,
  chain-token + not-comparable exclusions and the claim filter, all
  applied **before** the top-50 slice; run-rate = 30d × 12; buyback =
  DeFiLlama `dailyHoldersRevenue` 30d (annualised × 12); token-rights
  radar and brief descriptions as non-fatal enrichments.
- The 15 Nov 2026 research baseline (`src/universe.ts`) as the offline
  fallback payload.
- Live behaviour: `getDashboard` auto-refreshes when the stored
  snapshot is >30 min stale; the client polls `getPrices` every ~8s;
  daily refresh at 06:00 Los Angeles time (see the DST note in
  `wrangler.toml` — cron triggers are UTC, set to 14:00 UTC = 06:00 PST,
  07:00 PDT).
- The moon / table / chart client behaviour and the owned moon artwork
  (`client/src/assets/moon-surface.webp`), byte-for-byte.

## Package contents

```
wrangler.toml                  name/routes, [assets], [[d1_databases]], [triggers] cron
migrations/0001_snapshots.sql  D1 schema (identical to the artifact's SQLite table)
src/worker.ts                  Worker entrypoint + all four handlers + pipelines (no SDK)
src/universe.ts                Token universe + 15 Nov 2026 research baseline (verbatim copy)
client/index.html              #root mount
client/build.mjs               Bun.build bundle script (no SDK)
client/src/main.tsx            Plain QueryClient + createRoot(#root)
client/src/api.ts              Plain fetch client for /dashboard/api/*
client/src/types.ts            Zod response schemas, verbatim from the server (payload v7)
client/src/App.tsx             The moon + table UI (SDK-free copy of the artifact's)
client/src/ChartModule.tsx     The charting module (unchanged)
client/src/theme.css           Theme + moon CSS (unchanged)
client/src/assets/moon-surface.webp   Owned artwork (unchanged)
public/dashboard/              Built client bundle (index.html, JS, CSS, artwork) — rebuild with `bun run build:client`
package.json                   wrangler + deps; scripts: dev / deploy / db:migrate / typecheck
tsconfig.json, client/tsconfig.json
```

Verified in-build (16 Nov 2026): `tsc --noEmit` clean for both the
Worker and the client; the client bundle builds; and the four handlers
were smoke-tested live against a D1-shaped store — `getDashboard`
returned v7 / live / exactly 50 rows with separate revenue and buyback
timestamps (HYPE #1), `getPrices` returned 50 priced rows,
`getPairSeries` BTC/USDC returned the full 5Y daily series, and
`refreshDashboard` stored snapshots and pruned correctly.

## Live-data fix (16 Nov 2026) — why prices were frozen, and the cure

Diagnosis against the deployed Worker: D1 held **zero** snapshots and
`POST /dashboard/api/getPrices` 500'd on every call. Both had one root
cause — the refresh pipeline's final step and `getPrices` both called
CoinGecko `coins/markets` bare, and **CoinGecko returns HTTP 403 to
the Cloudflare Workers egress** (the error body named the call
verbatim). Every refresh died at that last step, so no snapshot was
ever stored and the Worker served the bundled 15 Nov baseline
forever; every price poll threw the same 403 as a 500. DeFiLlama and
Coinbase calls from the same Worker succeeded throughout (charting,
which uses DeFiLlama's coins API, worked live).

The fix, in `src/worker.ts` (mirrored in the Muse artifact's
`server/src/actions.ts`):

- **Resilient market-data chain** (`fetchMarkets`, never throws):
  CoinGecko first (one retry on 429/5xx; a 401/403 trips a 10-minute
  egress-block backoff; optional `COINGECKO_API_KEY` demo key sent
  when set) → DeFiLlama `coins.llama.fi` prices/current + historical
  (price + 24h change, batched, keyed by CoinGecko id) → in the
  refresh pipeline only, CoinPaprika's tickers list fills market
  cap / supplies, accepted per symbol only when its price agrees
  with DeFiLlama's id-keyed price within 5% (FDV = price × max/total
  supply).
- **`getPrices` can no longer 500 on data**: with no snapshot it
  prices the bundled universe (first 50 research-mapped tokens);
  a D1 read failure reads as "no snapshot"; if every live source
  fails it serves the last stored prices under their original
  timestamp instead of throwing.
- **Refresh errors are observable**: every upstream failure is
  `console.error`-logged with context (visible in the Workers logs /
  `wrangler tail`), refresh results are logged by the cron handler,
  and handler responses keep carrying the error text. A refresh that
  prices nothing never overwrites a good snapshot.
- **Tolerant upstream parsing**: DeFiLlama overview totals are
  numeric-coerced per entry (a stray string/null degrades to "no
  data" instead of poisoning sums into NaN), and a malformed
  overview shape throws a labelled error naming the data type.

Re-verified in-build with CoinGecko egress simulated as blocked
(fetch stubbed to 403, the deployed condition): `getPrices` on an
empty store priced 50/50 from DeFiLlama; `refreshDashboard` stored a
snapshot via DeFiLlama + CoinPaprika; `getDashboard` served
live / exactly 50 rows (49 priced, 39 with caps). With normal
network the CoinGecko primary path is unchanged (50/50 priced with
full caps/FDV/supplies).

## Go live — the exact steps still needed

The package is complete; what remains needs Jesse's Cloudflare account
(the journal Worker lives in the public repo
`jesseellingworth-hue/investing-journal` and is deployed from there —
this sandbox has no Cloudflare credentials and no wrangler login, so
nothing here has been pushed yet).

> **Redeploy note (live-data fix):** the package was deployed once
> (journal repo `dashboard/`, D1 created) but with the pre-fix
> `src/worker.ts`. To ship the fix, copy the updated `src/worker.ts`
> (and rebuilt `public/`) into the repo's `dashboard/` and redeploy
> (`bun run deploy` there, or the repo's usual deploy). No migration
> or wrangler.toml change is needed for the fix itself.

1. **Copy the package into the journal repo**, e.g. as `dashboard/`
   (keep its internal layout). In the repo root: `cd dashboard && bun install`.
2. **Create the D1 database** (once):
   `wrangler d1 create investing-journal-dashboard`
   Put the returned `database_id` into `wrangler.toml`
   (replacing `REPLACE-WITH-D1-DATABASE-ID`), then:
   `bun run db:migrate`  (= `wrangler d1 migrations apply investing-journal-dashboard --remote`)
3. **Wire it into the journal Worker** — pick one:
   - **Option A (merge, recommended):** in the journal's own
     `wrangler.toml`, add the `[assets]`, `[[d1_databases]]` and
     `[triggers]` blocks from this package's `wrangler.toml` and the
     route `investing-journal.longfund.workers.dev/dashboard*`; in the
     journal's entrypoint, dispatch any path starting with `/dashboard`
     to this Worker's default `fetch` export (import it from
     `dashboard/src/worker.ts`). The journal's existing essay routes
     are exact paths and are matched before/independently of
     `/dashboard*` — nothing about them changes.
   - **Option B (standalone Worker, route only):** deploy this package
     as its own Worker (`bun run deploy`) and keep only the
     `/dashboard*` route pointed at it. Same URL, separate Worker.
4. **(Optional) protect the manual refresh endpoint:**
   `wrangler secret put REFRESH_SECRET` — afterwards
   `POST /dashboard/api/refreshDashboard` requires
   `Authorization: Bearer <secret>`. The cron trigger is unaffected.
   **(Optional) CoinGecko key:** `wrangler secret put COINGECKO_API_KEY`
   with a free CoinGecko demo key — the Worker sends it as
   `x-cg-demo-api-key`, which restores full CoinGecko data (FDV,
   supplies) if their WAF accepts the keyed request from Workers
   egress. Not required: the DeFiLlama + CoinPaprika fallback chain
   keeps prices and caps live without it.
5. **Deploy:** `bun run deploy` (builds the client bundle, then
   `wrangler deploy`) — or the journal repo's usual deploy if merged.
6. **Verify live:**
   - `https://investing-journal.longfund.workers.dev/dashboard/` — moon loads, terminals open table/chart.
   - `curl -X POST https://investing-journal.longfund.workers.dev/dashboard/api/getDashboard -d '{}'` — returns `"v":7`, `"status":"live"`, 50 rows.
   - Journal home and essay routes still return 200 unchanged.
   - First open seeds D1 via the >30-min staleness auto-refresh; the
     cron keeps it fresh daily thereafter.
