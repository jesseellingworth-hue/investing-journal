// Response schemas for the dashboard API — copied verbatim from the
// Muse server (server/src/actions.ts) so the Cloudflare client and
// Worker validate and type the exact same payload shapes (dashboard
// payload v7 included). The Worker imports its own copy in
// src/worker.ts; keep the two in sync.

import { z } from "zod";

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


const pairSeriesResponse = z.object({
  points: z.array(z.object({ t: z.number(), v: z.number() })),
});

export type DashboardPayload = z.infer<typeof dashboardResponse>;
export type DashboardRow = z.infer<typeof rowSchema>;
export type PricesPayload = z.infer<typeof pricesResponse>;
export type PairSeriesPayload = z.infer<typeof pairSeriesResponse>;
