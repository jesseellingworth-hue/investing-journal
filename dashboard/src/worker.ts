// Actions for the Crypto Revenue Live Dashboard — rebuilt around two
// separate pipelines:
//
// 1. PRICE pipeline (fast): market data for the current universe's
//    ids from a resilient source chain (see fetchMarkets below):
//    CoinGecko coins/markets first, DeFiLlama coins prices as the
//    fallback — CoinGecko 403s the deployed Worker's egress, which
//    is what froze this dashboard at its baseline — plus
//    DeFiLlama-index market caps and CoinMarketCap / CoinPaprika
//    FDV/supplies in the refresh pipeline. Server-cached for 8 seconds so
//    every viewer shares one upstream call; the client polls
//    getPrices every ~8s and updates price / market cap / FDV /
//    supplies in place. pricesUpdatedAt is stamped to the second and
//    never conflated with the revenue timestamps.
//
// 2. REVENUE / BUYBACK / LISTING pipeline (slow): DeFiLlama fees
//    overview (dailyRevenue, dailyFees, dailyHoldersRevenue) + Coinbase
//    products. Verified against the live API on 15 Nov 2026: the
//    overview returns a usable total7d per protocol (2,586 of 2,872
//    protocols carry it), so trailing-7d revenue is the API's total7d
//    summed over each parent group — no daily-point summing needed.
//    Buybacks: DeFiLlama dailyHoldersRevenue is the verified
//    pass-through source — the slice of revenue that reaches holders as
//    buybacks, burns and staker payouts (Hyperliquid: 100% of revenue,
//    all buybacks via the Assistance Fund). There is no separate
//    per-protocol real-time buyback feed; holders revenue total30d is
//    the trailing-30d buyback figure, labelled as such with its
//    composition in each row's detail. Revenue windows are trailing
//    windows ending on the last full UTC day, not the fetch instant.
//
// Universe: discovered dynamically on every revenue refresh — all
// DeFiLlama protocols grouped by parent protocol (or standalone slug),
// summed, ranked by trailing-7d protocol revenue. Research-mapped
// groups resolve through TOKEN_META (identifiers + research facts);
// every other group resolves dynamically through DeFiLlama's own
// protocol index (lite/protocols2 parentProtocols + /protocols carry
// the token symbol and CoinGecko id for ~9,000 protocols), confirmed
// against the live Coinbase USD-pair list. ALL exclusions below are
// applied BEFORE the top-50 slice, so the next qualifying protocols
// backfill and the table always shows exactly 50 tokens (verified
// live 16 Nov 2026: 58 candidates pass every filter — 25 research-
// mapped + 33 dynamically discovered).
//
// Chain exclusion (absolute — chain tokens are never shown): native
// chain tokens (ETH, SOL, BNB, POL, ARB, AVAX, SUI, NEAR, ICP, …)
// are not comparable protocols for this table. A token counts as a
// chain token when its symbol is in CHAIN_SYMBOLS or its category
// marks it as an L1/L2 chain.
//
// Not-comparable exclusion (absolute): ANY token carrying the
// research flag "not-comparable" is excluded, whatever its numbers —
// LINK (staking artefact, not Chainlink's business revenue) and
// RENDER (burn-inferred DePIN figure, not observed revenue) are the
// current cases, on top of the chain tokens that also carry it.
//
// Claim filter (absolute — no-claim rows are never shown): a row has
// a claim iff it is NOT flagged no-token-claim AND its trailing-30d
// holders revenue (buyback pass-through) is > 0. Edge cases:
// - USDT/USDC/WLFI/PAXG/RLUSD/CBETH: flagged no-token-claim — reserve
//   yield accrues to the issuer, never the token. Excluded.
// - LDO, COW, ETHFI: governance-only in DeFiLlama's data (holders
//   revenue $0) — excluded by the rule.
// - AAVE, ATH, FLUID, PYTH, KMNO, KNC, COMP: holders revenue $0 in
//   the data for the window — excluded on the data even where a
//   mechanism exists on paper (AAVE buybacks).
// - SYRUP: passes — holders revenue $0.19M (13%) retrieved in the
//   top-50 verification.
//
// Dynamically discovered rows carry no research caveat; their detail
// says so plainly (DYNAMIC_CAVEAT below) rather than borrowing one.
//
// Revenue is always DeFiLlama *protocol revenue* (fees minus
// supply-side revenue), never gross fees. Run-rate revenue =
// trailing-30d revenue x 12 (per spec). Annualised buyback =
// trailing-30d buyback x 12 (same convention, per spec).
//
// Buyback verification (15 Nov 2026, live re-check replicating this
// grouping against the live overviews): Hyperliquid holders-revenue
// 30d = revenue 30d = $69.774M exactly (100% pass-through, as
// expected). Spot checks matched: PUMP $20.80M, SKY $5.48M, AERO
// $7.31M, UNI $8.14M (100%), LINK $4.23M (100%), CAKE $2.33M,
// LIGHTER $4.46M, JUP $3.56M. Protocols ABSENT from the
// holders-revenue feed entirely (USDT, USDC, RLUSD, PYTH, ARB,
// CBETH, STG) return buyback = null, which the UI marks
// "Unverified" — never $0. Protocols present with exactly $0
// (AAVE, LDO, COW, ETHFI, ATH, FLUID, KMNO, KNC, COMP, SUI, WLFI,
// PAXG, ENS) are verified zeros.
//
// TOKEN RIGHTS (radar hexagon): verified 16 Nov 2026 — DeFiLlama
// publishes the curated token-rights dataset as a public API at
// https://api.llama.fi/token-rights (123 protocol entries; fields:
// Governance/Treasury/Revenue Decisions, Fee Switch Status, Buybacks,
// Dividends, Burns, Value Accrual + details, Utility, Associated
// Entities, Equity Revenue Capture, Last Updated). No page scraping
// needed. The UTR grade (DeFiLlama + Forgd) is NOT in this API and no
// public UTR endpoint exists (probed /utr, /ratings, /utr-scores —
// all 404), so `utr` stays null and the UI shows it only if the data
// ever carries it. Rights are manually curated and slow-moving, so
// they ride the daily revenue pipeline. A token with no rights entry
// gets rights = null and the UI renders the hexagon as "Unverified"
// with no scores — never invented ones. Axis scoring (0..1, order
// Treasury, Revenue, Burns, Equity, Value Accrual, Governance) is
// implemented in rightsFor() below and documented in DATA-PLAN.md.
//
// BRIEF DESCRIPTIONS: each row also carries a 1–2 line description of
// what the project does, from DeFiLlama's protocols data
// (api.llama.fi/protocols descriptions by slug / gecko_id, plus
// lite/protocols2 parentProtocols by parent id), cleaned and capped
// server-side in descriptionFor(). Unresolved descriptions stay null
// and render as nothing — never invented copy. Rides the revenue
// pipeline like the rights data.

// Cloudflare Workers port — see ../README.md. The Muse shim
// (defineAction, ctx.db, ctx.invalidateQueries) is gone: handlers are
// plain functions over a D1 binding, and validation uses zod directly
// (same schemas, same response shapes).
import { z } from "zod";
import { TOKEN_META, type TokenMeta } from "./universe";

export interface Env {
  // D1 database holding the snapshots table (see ../migrations).
  DB: D1Database;
  // Static client bundle (wrangler [assets] / ASSETS binding).
  ASSETS: Fetcher;
  // Optional shared secret for POST /api/refreshDashboard. The cron
  // trigger calls the refresh internally and needs no secret.
  REFRESH_SECRET?: string;
  // Optional CoinGecko demo API key (`wrangler secret put
  // COINGECKO_API_KEY`). Sent as x-cg-demo-api-key when set; the
  // price pipeline falls back to DeFiLlama prices/caps plus
  // CoinMarketCap / CoinPaprika supplies without it.
  COINGECKO_API_KEY?: string;
}

const ANNUALISE = 12;
const REV_STALE_MS = 30 * 60 * 1000;
const PRICE_CACHE_MS = 8_000;
const BASELINE_AS_OF = "2026-11-15T23:30:00.000Z";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const rightsSchema = z.object({
  scores: z.object({
    treasury: z.number(),
    revenue: z.number(),
    burns: z.number(),
    equity: z.number(),
    valueAccrual: z.number(),
    governance: z.number(),
  }),
  primaryAccrual: z.string(),
  primaryAccrualDetail: z.string(),
  utility: z.array(z.string()),
  utr: z.string().nullable(),
  governanceToken: z.string(),
  treasuryToken: z.string(),
  revenueToken: z.string(),
  feeSwitch: z.string(),
  buybacks: z.string(),
  dividends: z.string(),
  burns: z.string(),
  equityCapture: z.string(),
  entities: z.string(),
  updated: z.string().nullable(),
});

const rowSchema = z.object({
  symbol: z.string(),
  project: z.string(),
  category: z.string(),
  cgId: z.string(),
  rank: z.number(),
  hasClaim: z.boolean(),
  claimNote: z.string(),
  price: z.number().nullable(),
  priceChange24hPct: z.number().nullable(),
  marketCapM: z.number().nullable(),
  fdvM: z.number().nullable(),
  circSupply: z.number().nullable(),
  totalSupply: z.number().nullable(),
  circPct: z.number().nullable(),
  rev7dM: z.number().nullable(),
  rev30dM: z.number().nullable(),
  runRateRevM: z.number().nullable(),
  growthPct: z.number().nullable(),
  fees30dM: z.number().nullable(),
  retentionPct: z.number().nullable(),
  buyback30dM: z.number().nullable(),
  buybackAnnM: z.number().nullable(),
  holdersPct: z.number().nullable(),
  ttmRevM: z.number().nullable(),
  pRunRate: z.number().nullable(),
  pRunRateFdv: z.number().nullable(),
  pTtm: z.number().nullable(),
  pBuyback: z.number().nullable(),
  pBuybackFdv: z.number().nullable(),
  listing: z.string(),
  pairLive: z.boolean().nullable(),
  flag: z.string().nullable(),
  revenueIs: z.string(),
  caveat: z.string(),
  description: z.string().nullable(),
  rights: rightsSchema.nullable(),
});

const dashboardResponse = z.object({
  v: z.literal(7),
  status: z.enum(["live", "baseline", "empty"]),
  revenueFetchedAt: z.string().nullable(),
  buybacksFetchedAt: z.string().nullable(),
  revenueWindowEnd: z.string().nullable(),
  pricesUpdatedAt: z.string().nullable(),
  rows: z.array(rowSchema),
  totals: z.object({
    shown: z.number(),
    excludedNoClaim: z.number(),
    totalRev7dM: z.number(),
    totalRev30dM: z.number(),
    totalBuyback30dM: z.number(),
  }),
  error: z.string().nullable(),
});

const pricesResponse = z.object({
  pricesUpdatedAt: z.string(),
  prices: z.array(
    z.object({
      cgId: z.string(),
      price: z.number().nullable(),
      priceChange24hPct: z.number().nullable(),
      marketCapM: z.number().nullable(),
      fdvM: z.number().nullable(),
      circSupply: z.number().nullable(),
      totalSupply: z.number().nullable(),
    }),
  ),
});

type DashboardPayload = z.infer<typeof dashboardResponse>;
type Row = z.infer<typeof rowSchema>;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  constructor(url: string, status: number) {
    super(`${url} -> HTTP ${status}`);
    this.status = status;
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new HttpError(url, res.status);
  return (await res.json()) as unknown;
}

// Every upstream failure is logged with its context (the message
// always names the failing URL and HTTP status) so a broken refresh
// is observable in the Worker logs instead of failing silently, and
// the handlers below also surface it in their response payloads.
function logError(context: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[crypto-dashboard] ${context}: ${message}`);
}

// Coerce an unknown JSON value to a finite number or null. Upstream
// APIs occasionally ship totals as strings or omit them; arithmetic
// on a raw cast would poison group sums with NaN and fail the
// response-schema check at the edge, so every upstream number that
// feeds a computed field passes through here.
function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface LlamaEntry {
  slug?: string;
  parentProtocol?: string;
  total7d?: number | null;
  total30d?: number | null;
  total60dto30d?: number | null;
  total1y?: number | null;
}

async function fetchLlama(dataType: string): Promise<LlamaEntry[]> {
  const data = (await fetchJson(
    `https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=${dataType}`,
  )) as { protocols?: unknown };
  if (!Array.isArray(data.protocols)) {
    throw new Error(
      `defillama overview ${dataType}: response has no protocols array`,
    );
  }
  // Tolerant parsing: totals arrive as numbers in the verified API,
  // but a stray string or missing field degrades to "no data" for
  // that entry instead of poisoning a group sum.
  return (data.protocols as Array<Record<string, unknown>>).map((p) => ({
    slug: typeof p.slug === "string" ? p.slug : undefined,
    parentProtocol:
      typeof p.parentProtocol === "string" ? p.parentProtocol : undefined,
    total7d: numOrNull(p.total7d),
    total30d: numOrNull(p.total30d),
    total60dto30d: numOrNull(p.total60dto30d),
    total1y: numOrNull(p.total1y),
  }));
}

interface CgMarket {
  id: string;
  current_price?: number | null;
  market_cap?: number | null;
  fully_diluted_valuation?: number | null;
  circulating_supply?: number | null;
  total_supply?: number | null;
  price_change_percentage_24h?: number | null;
}

// ---------------------------------------------------------------------------
// Market data (price / caps / supplies) — resilient source chain
// ---------------------------------------------------------------------------
//
// CoinGecko is the primary source (full data in one call), but it is
// NOT reachable from every egress: verified live 16 Nov 2026, the
// deployed Cloudflare Worker gets HTTP 403 on every CoinGecko call
// while DeFiLlama and Coinbase succeed from the same egress — that
// single failure killed every refresh (no snapshot was ever stored)
// and 500'd every getPrices call. So market data comes from a chain:
//
//  1. CoinGecko coins/markets — full data. 429/5xx get one retry
//     with backoff; a 401/403 (egress block) trips a 10-minute
//     backoff so the fallback path stays fast. An optional demo API
//     key (COINGECKO_API_KEY secret) is sent when configured, which
//     also lifts the block on some egress networks.
//  2. DeFiLlama coins prices (coins.llama.fi — the same API family
//     the charting module uses, verified reachable from the Worker):
//     current price for every id in one batched call, 24h change
//     from the batched historical call. Identity-safe: keyed by the
//     exact CoinGecko id.
//  3. Rich mode only (the refresh pipeline): market cap comes FIRST
//     from DeFiLlama's own protocol index — lite/protocols2
//     parentProtocols + /protocols carry an `mcap` per CoinGecko id,
//     fetched on the same api.llama.fi calls the description index
//     already makes (verified live 16 Nov 2026: every claim-filtered
//     universe token resolves; HYPE $15.84B, PUMP $1.34B, SKY $1.26B
//     all match the research baseline). FDV / supplies come next
//     from CoinMarketCap's public listing (see fetchCmcCaps):
//     DeFiLlama's free API publishes no supply or FDV field
//     anywhere (probed exhaustively — protocols, lite/protocols2,
//     per-protocol detail, coins prices/chart; the emissions
//     dataset is paywalled), while the previous sole FDV source,
//     CoinPaprika, returns 4xx from the deployed Worker's egress
//     and left FDV null for all 50 rows. CoinPaprika is kept only
//     as a fallback that fills the symbols the CoinMarketCap leg
//     misses (bulk tickers first, then per token: search → ticker).
//     Both are keyed by symbol, so a row is accepted only when the
//     source's own price agrees with DeFiLlama's id-keyed price
//     within 5% — a symbol collision can never attach the wrong
//     project's supply. FDV = live price × the fully diluted
//     supply each source reports (see SupplyCap).
//
// fetchMarkets never throws: on total failure it returns an empty
// map plus the combined error, and each caller decides what that
// means (refresh keeps the previous snapshot; getPrices serves the
// last stored prices). Every failover is logged.

export interface MarketTarget {
  id: string;
  symbol: string;
  // Project name, used only to disambiguate the per-token
  // CoinPaprika search (e.g. the dashboard's LIGHTER is Paprika's
  // LIT, and CARD is Paprika's CARDS "Collector Crypt").
  name?: string;
}

interface MarketsResult {
  map: Map<string, CgMarket>;
  source:
    | "coingecko"
    | "defillama"
    | "defillama+cmc"
    | "defillama+coinpaprika"
    | "defillama+cmc+coinpaprika"
    | "none";
  error: string | null;
}

let cgBlockedUntil = 0;

async function fetchCgMarketsOnce(
  ids: string[],
  apiKey?: string,
): Promise<Map<string, CgMarket>> {
  const headers: Record<string, string> = {
    "user-agent": "Mozilla/5.0 (compatible; CryptoRevenueDashboard/1.0)",
  };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  const raw = await fetchJson(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(",")}&price_change_percentage=24h`,
    headers,
  );
  const map = new Map<string, CgMarket>();
  if (Array.isArray(raw)) {
    for (const m of raw as Array<Record<string, unknown>>) {
      if (typeof m.id !== "string") continue;
      map.set(m.id, {
        id: m.id,
        current_price: numOrNull(m.current_price),
        market_cap: numOrNull(m.market_cap),
        fully_diluted_valuation: numOrNull(m.fully_diluted_valuation),
        circulating_supply: numOrNull(m.circulating_supply),
        total_supply: numOrNull(m.total_supply),
        price_change_percentage_24h: numOrNull(m.price_change_percentage_24h),
      });
    }
  }
  return map;
}

interface LlamaPrice {
  price: number;
  timestamp: number;
}

async function fetchLlamaPrices(
  ids: string[],
  atSec?: number,
): Promise<Map<string, LlamaPrice>> {
  const keys = ids.map((id) => `coingecko:${encodeURIComponent(id)}`).join(",");
  const path = atSec ? `prices/historical/${atSec}` : "prices/current";
  const raw = (await fetchJson(`https://coins.llama.fi/${path}/${keys}`)) as {
    coins?: Record<string, { price?: unknown; timestamp?: unknown }>;
  };
  const out = new Map<string, LlamaPrice>();
  for (const id of ids) {
    const c = raw.coins?.[`coingecko:${id}`];
    const price = numOrNull(c?.price);
    if (c && price != null && price > 0) {
      out.set(id, { price, timestamp: numOrNull(c.timestamp) ?? 0 });
    }
  }
  return out;
}

// One supply record, normalised across the FDV sources below
// (CoinMarketCap listing, CoinPaprika tickers). fdvSupply is the
// supply the FDV is computed on — one definition for every source,
// CoinGecko's: total supply, falling back to max supply only when
// no total exists.
interface SupplyCap {
  marketCap: number;
  totalSupply: number | null;
  maxSupply: number | null;
  fdvSupply: number | null;
  price: number;
}

// CoinPaprika sits behind the same kind of bot filtering as
// CoinGecko: every Paprika call carries a browser User-Agent. The
// original caps fetch sent none, and its single bulk tickers call
// returned 4xx from the deployed Worker on every refresh — the
// direct cause of marketCapM/fdvM being null for all 50 tokens
// while prices (DeFiLlama) stayed live.
const PAPRIKA_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (compatible; CryptoRevenueDashboard/1.0)",
};

function paprikaCapFromTicker(t: Record<string, unknown>): SupplyCap | null {
  const quotes = t.quotes as
    | { USD?: { price?: unknown; market_cap?: unknown } }
    | undefined;
  const price = numOrNull(quotes?.USD?.price);
  const marketCap = numOrNull(quotes?.USD?.market_cap);
  const totalSupply = numOrNull(t.total_supply);
  const maxSupply = numOrNull(t.max_supply);
  if (price == null || price <= 0) return null;
  // Some tickers report market_cap 0 / total_supply 0 while still
  // carrying a usable max supply (DBR: cap 0, max 10B) — the cap is
  // worth keeping for its FDV supply alone. marketCap stays 0 in
  // that case and the caller only uses it when positive (the
  // DeFiLlama mcap index is the cap of record anyway).
  if (
    (marketCap == null || marketCap <= 0) &&
    (totalSupply == null || totalSupply <= 0) &&
    (maxSupply == null || maxSupply <= 0)
  ) {
    return null;
  }
  return {
    marketCap: marketCap != null && marketCap > 0 ? marketCap : 0,
    totalSupply,
    maxSupply,
    fdvSupply: totalSupply != null && totalSupply > 0 ? totalSupply : maxSupply,
    price,
  };
}

async function fetchPaprikaCaps(
  symbols: Set<string>,
): Promise<Map<string, SupplyCap>> {
  const raw = await fetchJson(
    "https://api.coinpaprika.com/v1/tickers?quotes=USD",
    PAPRIKA_HEADERS,
  );
  const best = new Map<
    string,
    { rank: number; t: Record<string, unknown> }
  >();
  if (Array.isArray(raw)) {
    for (const t of raw as Array<Record<string, unknown>>) {
      if (typeof t.symbol !== "string" || !symbols.has(t.symbol)) continue;
      const rank = numOrNull(t.rank) ?? Number.MAX_SAFE_INTEGER;
      const prev = best.get(t.symbol);
      if (!prev || rank < prev.rank) best.set(t.symbol, { rank, t });
    }
  }
  const out = new Map<string, SupplyCap>();
  for (const [symbol, { t }] of best) {
    const cap = paprikaCapFromTicker(t);
    if (cap) out.set(symbol, cap);
  }
  return out;
}

// Per-token CoinPaprika fallback: when the bulk tickers call fails
// (or omits a symbol), each missing token is resolved individually —
// a search call resolves candidate Paprika ids (ids are NOT
// derivable from CoinGecko ids: AAVE is "aave-new", PUMP is
// "pump-pumpfun", DRV is "drv7-derive"), then the per-coin ticker
// endpoint (a ~1KB response, far more likely to survive egress
// filtering than the 1.7MB bulk list) returns price / market cap /
// supplies. Two traps in the search data, both verified live:
// inactive entries carry rank 0 (below every real rank, so a naive
// "lowest rank wins" picks dead copycat tokens), and several
// symbols have live copycats — so candidates must be active with a
// positive rank, and a candidate's cap is accepted only when its
// own price agrees with the token's DeFiLlama price within 5%.
// Winning ids are cached per isolate so repeat refreshes skip the
// search. Every failure is per-token and non-fatal.
const paprikaIdCache = new Map<string, string>();

// Dashboard symbol → CoinPaprika symbol where they differ (mirrors
// RIGHTS_SYMBOL_ALIAS: Collector Crypt's token is CARDS on
// CoinPaprika; the dashboard uses the Coinbase symbol CARD).
const PAPRIKA_SYMBOL_ALIAS: Record<string, string> = { CARD: "CARDS" };

async function searchPaprikaCandidates(
  query: string,
  target: MarketTarget,
): Promise<string[]> {
  const raw = (await fetchJson(
    `https://api.coinpaprika.com/v1/search/?q=${encodeURIComponent(query)}&c=currencies&limit=10`,
    PAPRIKA_HEADERS,
  )) as { currencies?: Array<Record<string, unknown>> };
  const currencies = Array.isArray(raw.currencies) ? raw.currencies : [];
  const alias = PAPRIKA_SYMBOL_ALIAS[target.symbol] ?? target.symbol;
  const nameLc = target.name?.trim().toLowerCase();
  const accepted: Array<{ id: string; rank: number }> = [];
  for (const c of currencies) {
    if (typeof c.id !== "string") continue;
    if (c.is_active === false) continue;
    const rank = numOrNull(c.rank) ?? 0;
    if (rank <= 0) continue;
    const sym = typeof c.symbol === "string" ? c.symbol : "";
    const nm = typeof c.name === "string" ? c.name.trim().toLowerCase() : "";
    if (sym !== target.symbol && sym !== alias && (!nameLc || nm !== nameLc)) {
      continue;
    }
    accepted.push({ id: c.id, rank });
  }
  accepted.sort((a, b) => a.rank - b.rank);
  return accepted.map((a) => a.id);
}

async function fetchPaprikaCapsPerToken(
  targets: MarketTarget[],
  priceById: Map<string, number>,
): Promise<Map<string, SupplyCap>> {
  const out = new Map<string, SupplyCap>();
  const BATCH = 8;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (t) => {
        try {
          const knownPrice = priceById.get(t.id);
          let candidateIds: string[] = [];
          const cachedId = paprikaIdCache.get(t.symbol);
          if (cachedId) {
            candidateIds = [cachedId];
          } else {
            const queries = [PAPRIKA_SYMBOL_ALIAS[t.symbol] ?? t.symbol];
            if (t.name && t.name !== queries[0]) queries.push(t.name);
            for (const q of queries) {
              try {
                for (const id of await searchPaprikaCandidates(q, t)) {
                  if (!candidateIds.includes(id)) candidateIds.push(id);
                }
              } catch (e) {
                logError(`markets: coinpaprika search failed for ${t.symbol}`, e);
              }
              if (candidateIds.length >= 4) break;
            }
            candidateIds = candidateIds.slice(0, 4);
          }
          for (const id of candidateIds) {
            try {
              const raw = (await fetchJson(
                `https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(id)}?quotes=USD`,
                PAPRIKA_HEADERS,
              )) as Record<string, unknown>;
              const cap = paprikaCapFromTicker(raw);
              if (!cap) continue;
              if (
                knownPrice != null &&
                Math.abs(cap.price - knownPrice) / knownPrice > 0.05
              ) {
                continue; // a copycat namesake — try the next candidate
              }
              paprikaIdCache.set(t.symbol, id);
              out.set(t.symbol, cap);
              break;
            } catch {
              // Dead candidate id (search lists ids the ticker
              // endpoint 404s): fall through to the next candidate.
              continue;
            }
          }
        } catch (e) {
          logError(`markets: coinpaprika per-token failed for ${t.symbol}`, e);
        }
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// FDV / supplies — CoinMarketCap public listing (primary rich-mode leg)
// ---------------------------------------------------------------------------
//
// Why not DeFiLlama for supplies: probed exhaustively 16 Nov 2026 —
// DeFiLlama's free API publishes NO total/max supply or FDV field
// anywhere (api.llama.fi/protocols, lite/protocols2 at both levels,
// /protocol/{slug}, and coins.llama.fi prices/chart all carry price
// and market cap only; the emissions/unlocks dataset that tracks
// supplies is paywalled, HTTP 402). DeFiLlama therefore stays the
// price + market-cap backbone (both proven live from the deployed
// Worker's egress), and the FDV supply leg comes from
// CoinMarketCap's public listing API — the same unauthenticated
// endpoint the coinmarketcap.com website itself loads
// (data-api/v3/cryptocurrency/listing, top 1000 by market cap per
// call; a second page, ranks 1001–2000, is fetched only when a
// target is still unresolved — INV, SD, QUICK, SWELL, DEXT and
// INDEX all sit just past rank 1000). Its total supplies track
// CoinGecko's to four
// significant figures (HYPE 949.74M vs CoinGecko 949.86M; UNI
// 885.85M on both), and FDV follows CoinGecko's definition: the
// live DeFiLlama price × total supply (max supply only when no
// total exists). Matching is by symbol (best cmcRank, active
// entries only) or by exact project name — the name match is what
// resolves LIGHTER to CMC's LIT listing — and a candidate is
// accepted only when its own price agrees with the token's
// DeFiLlama price within 5%, so a symbol collision can never
// attach the wrong project's supply. One call per refresh; failure
// is non-fatal (the CoinPaprika fallback below fills what it can).
const CMC_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// Dashboard symbol → CoinMarketCap symbol where they differ
// (Collector Crypt's token is CARDS on CoinMarketCap, as on
// CoinPaprika; the dashboard uses the Coinbase symbol CARD).
const CMC_SYMBOL_ALIAS: Record<string, string> = { CARD: "CARDS" };

async function fetchCmcCaps(
  targets: MarketTarget[],
  priceById: Map<string, number>,
): Promise<Map<string, SupplyCap>> {
  const candidates = new Map<string, Array<{ rank: number; cap: SupplyCap }>>();
  for (const t of targets) candidates.set(t.symbol, []);
  const collect = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const e of list as Array<Record<string, unknown>>) {
      if (e.isActive === 0 || e.isActive === false) continue;
      const sym = typeof e.symbol === "string" ? e.symbol : "";
      const nameLc =
        typeof e.name === "string" ? e.name.trim().toLowerCase() : "";
      const quotes = Array.isArray(e.quotes) ? e.quotes : [];
      const q = (quotes[0] ?? {}) as Record<string, unknown>;
      const price = numOrNull(q.price);
      if (price == null || price <= 0) continue;
      const totalSupply = numOrNull(e.totalSupply);
      const maxSupply = numOrNull(e.maxSupply);
      if (
        (totalSupply == null || totalSupply <= 0) &&
        (maxSupply == null || maxSupply <= 0)
      ) {
        continue;
      }
      const marketCap = numOrNull(q.marketCap);
      const cap: SupplyCap = {
        marketCap: marketCap != null && marketCap > 0 ? marketCap : 0,
        totalSupply,
        maxSupply,
        fdvSupply:
          totalSupply != null && totalSupply > 0 ? totalSupply : maxSupply,
        price,
      };
      const rank = numOrNull(e.cmcRank) ?? Number.MAX_SAFE_INTEGER;
      for (const t of targets) {
        const alias = CMC_SYMBOL_ALIAS[t.symbol] ?? t.symbol;
        const nameMatch =
          t.name != null &&
          nameLc !== "" &&
          nameLc === t.name.trim().toLowerCase();
        if (sym === t.symbol || sym === alias || nameMatch) {
          candidates.get(t.symbol)?.push({ rank, cap });
        }
      }
    }
  };
  const accept = (): Map<string, SupplyCap> => {
    const out = new Map<string, SupplyCap>();
    for (const t of targets) {
      const known = priceById.get(t.id);
      const ranked = (candidates.get(t.symbol) ?? []).sort(
        (a, b) => a.rank - b.rank,
      );
      for (const c of ranked) {
        if (known != null && Math.abs(c.cap.price - known) / known > 0.05) {
          continue; // a copycat namesake — try the next candidate
        }
        out.set(t.symbol, c.cap);
        break;
      }
    }
    return out;
  };
  const page = async (start: number) => {
    const raw = (await fetchJson(
      `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing?start=${start}&limit=1000&sortBy=market_cap&sortType=desc&convert=USD&cryptoType=all&tagType=all&audited=false`,
      CMC_HEADERS,
    )) as { data?: { cryptoCurrencyList?: unknown } };
    collect(raw.data?.cryptoCurrencyList);
  };
  await page(1);
  let out = accept();
  if (targets.some((t) => !out.has(t.symbol))) {
    try {
      await page(1001);
      out = accept();
    } catch (e) {
      logError("markets: coinmarketcap page 2 failed", e);
    }
  }
  return out;
}

async function fetchMarkets(
  targets: MarketTarget[],
  opts: { rich: boolean; cgApiKey?: string; llamaCaps?: Map<string, number> },
): Promise<MarketsResult> {
  const ids = targets.map((t) => t.id);
  if (ids.length === 0) return { map: new Map(), source: "none", error: null };
  let cgError: string | null = null;

  if (Date.now() < cgBlockedUntil) {
    cgError = "coingecko markets skipped (egress-block backoff)";
  } else {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const map = await fetchCgMarketsOnce(ids, opts.cgApiKey);
        if (map.size > 0) return { map, source: "coingecko", error: null };
        cgError = "coingecko markets: empty response";
        break;
      } catch (e) {
        cgError = e instanceof Error ? e.message : String(e);
        const status = e instanceof HttpError ? e.status : 0;
        if (status === 401 || status === 403) {
          cgBlockedUntil = Date.now() + 10 * 60 * 1000;
          break;
        }
        if (attempt === 0 && (status === 429 || status >= 500 || status === 0)) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        break;
      }
    }
  }

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const [current, dayAgo] = await Promise.all([
      fetchLlamaPrices(ids),
      fetchLlamaPrices(ids, nowSec - 86_400).catch(
        () => new Map<string, LlamaPrice>(),
      ),
    ]);
    if (current.size === 0) {
      throw new Error("defillama prices/current: no prices returned");
    }
    let caps = new Map<string, SupplyCap>();
    let source: MarketsResult["source"] = "defillama";
    if (opts.rich) {
      const priceById = new Map<string, number>();
      for (const t of targets) {
        const p = current.get(t.id);
        if (p) priceById.set(t.id, p.price);
      }
      // FDV / supplies, primary leg: CoinMarketCap's public listing
      // (one call, a second page when needed) — see fetchCmcCaps.
      let cmcCount = 0;
      try {
        const cmcCaps = await fetchCmcCaps(targets, priceById);
        for (const [symbol, cap] of cmcCaps) caps.set(symbol, cap);
        cmcCount = cmcCaps.size;
      } catch (e) {
        logError("markets: coinmarketcap caps failed", e);
      }
      // CoinPaprika is a fallback only: it fills the symbols the
      // CoinMarketCap leg missed — bulk tickers first, then per
      // token (search + per-coin ticker, each candidate's price
      // checked against the DeFiLlama price before acceptance).
      let paprikaCount = 0;
      const bulkMissing = targets.filter((t) => !caps.has(t.symbol));
      if (bulkMissing.length > 0) {
        try {
          const bulk = await fetchPaprikaCaps(
            new Set(bulkMissing.map((t) => t.symbol)),
          );
          for (const [symbol, cap] of bulk) {
            if (!caps.has(symbol)) {
              caps.set(symbol, cap);
              paprikaCount++;
            }
          }
        } catch (e) {
          logError("markets: coinpaprika bulk caps failed", e);
        }
        const missing = targets.filter((t) => !caps.has(t.symbol));
        if (missing.length > 0) {
          try {
            const perToken = await fetchPaprikaCapsPerToken(missing, priceById);
            for (const [symbol, cap] of perToken) {
              if (!caps.has(symbol)) {
                caps.set(symbol, cap);
                paprikaCount++;
              }
            }
          } catch (e) {
            logError("markets: coinpaprika per-token caps failed", e);
          }
        }
      }
      if (cmcCount > 0 && paprikaCount > 0) {
        source = "defillama+cmc+coinpaprika";
      } else if (cmcCount > 0) {
        source = "defillama+cmc";
      } else if (paprikaCount > 0) {
        source = "defillama+coinpaprika";
      }
    }
    const map = new Map<string, CgMarket>();
    for (const t of targets) {
      const cur = current.get(t.id);
      if (!cur) continue;
      const prev = dayAgo.get(t.id);
      const entry: CgMarket = {
        id: t.id,
        current_price: cur.price,
        price_change_percentage_24h:
          prev && prev.price > 0
            ? ((cur.price - prev.price) / prev.price) * 100
            : null,
        market_cap: null,
        fully_diluted_valuation: null,
        circulating_supply: null,
        total_supply: null,
      };
      // Market cap first from DeFiLlama's protocol index (keyed by
      // the exact CoinGecko id, from the same llama fetches the
      // refresh already made — the source proven to work from the
      // deployed Worker's egress). Circulating supply derives from
      // cap ÷ the id-keyed DeFiLlama price.
      const llamaMcap = opts.llamaCaps?.get(t.id);
      if (llamaMcap != null && llamaMcap > 0) {
        entry.market_cap = llamaMcap;
        entry.circulating_supply = llamaMcap / cur.price;
      }
      const cap = caps.get(t.symbol);
      if (cap && Math.abs(cap.price - cur.price) / cur.price <= 0.05) {
        if (entry.market_cap == null && cap.marketCap > 0) {
          entry.market_cap = cap.marketCap;
          entry.circulating_supply = cap.marketCap / cur.price;
        }
        entry.total_supply = cap.totalSupply;
        entry.fully_diluted_valuation =
          cap.fdvSupply != null && cap.fdvSupply > 0
            ? cur.price * cap.fdvSupply
            : null;
      }
      map.set(t.id, entry);
    }
    if (cgError) {
      logError(
        "markets: coingecko unavailable, served by fallback",
        new Error(`${cgError} (fallback: ${source})`),
      );
    }
    return { map, source, error: cgError };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const combined = `coingecko: ${cgError ?? "not tried"}; defillama: ${msg}`;
    logError("markets: all price sources failed", new Error(combined));
    return { map: new Map(), source: "none", error: combined };
  }
}

// ---------------------------------------------------------------------------
// Universe discovery + claim rule
// ---------------------------------------------------------------------------

const META_BY_PARENT = new Map<string, TokenMeta>();
const META_BY_SLUG = new Map<string, TokenMeta>();
for (const m of TOKEN_META) {
  for (const p of m.parents) META_BY_PARENT.set(`parent#${p}`, m);
  for (const s of m.slugs) META_BY_SLUG.set(s, m);
}

function resolveMeta(e: LlamaEntry): TokenMeta | null {
  if (e.parentProtocol) {
    const byParent = META_BY_PARENT.get(e.parentProtocol);
    if (byParent) return byParent;
  }
  if (e.slug) {
    const bySlug = META_BY_SLUG.get(e.slug);
    if (bySlug) return bySlug;
  }
  return null;
}

interface GroupSum {
  rev7d: number;
  rev30d: number;
  prev30d: number;
  ttm: number;
  found: boolean;
}

function sumByToken(entries: LlamaEntry[]): Map<string, GroupSum> {
  const out = new Map<string, GroupSum>();
  for (const e of entries) {
    const meta = resolveMeta(e);
    if (!meta) continue;
    let g = out.get(meta.symbol);
    if (!g) {
      g = { rev7d: 0, rev30d: 0, prev30d: 0, ttm: 0, found: false };
      out.set(meta.symbol, g);
    }
    g.found = true;
    g.rev7d += e.total7d ?? 0;
    g.rev30d += e.total30d ?? 0;
    g.prev30d += e.total60dto30d ?? 0;
    g.ttm += e.total1y ?? 0;
  }
  return out;
}

// Native chain tokens excluded from the table outright. The symbol
// set covers every chain token in the mapped universe plus the
// well-known native L1/L2 tokens a dynamically discovered group
// could resolve to (e.g. Aptos's canonical-bridge group resolves to
// APT — a chain token whatever the group's category says); the
// category check catches any other chain token (its category reads
// "L1 chain", "L2 chain", "L1 / …", etc.).
const CHAIN_SYMBOLS = new Set([
  "ETH",
  "SOL",
  "BNB",
  "POL",
  "ARB",
  "AVAX",
  "SUI",
  "NEAR",
  "ICP",
  "APT",
  "ATOM",
  "DOT",
  "ADA",
  "XRP",
  "TRX",
  "TON",
  "XLM",
  "HBAR",
  "ALGO",
  "XTZ",
  "SEI",
  "INJ",
  "TIA",
  "STX",
  "FIL",
  "KAS",
  "ZEC",
  "BERA",
  "MOVE",
  "EGLD",
  "FLOW",
  "KAVA",
  "THETA",
  "ETC",
  "BCH",
  "LTC",
  "DOGE",
]);

function isChainToken(meta: TokenMeta): boolean {
  if (CHAIN_SYMBOLS.has(meta.symbol)) return true;
  return /^L[12]\b/i.test(meta.category) || /\bchain\b/i.test(meta.category);
}

// Absolute exclusions, applied before ranking in both payload
// builders: native chain tokens, and ANY token the research flags
// "not-comparable" (LINK, RENDER, and the chain tokens carrying the
// same flag). An excluded token's protocol group is also consumed —
// it can never re-enter through dynamic discovery.
function isExcludedToken(meta: TokenMeta): boolean {
  return isChainToken(meta) || meta.flag === "not-comparable";
}

function claimFor(
  meta: TokenMeta,
  holders30dM: number | null,
): { hasClaim: boolean; note: string } {
  if (meta.flag === "no-claim" || meta.flag === "no-token-claim") {
    return {
      hasClaim: false,
      note: "No claim: reserve yield accrues to the issuer, not the token.",
    };
  }
  if (holders30dM != null && holders30dM > 0) {
    return {
      hasClaim: true,
      note: `Claim: $${holders30dM.toFixed(2)}M of revenue reached holders in 30d (buybacks, burns, staker payouts).`,
    };
  }
  if (holders30dM == null) {
    return {
      hasClaim: false,
      note: "No claim in the data: this protocol does not appear in DeFiLlama's holders-revenue feed at all — its buyback is unverified, not $0.",
    };
  }
  return {
    hasClaim: false,
    note: "No claim in the data: DeFiLlama reports $0 holders revenue (buyback pass-through) for the trailing 30d — governance/treasury only.",
  };
}

// ---------------------------------------------------------------------------
// Token rights (DeFiLlama token-rights API) + radar scoring
// ---------------------------------------------------------------------------

type RightsEntry = Record<string, unknown>;
type Rights = z.infer<typeof rightsSchema>;

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function asText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(", ");
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  return "";
}

// Does a rights decision field name this token (directly, or in its
// locked/staked form — veCRV, sAERO, stDRV, xORCA…)?
function controlsToken(field: unknown, symbol: string): boolean {
  for (const entry of asList(field)) {
    if (entry === symbol) return true;
    const stripped = entry.replace(/^(ve|vl|st|s|x)/i, "");
    if (stripped === symbol) return true;
  }
  return false;
}

function displayTokens(field: unknown): string {
  const list = asList(field).filter((t) => t !== "N/A" && t !== "None");
  return list.length > 0 ? list.join(", ") : "None";
}

// Radar axis scores, 0..1, from the DeFiLlama rights entry plus the
// live holders-revenue pass-through (holdersPct, 0..100):
// - Treasury: 1 if the token (or its ve/staked form) decides treasury
//   allocation; 0.5 if the protocol has no treasury at all (revenue
//   flows straight to holders); else 0.
// - Revenue: 1 if the token decides revenue allocation; 0.5 if the
//   fee switch is ON (revenue reaches holders but they don't decide);
//   0.25 if PENDING; else 0.
// - Burns: 0 if burns are not active; if active, 0.5 + 0.5 × the
//   pass-through share (burn size relative to revenue).
// - Equity: how cleanly value stays with the token vs separate equity
//   holders — Equity Revenue Capture No/None = 1, Partial = 0.5,
//   Yes = 0.1, Unknown = 0.25.
// - Value Accrual: the live pass-through itself — holders revenue ÷
//   protocol revenue (30d). Falls back to 0.3 when a mechanism is
//   reported but no live pass-through figure exists, 0 when the
//   rights data reports no mechanism.
// - Governance: 1 if the token decides governance; else 0.
function rightsFor(
  entry: RightsEntry | null,
  symbol: string,
  holdersPct: number | null,
): Rights | null {
  if (!entry) return null;
  const pass = holdersPct != null ? Math.min(1, Math.max(0, holdersPct / 100)) : null;

  const treasuryControls = controlsToken(entry["Treasury Decisions"], symbol);
  const treasuryDetails = asText(entry["Treasury Details"]);
  const treasury = treasuryControls
    ? 1
    : /has no treasury|no treasury/i.test(treasuryDetails)
      ? 0.5
      : 0;

  const revenueControls = controlsToken(entry["Revenue Decisions"], symbol);
  const feeSwitchRaw = asText(entry["Fee Switch Status"]);
  const revenue = revenueControls
    ? 1
    : feeSwitchRaw === "ON"
      ? 0.5
      : feeSwitchRaw === "PENDING"
        ? 0.25
        : 0;

  const burnsRaw = asText(entry["Burns"]);
  const burns =
    burnsRaw === "Active" ? (pass != null ? 0.5 + 0.5 * pass : 0.75) : 0;

  const equityRaw = asText(entry["Equity Revenue Capture"]);
  const equity =
    equityRaw === "No" || equityRaw === "None"
      ? 1
      : equityRaw === "Partial"
        ? 0.5
        : equityRaw === "Yes"
          ? 0.1
          : 0.25;

  const accrualRaw = asText(entry["Value Accrual"]);
  const hasMechanism = accrualRaw !== "" && accrualRaw !== "N/A" && accrualRaw !== "None";
  const valueAccrual = pass != null ? pass : hasMechanism ? 0.3 : 0;

  const governance = controlsToken(entry["Governance Decisions"], symbol) ? 1 : 0;

  const utility = asText(entry["Utility"])
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "" && t !== "N/A" && t !== "None");

  return {
    scores: { treasury, revenue, burns, equity, valueAccrual, governance },
    primaryAccrual: hasMechanism ? accrualRaw : "None reported",
    primaryAccrualDetail: asText(entry["Value Accrual Details"]),
    utility,
    // The token-rights API carries no UTR grade and no public UTR
    // endpoint exists — null unless the source starts providing one.
    utr: null,
    governanceToken: displayTokens(entry["Governance Decisions"]),
    treasuryToken: displayTokens(entry["Treasury Decisions"]),
    revenueToken: displayTokens(entry["Revenue Decisions"]),
    feeSwitch: feeSwitchRaw || "Unknown",
    buybacks: displayTokens(entry["Buybacks"]),
    dividends: displayTokens(entry["Dividends"]),
    burns: burnsRaw || "Unknown",
    equityCapture: equityRaw || "Unknown",
    entities: asText(entry["Associated Entities"]) || "Unknown",
    updated: typeof entry["Last Updated"] === "string" ? (entry["Last Updated"] as string) : null,
  };
}

interface RightsIndex {
  byId: Map<string, RightsEntry>;
  byPrimaryToken: Map<string, RightsEntry>;
}

function buildRightsIndex(entries: RightsEntry[]): RightsIndex {
  const byId = new Map<string, RightsEntry>();
  const byPrimaryToken = new Map<string, RightsEntry>();
  for (const e of entries) {
    const id = asText(e["DefiLlama ID"]);
    if (id) byId.set(id, e);
    const tokens = asList(e["Token"]);
    const primary = tokens[0];
    if (primary && !byPrimaryToken.has(primary)) byPrimaryToken.set(primary, e);
  }
  return { byId, byPrimaryToken };
}

// Dashboard symbol → token symbol used by the rights dataset where
// they differ (Collector Crypt's token is CARDS on DeFiLlama; the
// dashboard uses the Coinbase symbol CARD).
const RIGHTS_SYMBOL_ALIAS: Record<string, string> = { CARD: "CARDS" };

function lookupRights(index: RightsIndex, meta: TokenMeta): RightsEntry | null {
  for (const p of meta.parents) {
    const hit = index.byId.get(`parent#${p}`);
    if (hit) return hit;
  }
  const sym = RIGHTS_SYMBOL_ALIAS[meta.symbol] ?? meta.symbol;
  return index.byPrimaryToken.get(sym) ?? null;
}

async function fetchRightsIndex(): Promise<RightsIndex> {
  try {
    const raw = await fetchJson("https://api.llama.fi/token-rights");
    if (!Array.isArray(raw)) return buildRightsIndex([]);
    return buildRightsIndex(raw as RightsEntry[]);
  } catch {
    // Rights are an enrichment, not a pipeline dependency: on failure
    // every hexagon honestly renders "Unverified".
    return buildRightsIndex([]);
  }
}

// ---------------------------------------------------------------------------
// Brief descriptions (DeFiLlama protocols data)
// ---------------------------------------------------------------------------
//
// Verified 16 Nov 2026: GET https://api.llama.fi/protocols returns a
// `description` for ~9,000 protocols (only 2 missing one), keyed by
// slug and gecko_id; GET https://api.llama.fi/lite/protocols2 returns
// `parentProtocols` with a project-level description keyed by
// `parent#<slug>` — the same parent ids universe.ts uses. Resolution
// order per token: first universe slug with a usable description,
// then the parent protocol, then the CoinGecko-id match. Descriptions
// are cleaned (whitespace collapsed), rejected when too short to say
// anything or when they are documentation boilerplate rather than a
// project description, and capped at ~200 chars (first full sentence
// preferred) so the UI stays at one or two lines. Anything unresolved
// stays null and the UI shows nothing — never an invented line.

interface TokenIdentity {
  symbol: string;
  geckoId: string;
  name: string;
  category: string;
}

interface DescIndex {
  bySlug: Map<string, string>;
  byParent: Map<string, string>;
  byGecko: Map<string, string>;
  // Token identity for dynamic universe discovery: which token a
  // protocol group belongs to, from DeFiLlama's own index fields
  // (lite/protocols2 parentProtocols carry symbol + gecko_id;
  // /protocols carries symbol + gecko_id + category per slug).
  tokenBySlug: Map<string, TokenIdentity>;
  tokenByParent: Map<string, TokenIdentity>;
  // Market caps from the SAME two DeFiLlama payloads (verified live
  // 16 Nov 2026): lite/protocols2 parentProtocols carry `mcap` keyed
  // by gecko_id (HYPE $15.84B, PUMP $1.34B, SKY $1.26B — matching the
  // research baseline), lite/protocols2 protocols carry `mcap` keyed
  // by geckoId, and /protocols carries `mcap` keyed by gecko_id.
  // Combined coverage is every claim-filtered universe token; the
  // only misses are the no-claim stablecoin issuers (USDT/USDC/
  // PAXG/RLUSD/CBETH), which the claim filter excludes anyway.
  mcapByGecko: Map<string, number>;
  // Parent-protocol mcap keyed by `parent#<slug>`, with the parent's
  // symbol — the fallback for tokens whose parent carries a
  // different CoinGecko id than the token itself (AERO's parent
  // entry uses gecko_id "aero", not "aerodrome-finance").
  mcapByParent: Map<string, { mcap: number; symbol: string }>;
}

function cleanDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 12 || text.split(" ").length < 2) return null;
  if (/this documentation|documentation is diligently/i.test(text)) return null;
  if (text.length <= 200) return text;
  const head = text.slice(0, 200);
  const sentenceEnd = head.lastIndexOf(". ");
  if (sentenceEnd >= 60) return head.slice(0, sentenceEnd + 1);
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 0 ? space : 200).trimEnd()}…`;
}

async function fetchDescriptionIndex(): Promise<DescIndex> {
  const bySlug = new Map<string, string>();
  const byParent = new Map<string, string>();
  const byGecko = new Map<string, string>();
  const tokenBySlug = new Map<string, TokenIdentity>();
  const tokenByParent = new Map<string, TokenIdentity>();
  const mcapByGecko = new Map<string, number>();
  const mcapByParent = new Map<string, { mcap: number; symbol: string }>();
  const noteMcap = (geckoId: unknown, mcapRaw: unknown) => {
    const mcap = numOrNull(mcapRaw);
    if (typeof geckoId === "string" && geckoId !== "" && mcap != null && mcap > 0 && !mcapByGecko.has(geckoId)) {
      mcapByGecko.set(geckoId, mcap);
    }
  };
  try {
    const [full, lite] = await Promise.all([
      fetchJson("https://api.llama.fi/protocols"),
      fetchJson("https://api.llama.fi/lite/protocols2"),
    ]);
    if (Array.isArray(full)) {
      for (const p of full as Array<Record<string, unknown>>) {
        noteMcap(p.gecko_id, p.mcap);
        if (
          typeof p.slug === "string" &&
          typeof p.symbol === "string" &&
          p.symbol !== "" &&
          p.symbol !== "-" &&
          typeof p.gecko_id === "string" &&
          p.gecko_id !== "" &&
          !tokenBySlug.has(p.slug)
        ) {
          tokenBySlug.set(p.slug, {
            symbol: p.symbol,
            geckoId: p.gecko_id,
            name: typeof p.name === "string" && p.name ? p.name : p.symbol,
            category: typeof p.category === "string" && p.category ? p.category : "Protocol",
          });
        }
        const desc = cleanDescription(p.description);
        if (!desc) continue;
        if (typeof p.slug === "string" && !bySlug.has(p.slug)) bySlug.set(p.slug, desc);
        if (typeof p.gecko_id === "string" && !byGecko.has(p.gecko_id)) {
          byGecko.set(p.gecko_id, desc);
        }
      }
    }
    // lite/protocols2 protocol entries key their CoinGecko id as
    // `geckoId` (camelCase — the parent entries use `gecko_id`).
    const liteProtocols =
      (lite as { protocols?: Array<Record<string, unknown>> }).protocols ?? [];
    for (const p of liteProtocols) {
      noteMcap(p.geckoId, p.mcap);
    }
    const parents =
      (lite as { parentProtocols?: Array<Record<string, unknown>> }).parentProtocols ?? [];
    for (const p of parents) {
      noteMcap(p.gecko_id, p.mcap);
      const parentMcap = numOrNull(p.mcap);
      if (
        typeof p.id === "string" &&
        parentMcap != null &&
        parentMcap > 0 &&
        !mcapByParent.has(p.id)
      ) {
        mcapByParent.set(p.id, {
          mcap: parentMcap,
          symbol: typeof p.symbol === "string" ? p.symbol : "",
        });
      }
      if (
        typeof p.id === "string" &&
        typeof p.symbol === "string" &&
        p.symbol !== "" &&
        p.symbol !== "-" &&
        typeof p.gecko_id === "string" &&
        p.gecko_id !== "" &&
        !tokenByParent.has(p.id)
      ) {
        tokenByParent.set(p.id, {
          symbol: p.symbol,
          geckoId: p.gecko_id,
          name: typeof p.name === "string" && p.name ? p.name : p.symbol,
          category: "Protocol",
        });
      }
      const desc = cleanDescription(p.description);
      if (desc && typeof p.id === "string" && !byParent.has(p.id)) {
        byParent.set(p.id, desc);
      }
    }
  } catch {
    // Descriptions are an enrichment, not a pipeline dependency: on
    // failure every description stays null and the UI shows nothing.
    // Dynamic discovery degrades with it — the research-mapped
    // universe still ranks and fills as far as it can.
  }
  return { bySlug, byParent, byGecko, tokenBySlug, tokenByParent, mcapByGecko, mcapByParent };
}

// DeFiLlama market cap for a token: direct CoinGecko-id hit first
// (identity-safe), then the token's parent-protocol entry when its
// symbol agrees (catches AERO, whose parent entry carries gecko_id
// "aero" rather than the token's "aerodrome-finance").
function llamaMcapFor(meta: TokenMeta, index: DescIndex): number | null {
  const direct = index.mcapByGecko.get(meta.cgId);
  if (direct != null) return direct;
  for (const p of meta.parents) {
    const hit = index.mcapByParent.get(`parent#${p}`);
    if (hit && hit.symbol === meta.symbol) return hit.mcap;
  }
  return null;
}

function descriptionFor(meta: TokenMeta, index: DescIndex): string | null {
  for (const s of meta.slugs) {
    const hit = index.bySlug.get(s);
    if (hit) return hit;
  }
  for (const p of meta.parents) {
    const hit = index.byParent.get(`parent#${p}`);
    if (hit) return hit;
  }
  return index.byGecko.get(meta.cgId) ?? null;
}

// ---------------------------------------------------------------------------
// Dynamic discovery (backfill beyond the research-mapped universe)
// ---------------------------------------------------------------------------
//
// The research universe maps 54 tokens. After the chain,
// not-comparable and claim exclusions only ~25 of them remain, so
// the top 50 is completed from DeFiLlama's full protocol list:
// every fees-overview entry NOT consumed by a research-mapped token
// is summed under its group key (parent protocol, else its own
// slug), and the group resolves to a token through the protocol
// index above. A dynamic candidate must clear the same bars as a
// mapped one: not a chain token, a live Coinbase USD pair under its
// symbol, and a claim (trailing-30d holders revenue > 0).

interface GroupSumExt extends GroupSum {
  slugs: string[];
}

function sumByGroup(entries: LlamaEntry[]): Map<string, GroupSumExt> {
  const out = new Map<string, GroupSumExt>();
  for (const e of entries) {
    if (resolveMeta(e)) continue; // consumed by a research-mapped token
    const key = e.parentProtocol ?? (e.slug ? `slug#${e.slug}` : null);
    if (!key) continue;
    let g = out.get(key);
    if (!g) {
      g = { rev7d: 0, rev30d: 0, prev30d: 0, ttm: 0, found: false, slugs: [] };
      out.set(key, g);
    }
    g.found = true;
    g.rev7d += e.total7d ?? 0;
    g.rev30d += e.total30d ?? 0;
    g.prev30d += e.total60dto30d ?? 0;
    g.ttm += e.total1y ?? 0;
    if (e.slug && !g.slugs.includes(e.slug)) g.slugs.push(e.slug);
  }
  return out;
}

const DYNAMIC_CAVEAT =
  "Not covered by the 15 Nov 2026 research set, so there is no token-specific research note for this row. Figures are DeFiLlama protocol revenue and holders revenue (buybacks, burns and staker payouts) exactly as reported — check how this protocol's revenue reaches the token before comparing its multiple.";

function dynamicMeta(
  key: string,
  g: GroupSumExt,
  index: DescIndex,
  usedSymbols: Set<string>,
): TokenMeta | null {
  let identity: TokenIdentity | undefined;
  let parents: string[] = [];
  let slugs: string[] = [];
  let category = "Protocol";
  if (key.startsWith("parent#")) {
    identity = index.tokenByParent.get(key);
    if (!identity) return null;
    parents = [key.slice("parent#".length)];
    slugs = g.slugs;
    for (const s of g.slugs) {
      const child = index.tokenBySlug.get(s);
      if (child) {
        category = child.category;
        break;
      }
    }
  } else {
    const slug = key.slice("slug#".length);
    identity = index.tokenBySlug.get(slug);
    if (!identity) return null;
    slugs = [slug];
    category = identity.category;
  }
  if (usedSymbols.has(identity.symbol)) return null;
  const meta: TokenMeta = {
    symbol: identity.symbol,
    project: identity.name,
    category,
    cgId: identity.geckoId,
    cbBase: identity.symbol,
    parents,
    slugs,
    listing: "orderbook",
    flag: null,
    revenueIs: `DeFiLlama protocol revenue for ${identity.name} — fees minus supply-side revenue, summed over the ${identity.name} protocol group on DeFiLlama.`,
    caveat: DYNAMIC_CAVEAT,
    base: {
      price: null,
      mcapM: null,
      fdvM: null,
      rev30dM: 0,
      ttmM: null,
      fees30dM: null,
      holders30dM: null,
      growthPct: null,
    },
  };
  if (isChainToken(meta)) return null;
  return meta;
}

// ---------------------------------------------------------------------------
// Revenue pipeline
// ---------------------------------------------------------------------------

async function buildLivePayload(cgApiKey?: string): Promise<DashboardPayload> {
  // Revenue and buybacks are separate pipelines with separate sources
  // (dailyRevenue vs dailyHoldersRevenue) — stamp each fetch's own
  // completion time so the UI can show a per-source status line.
  const stamps = { revenue: "", buybacks: "" };
  const [revEntries, feeEntries, holderEntries, cbRaw, rightsIndex, descIndex] =
    await Promise.all([
      fetchLlama("dailyRevenue").then((d) => {
        stamps.revenue = new Date().toISOString();
        return d;
      }),
      fetchLlama("dailyFees"),
      fetchLlama("dailyHoldersRevenue").then((d) => {
        stamps.buybacks = new Date().toISOString();
        return d;
      }),
      fetchJson("https://api.exchange.coinbase.com/products"),
      fetchRightsIndex(),
      fetchDescriptionIndex(),
    ]);

  const cbPairs = new Set<string>();
  if (Array.isArray(cbRaw)) {
    for (const p of cbRaw as Array<{ base_currency?: string; quote_currency?: string }>) {
      if (p.quote_currency === "USD" && p.base_currency) cbPairs.add(p.base_currency);
    }
  }

  const rev = sumByToken(revEntries);
  const fees = sumByToken(feeEntries);
  const holders = sumByToken(holderEntries);
  const gRev = sumByGroup(revEntries);
  const gFees = sumByGroup(feeEntries);
  const gHolders = sumByGroup(holderEntries);

  // Selection: every exclusion (chain, not-comparable, Coinbase
  // listing, claim) is applied BEFORE ranking, and the top 50 is
  // sliced from the survivors — research-mapped tokens first-class,
  // dynamically discovered groups backfilling the rest, all ranked
  // together by trailing-7d protocol revenue.
  interface Candidate {
    meta: TokenMeta;
    g: GroupSum;
    f: GroupSum | undefined;
    h: GroupSum | undefined;
  }
  const candidates: Candidate[] = [];
  const usedSymbols = new Set(TOKEN_META.map((m) => m.symbol));
  let excludedNoClaim = 0;

  for (const meta of TOKEN_META) {
    if (isExcludedToken(meta)) continue;
    const g = rev.get(meta.symbol);
    if (!g || !g.found || g.rev7d <= 0) continue;
    if (meta.listing === "orderbook" && !cbPairs.has(meta.cbBase)) continue;
    const h = holders.get(meta.symbol);
    const hold30dM = h && h.found ? h.rev30d / 1e6 : null;
    if (!claimFor(meta, hold30dM).hasClaim) {
      excludedNoClaim++;
      continue;
    }
    candidates.push({ meta, g, f: fees.get(meta.symbol), h });
  }

  const dynGroups = [...gRev.entries()]
    .filter(([, g]) => g.found && g.rev7d > 0)
    .sort((a, b) => b[1].rev7d - a[1].rev7d);
  for (const [key, g] of dynGroups) {
    const meta = dynamicMeta(key, g, descIndex, usedSymbols);
    if (!meta) continue;
    if (!cbPairs.has(meta.cbBase)) continue;
    const h = gHolders.get(key);
    const hold30dM = h && h.found ? h.rev30d / 1e6 : null;
    if (!claimFor(meta, hold30dM).hasClaim) {
      excludedNoClaim++;
      continue;
    }
    usedSymbols.add(meta.symbol);
    candidates.push({ meta, g, f: gFees.get(key), h });
  }

  const ranked = candidates
    .sort((a, b) => b.g.rev7d - a.g.rev7d)
    .slice(0, 50);

  // Market data is the resilient chain (CoinGecko → DeFiLlama →
  // DeFiLlama mcap index + CoinMarketCap / CoinPaprika supplies): it never throws,
  // so a price-source outage can no longer kill the whole revenue
  // refresh the way the bare CoinGecko call did (HTTP 403 from the
  // deployed Worker's egress — no snapshot was ever stored). On
  // total price failure the map is empty, rows carry null prices,
  // and the callers decide whether storing that beats the previous
  // snapshot. The DeFiLlama mcap index rides the description-index
  // fetches above (no extra subrequests) and is keyed by CoinGecko
  // id, so caps populate even when both CoinGecko and CoinPaprika
  // are unreachable from the Worker's egress.
  const llamaCaps = new Map<string, number>();
  for (const x of ranked) {
    const mc = llamaMcapFor(x.meta, descIndex);
    if (mc != null) llamaCaps.set(x.meta.cgId, mc);
  }
  const markets = await fetchMarkets(
    ranked.map((x) => ({ id: x.meta.cgId, symbol: x.meta.symbol, name: x.meta.project })),
    { rich: true, cgApiKey, llamaCaps },
  );
  const cg = markets.map;

  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setUTCDate(windowEnd.getUTCDate() - 1);

  const rows: Row[] = ranked.map(({ meta, g, f, h }, i) => {
    const m = cg.get(meta.cgId);

    const rev7dM = g ? g.rev7d / 1e6 : null;
    const rev30dM = g ? g.rev30d / 1e6 : null;
    const runRateRevM = rev30dM != null ? rev30dM * 12 : null;
    const growthPct =
      g && g.prev30d > 0 ? ((g.rev30d - g.prev30d) / g.prev30d) * 100 : null;
    const ttmRevM = g && g.ttm > 0 ? g.ttm / 1e6 : null;
    const fees30dM = f && f.found && f.rev30d > 0 ? f.rev30d / 1e6 : null;
    const buyback30dM = h && h.found ? h.rev30d / 1e6 : null;
    const claim = claimFor(meta, buyback30dM);

    const price = m?.current_price ?? null;
    const marketCapM = m?.market_cap != null ? m.market_cap / 1e6 : null;
    const fdvM =
      m?.fully_diluted_valuation != null ? m.fully_diluted_valuation / 1e6 : null;

    const holdersPct =
      buyback30dM != null && rev30dM != null && rev30dM > 0
        ? (buyback30dM / rev30dM) * 100
        : null;

    return {
      symbol: meta.symbol,
      project: meta.project,
      category: meta.category,
      cgId: meta.cgId,
      rank: i + 1,
      hasClaim: claim.hasClaim,
      claimNote: claim.note,
      price,
      priceChange24hPct: m?.price_change_percentage_24h ?? null,
      marketCapM,
      fdvM,
      circSupply: m?.circulating_supply ?? null,
      totalSupply: m?.total_supply ?? null,
      circPct:
        m?.circulating_supply != null && m?.total_supply != null && m.total_supply > 0
          ? (m.circulating_supply / m.total_supply) * 100
          : null,
      rev7dM,
      rev30dM,
      runRateRevM,
      growthPct,
      fees30dM,
      retentionPct:
        fees30dM != null && fees30dM > 0 && rev30dM != null
          ? (rev30dM / fees30dM) * 100
          : null,
      buyback30dM: buyback30dM != null && buyback30dM > 0 ? buyback30dM : buyback30dM === 0 ? 0 : null,
      buybackAnnM:
        buyback30dM != null && buyback30dM > 0 ? buyback30dM * ANNUALISE : buyback30dM === 0 ? 0 : null,
      holdersPct,
      ttmRevM,
      pRunRate:
        marketCapM != null && runRateRevM != null && runRateRevM > 0
          ? marketCapM / runRateRevM
          : null,
      pRunRateFdv:
        fdvM != null && runRateRevM != null && runRateRevM > 0
          ? fdvM / runRateRevM
          : null,
      pTtm:
        marketCapM != null && ttmRevM != null && ttmRevM > 0
          ? marketCapM / ttmRevM
          : null,
      pBuyback:
        marketCapM != null && buyback30dM != null && buyback30dM > 0
          ? marketCapM / (buyback30dM * ANNUALISE)
          : null,
      pBuybackFdv:
        fdvM != null && buyback30dM != null && buyback30dM > 0
          ? fdvM / (buyback30dM * ANNUALISE)
          : null,
      listing: meta.listing,
      pairLive: meta.listing === "orderbook" ? cbPairs.has(meta.cbBase) : null,
      flag: meta.flag,
      revenueIs: meta.revenueIs,
      caveat: meta.caveat,
      description: descriptionFor(meta, descIndex),
      rights: rightsFor(lookupRights(rightsIndex, meta), meta.symbol, holdersPct),
    };
  });

  return assemble(
    rows,
    "live",
    stamps.revenue || now.toISOString(),
    stamps.buybacks || now.toISOString(),
    windowEnd.toISOString(),
    now.toISOString(),
    null,
    excludedNoClaim,
  );
}

function buildBaselinePayload(error: string | null): DashboardPayload {
  // 15 Nov 2026 research snapshot (top-50 report). The report ranks by
  // 30d revenue and carries no 7d figures, so rev7dM is null (shown as
  // n.r.) rather than invented; ranking here is the report's order.
  // The same exclusions as the live pipeline apply (chains,
  // not-comparable, no-claim): the snapshot holds only the ~24
  // research tokens that pass, with no dynamic backfill available.
  const pool = [...TOKEN_META]
    .filter((m) => !isExcludedToken(m))
    .filter((m) => m.base.rev30dM > 0);
  const excludedNoClaim = pool.filter(
    (m) => !claimFor(m, m.base.holders30dM).hasClaim,
  ).length;
  const sorted = pool
    .filter((m) => claimFor(m, m.base.holders30dM).hasClaim)
    .sort((a, b) => b.base.rev30dM - a.base.rev30dM)
    .slice(0, 50);
  const rows: Row[] = sorted.map((meta, i) => {
    const b = meta.base;
    const runRateRevM = b.rev30dM * 12;
    const claim = claimFor(meta, b.holders30dM);
    return {
      symbol: meta.symbol,
      project: meta.project,
      category: meta.category,
      cgId: meta.cgId,
      rank: i + 1,
      hasClaim: claim.hasClaim,
      claimNote: claim.note,
      price: b.price,
      priceChange24hPct: null,
      marketCapM: b.mcapM,
      fdvM: b.fdvM,
      circSupply: null,
      totalSupply: null,
      circPct: null,
      rev7dM: null,
      rev30dM: b.rev30dM,
      runRateRevM,
      growthPct: b.growthPct,
      fees30dM: b.fees30dM,
      retentionPct:
        b.fees30dM != null && b.fees30dM > 0 ? (b.rev30dM / b.fees30dM) * 100 : null,
      buyback30dM: b.holders30dM,
      buybackAnnM: b.holders30dM != null ? b.holders30dM * ANNUALISE : null,
      holdersPct:
        b.holders30dM != null && b.rev30dM > 0 ? (b.holders30dM / b.rev30dM) * 100 : null,
      ttmRevM: b.ttmM,
      pRunRate: b.mcapM != null && runRateRevM > 0 ? b.mcapM / runRateRevM : null,
      pRunRateFdv: b.fdvM != null && runRateRevM > 0 ? b.fdvM / runRateRevM : null,
      pTtm: b.mcapM != null && b.ttmM != null && b.ttmM > 0 ? b.mcapM / b.ttmM : null,
      pBuyback:
        b.mcapM != null && b.holders30dM != null && b.holders30dM > 0
          ? b.mcapM / (b.holders30dM * ANNUALISE)
          : null,
      pBuybackFdv:
        b.fdvM != null && b.holders30dM != null && b.holders30dM > 0
          ? b.fdvM / (b.holders30dM * ANNUALISE)
          : null,
      listing: meta.listing,
      pairLive: null,
      flag: meta.flag,
      revenueIs: meta.revenueIs,
      caveat: meta.caveat,
      // The research snapshot carries no DeFiLlama descriptions.
      description: null,
      rights: null,
    };
  });
  return assemble(rows, "baseline", BASELINE_AS_OF, BASELINE_AS_OF, BASELINE_AS_OF, BASELINE_AS_OF, error, excludedNoClaim);
}

function assemble(
  rows: Row[],
  status: DashboardPayload["status"],
  revenueFetchedAt: string,
  buybacksFetchedAt: string,
  revenueWindowEnd: string,
  pricesUpdatedAt: string,
  error: string | null,
  excludedNoClaim: number,
): DashboardPayload {
  // Rows arrive pre-filtered (exclusions + claim applied before the
  // top-50 slice), so every row here is a shown row.
  const claimed = rows.filter((r) => r.hasClaim);
  return {
    v: 7,
    status,
    revenueFetchedAt,
    buybacksFetchedAt,
    revenueWindowEnd,
    pricesUpdatedAt,
    rows,
    totals: {
      shown: claimed.length,
      excludedNoClaim,
      totalRev7dM: claimed.reduce((s, r) => s + (r.rev7dM ?? 0), 0),
      totalRev30dM: claimed.reduce((s, r) => s + (r.rev30dM ?? 0), 0),
      totalBuyback30dM: claimed.reduce((s, r) => s + (r.buyback30dM ?? 0), 0),
    },
    error,
  };
}

// ---------------------------------------------------------------------------
// Price pipeline cache — Worker-appropriate storage
// ---------------------------------------------------------------------------
//
// Two layers, replacing the old module-level variable:
//  1. The Cache API (caches.default) under a synthetic cache key —
//     shared by every isolate in the colo, 8s TTL, so all viewers in
//     a region share one upstream CoinGecko call.
//  2. A per-isolate in-memory copy as an L1 in front of it (a Worker
//     isolate is short-lived and may be evicted at any time, so this
//     is only ever a fast path, never the store of record).
// The series cache further down uses the same pattern at 30 min.

const PRICE_CACHE_URL = "https://cache.internal/prices/v1";
let priceCacheL1: { at: number; payload: z.infer<typeof pricesResponse> } | null = null;

async function cacheGetJson(keyUrl: string, maxAgeMs: number): Promise<unknown | null> {
  try {
    const hit = await caches.default.match(new Request(keyUrl));
    if (!hit) return null;
    const storedAt = Number(hit.headers.get("x-cached-at") ?? 0);
    if (!storedAt || Date.now() - storedAt > maxAgeMs) return null;
    return (await hit.json()) as unknown;
  } catch {
    return null;
  }
}

async function cachePutJson(keyUrl: string, value: unknown, ttlSec: number): Promise<void> {
  try {
    await caches.default.put(
      new Request(keyUrl),
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttlSec}`,
          "x-cached-at": String(Date.now()),
        },
      }),
    );
  } catch {
    // Cache API unavailable (e.g. local dev): the L1 maps still serve.
  }
}

// ---------------------------------------------------------------------------
// Charting pipeline (DeFiLlama coins chart API)
// ---------------------------------------------------------------------------
//
// Daily USD price history for the charting module. CoinGecko's free
// market_chart is capped at 365 days, so history comes from
// DeFiLlama's coins chart API (verified live 16 Nov 2026): keyed by
// the same CoinGecko ids the dashboard uses
// (coins.llama.fi/chart/coingecko:<id>?period=1d), it serves daily
// points back to each token's first trade (HYPE: 29 Nov 2024; BTC:
// 28 Apr 2013). One request returns at most ~500 points, so the full
// history is stitched from consecutive 490-day windows starting in
// 2011 (before any tracked token traded), deduplicated by UTC date.
// Note: start=0 does NOT mean "from the beginning" — verified live,
// it returns the latest window — so an explicit early start
// timestamp is required. Series are cached server-side for 30
// minutes per token — daily closes move slowly and every viewer
// shares the cache. A pair ratio is computed by dividing the two USD
// series on their shared UTC dates; the pseudo-id "usd" is the
// constant 1 (token/USD and USD/token charts).

const SERIES_CACHE_MS = 30 * 60 * 1000;
const SERIES_WINDOW_DAYS = 490;
const SERIES_START_SEC = 1293840000; // 2011-01-01 UTC — before any token's first trade
const SERIES_MAX_WINDOWS = 16; // 16 × 490d ≈ 21 years of stitched history
// Per-isolate L1 in front of the Cache API (30-min TTL there), same
// pattern as the price cache above.
const seriesCache = new Map<string, { at: number; byDate: Map<string, number> }>();

async function fetchDailySeries(cgId: string): Promise<Map<string, number>> {
  const cached = seriesCache.get(cgId);
  if (cached && Date.now() - cached.at < SERIES_CACHE_MS) return cached.byDate;
  const shared = await cacheGetJson(
    `https://cache.internal/series/v1/${encodeURIComponent(cgId)}`,
    SERIES_CACHE_MS,
  );
  if (shared && typeof shared === "object") {
    const byDate = new Map<string, number>(Object.entries(shared as Record<string, number>));
    if (byDate.size > 0) {
      seriesCache.set(cgId, { at: Date.now(), byDate });
      return byDate;
    }
  }
  const byDate = new Map<string, number>();
  const nowMs = Date.now();
  let cursorSec = SERIES_START_SEC;
  for (let w = 0; w < SERIES_MAX_WINDOWS; w++) {
    if (cursorSec * 1000 > nowMs) break;
    const raw = (await fetchJson(
      `https://coins.llama.fi/chart/coingecko:${encodeURIComponent(cgId)}?start=${cursorSec}&period=1d&span=${SERIES_WINDOW_DAYS}`,
    )) as { coins?: Record<string, { prices?: Array<{ timestamp: number; price: number }> }> };
    const prices = raw.coins?.[`coingecko:${cgId}`]?.prices ?? [];
    if (prices.length === 0) {
      // No trades in this window (e.g. before the token existed, or
      // a long gap): skip ahead one window rather than giving up.
      cursorSec += SERIES_WINDOW_DAYS * 86_400;
      continue;
    }
    for (const p of prices) {
      if (typeof p.timestamp === "number" && typeof p.price === "number" && p.price > 0) {
        byDate.set(new Date(p.timestamp * 1000).toISOString().slice(0, 10), p.price);
      }
    }
    const last = prices[prices.length - 1];
    if (!last || last.timestamp * 1000 >= nowMs - 86_400_000) break;
    cursorSec = last.timestamp + 1;
  }
  seriesCache.set(cgId, { at: Date.now(), byDate });
  await cachePutJson(
    `https://cache.internal/series/v1/${encodeURIComponent(cgId)}`,
    Object.fromEntries(byDate),
    SERIES_CACHE_MS / 1000,
  );
  return byDate;
}

const pairSeriesResponse = z.object({
  points: z.array(z.object({ t: z.number(), v: z.number() })),
});

// ---------------------------------------------------------------------------
// D1 snapshot store (was: ctx.db over SQLite)
// ---------------------------------------------------------------------------
//
// Same table, same semantics as the Muse version: one row per
// refresh (fetched_at as epoch milliseconds, payload as JSON text),
// readers take the newest row, payloads whose v is not 7 are ignored,
// and the table is pruned to the newest 60 rows after every write.

async function latestSnapshot(env: Env) {
  // A D1 failure here (e.g. the migration not applied yet) must read
  // as "no snapshot", never as a 500: getPrices prices the bundled
  // universe in that case, and getDashboard falls back to the
  // research baseline.
  try {
    const row = await env.DB.prepare(
      "SELECT fetched_at, payload FROM snapshots ORDER BY id DESC LIMIT 1",
    ).first<{ fetched_at: number; payload: string }>();
    if (!row) return null;
    const parsed = JSON.parse(row.payload) as DashboardPayload;
    if (parsed.v !== 7) return null;
    return { fetchedAt: new Date(row.fetched_at), payload: parsed };
  } catch (e) {
    logError("latestSnapshot", e);
    return null;
  }
}

function hasAnyPrice(p: DashboardPayload): boolean {
  return p.rows.some((r) => r.price != null);
}

async function storeSnapshot(env: Env, payload: DashboardPayload) {
  await env.DB.prepare("INSERT INTO snapshots (fetched_at, payload) VALUES (?, ?)")
    .bind(Date.now(), JSON.stringify(payload))
    .run();
  await env.DB.prepare(
    "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 60)",
  ).run();
}

// ---------------------------------------------------------------------------
// Handlers — the four actions, same names, same request/response shapes
// ---------------------------------------------------------------------------
//
//   getDashboard    {}                                  -> dashboardResponse (v7)
//   refreshDashboard {}                                 -> { ok, fetchedAt, error }
//   getPrices       {}                                  -> pricesResponse
//   getPairSeries   { baseId, quoteId, days }           -> pairSeriesResponse

export async function handleGetDashboard(env: Env): Promise<DashboardPayload> {
  const snap = await latestSnapshot(env);
  if (snap && Date.now() - snap.fetchedAt.getTime() < REV_STALE_MS) {
    return snap.payload;
  }
  try {
    const payload = await buildLivePayload(env.COINGECKO_API_KEY);
    if (!hasAnyPrice(payload) && snap) {
      // A refresh that could not price anything must not overwrite
      // a good snapshot with null prices.
      logError(
        "getDashboard refresh",
        new Error("refreshed payload carries no prices; keeping previous snapshot"),
      );
      return {
        ...snap.payload,
        error: "Price sources unreachable; showing the last fetched snapshot.",
      };
    }
    await storeSnapshot(env, payload);
    return payload;
  } catch (e) {
    logError("getDashboard refresh", e);
    const message = e instanceof Error ? e.message : String(e);
    if (snap) {
      return {
        ...snap.payload,
        error: `Revenue refresh failed (${message}); showing the last fetched snapshot.`,
      };
    }
    return buildBaselinePayload(
      `Live sources unreachable (${message}); showing the research snapshot of 15 Nov 2026.`,
    );
  }
}

export async function handleRefreshDashboard(
  env: Env,
): Promise<{ ok: boolean; fetchedAt: string | null; error: string | null }> {
  try {
    const payload = await buildLivePayload(env.COINGECKO_API_KEY);
    if (!hasAnyPrice(payload)) {
      const existing = await latestSnapshot(env);
      if (existing) {
        const msg = "all price sources failed; previous snapshot kept";
        logError("refreshDashboard", new Error(msg));
        return { ok: false, fetchedAt: null, error: msg };
      }
      // No snapshot at all yet: a revenue-only snapshot still beats
      // the frozen research baseline, and getPrices prices its rows
      // live on every poll.
      logError(
        "refreshDashboard",
        new Error("storing revenue-only snapshot (no price source reachable)"),
      );
    }
    await storeSnapshot(env, payload);
    priceCacheL1 = null;
    try {
      await caches.default.delete(new Request(PRICE_CACHE_URL));
    } catch {
      // Cache API unavailable locally — the L1 clear above suffices.
    }
    return { ok: true, fetchedAt: payload.revenueFetchedAt, error: null };
  } catch (e) {
    logError("refreshDashboard", e);
    return {
      ok: false,
      fetchedAt: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function handleGetPrices(
  env: Env,
): Promise<z.infer<typeof pricesResponse>> {
  if (priceCacheL1 && Date.now() - priceCacheL1.at < PRICE_CACHE_MS) {
    return priceCacheL1.payload;
  }
  const shared = await cacheGetJson(PRICE_CACHE_URL, PRICE_CACHE_MS);
  if (shared) {
    try {
      const payload = pricesResponse.parse(shared);
      priceCacheL1 = { at: Date.now(), payload };
      return payload;
    } catch (e) {
      // A malformed cache entry must not 500 the poll — refetch live.
      logError("getPrices cache parse", e);
    }
  }
  const snap = await latestSnapshot(env);
  // No snapshot yet (fresh deploy, empty D1): price the bundled
  // universe — the first 50 research-mapped tokens — instead of
  // failing. Prices update from the bundled list from the first poll.
  const targets: MarketTarget[] = snap
    ? snap.payload.rows.map((r) => ({ id: r.cgId, symbol: r.symbol }))
    : TOKEN_META.slice(0, 50).map((m) => ({ id: m.cgId, symbol: m.symbol }));
  const { map: cg } = await fetchMarkets(targets, {
    rich: false,
    cgApiKey: env.COINGECKO_API_KEY,
  });
  if (cg.size > 0) {
    const payload: z.infer<typeof pricesResponse> = {
      pricesUpdatedAt: new Date().toISOString(),
      prices: targets.map(({ id }) => {
        const m = cg.get(id);
        return {
          cgId: id,
          price: m?.current_price ?? null,
          priceChange24hPct: m?.price_change_percentage_24h ?? null,
          marketCapM: m?.market_cap != null ? m.market_cap / 1e6 : null,
          fdvM: m?.fully_diluted_valuation != null ? m.fully_diluted_valuation / 1e6 : null,
          circSupply: m?.circulating_supply ?? null,
          totalSupply: m?.total_supply ?? null,
        };
      }),
    };
    priceCacheL1 = { at: Date.now(), payload };
    await cachePutJson(PRICE_CACHE_URL, payload, PRICE_CACHE_MS / 1000);
    return payload;
  }
  // Every live price source failed: serve the last stored prices
  // (snapshot rows, or the research baseline when no snapshot exists)
  // under their ORIGINAL timestamp — stale data labelled stale,
  // never a 500. Deliberately not cached, so the next poll retries
  // the live sources immediately.
  logError(
    "getPrices",
    new Error("all price sources failed; serving last stored prices"),
  );
  const stored = snap ? snap.payload : buildBaselinePayload(null);
  return {
    pricesUpdatedAt: stored.pricesUpdatedAt ?? BASELINE_AS_OF,
    prices: stored.rows.map((r) => ({
      cgId: r.cgId,
      price: r.price,
      priceChange24hPct: r.priceChange24hPct,
      marketCapM: r.marketCapM,
      fdvM: r.fdvM,
      circSupply: r.circSupply,
      totalSupply: r.totalSupply,
    })),
  };
}

const pairSeriesRequest = z.object({
  baseId: z.string().min(1),
  quoteId: z.string().min(1),
  days: z.number().int(),
});

export async function handleGetPairSeries(
  args: z.infer<typeof pairSeriesRequest>,
): Promise<z.infer<typeof pairSeriesResponse>> {
  // The client passes a huge day count for its "Max" range; the real
  // bound is each token's fetched full history.
  const days = Math.min(36500, Math.max(7, args.days));
  if (args.baseId === args.quoteId) return { points: [] };
  const [base, quote] = await Promise.all([
    args.baseId === "usd" ? null : fetchDailySeries(args.baseId),
    args.quoteId === "usd" ? null : fetchDailySeries(args.quoteId),
  ]);
  const cutoff = Date.now() - days * 86_400_000;
  const points: Array<{ t: number; v: number }> = [];
  if (base) {
    for (const [date, bv] of base) {
      const t = Date.parse(`${date}T00:00:00Z`);
      if (t < cutoff) continue;
      const qv = quote ? quote.get(date) : 1;
      if (qv == null || qv <= 0) continue;
      points.push({ t, v: bv / qv });
    }
  } else if (quote) {
    // Base is USD: the series is 1 / quote price.
    for (const [date, qv] of quote) {
      const t = Date.parse(`${date}T00:00:00Z`);
      if (t < cutoff || qv <= 0) continue;
      points.push({ t, v: 1 / qv });
    }
  }
  points.sort((a, b) => a.t - b.t);
  return { points };
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------
//
// Routes (mounted under /dashboard on the journal Worker — see
// ../wrangler.toml for the route and the merge notes in ../README.md):
//
//   GET|POST /dashboard/api/getDashboard     -> handleGetDashboard
//   GET|POST /dashboard/api/getPrices        -> handleGetPrices
//   GET|POST /dashboard/api/getPairSeries    -> handleGetPairSeries
//            (POST JSON body, or GET ?baseId=&quoteId=&days=)
//   POST     /dashboard/api/refreshDashboard -> handleRefreshDashboard
//            (internal: requires the REFRESH_SECRET bearer token when
//            that secret is set; the cron trigger below calls the
//            handler directly and never goes through HTTP)
//   anything else under /dashboard/*         -> the client bundle
//            (ASSETS binding; the journal Worker's own routes are
//            matched first / on their own patterns and are untouched)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readArgs(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as unknown;
      if (body && typeof body === "object") return body as Record<string, unknown>;
    } catch {
      // Empty / non-JSON body: fall through to query params.
    }
  }
  return Object.fromEntries(new URL(request.url).searchParams);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path.endsWith("/api/getDashboard")) {
        return json(dashboardResponse.parse(await handleGetDashboard(env)));
      }
      if (path.endsWith("/api/getPrices")) {
        return json(pricesResponse.parse(await handleGetPrices(env)));
      }
      if (path.endsWith("/api/getPairSeries")) {
        const raw = await readArgs(request);
        const args = pairSeriesRequest.parse({
          baseId: raw.baseId,
          quoteId: raw.quoteId,
          days: typeof raw.days === "string" ? Number(raw.days) : raw.days,
        });
        return json(pairSeriesResponse.parse(await handleGetPairSeries(args)));
      }
      if (path.endsWith("/api/refreshDashboard")) {
        if (request.method !== "POST") {
          return json({ ok: false, fetchedAt: null, error: "POST only" }, 405);
        }
        if (
          env.REFRESH_SECRET &&
          request.headers.get("authorization") !== `Bearer ${env.REFRESH_SECRET}`
        ) {
          return json({ ok: false, fetchedAt: null, error: "unauthorized" }, 401);
        }
        return json(await handleRefreshDashboard(env));
      }
      if (path.includes("/api/")) {
        return json({ error: "unknown endpoint" }, 404);
      }
      // Client bundle + SPA fallback for the dashboard's own paths.
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      const indexUrl = new URL("/dashboard/", url.origin);
      return env.ASSETS.fetch(new Request(indexUrl, request));
    } catch (e) {
      logError(`fetch ${path}`, e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },

  // Daily refresh — replaces the space.json managed cron. Wrangler
  // cron triggers are UTC (see [triggers] in ../wrangler.toml for
  // the 06:00 America/Los_Angeles mapping and its DST note).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      handleRefreshDashboard(env).then((r) => {
        if (r.ok) {
          console.log(`[crypto-dashboard] scheduled refresh ok at ${r.fetchedAt}`);
        } else {
          logError("scheduled refresh", new Error(r.error ?? "unknown error"));
        }
      }),
    );
  },
};
