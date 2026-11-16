// Plain-fetch API client for the Cloudflare deployment — replaces the
// Muse RPC client (@hatch/space-sdk). Same four calls, same request
// and response shapes; each is a POST of the JSON args to
// /dashboard/api/<name> on the same origin (the Worker serves both
// the client bundle and the API, so no base URL or CORS is involved).

import type {
  DashboardPayload,
  PairSeriesPayload,
  PricesPayload,
} from "./types";

async function post<T>(name: string, args: unknown): Promise<T> {
  const res = await fetch(`./api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // Non-JSON error body: keep the status line.
    }
    throw new Error(`${name} failed: ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  getDashboard: (args: Record<string, never>) =>
    post<DashboardPayload>("getDashboard", args),
  getPrices: (args: Record<string, never>) =>
    post<PricesPayload>("getPrices", args),
  getPairSeries: (args: { baseId: string; quoteId: string; days: number }) =>
    post<PairSeriesPayload>("getPairSeries", args),
  refreshDashboard: (args: Record<string, never>) =>
    post<{ ok: boolean; fetchedAt: string | null; error: string | null }>(
      "refreshDashboard",
      args,
    ),
};

// Drop-in replacement for the SDK client's ApiResponse helper type, so
// App.tsx / ChartModule.tsx type their data exactly as before:
//   type Dashboard = ApiResponse<typeof api, "getDashboard">;
export type ApiResponse<
  C,
  K extends keyof C,
> = C[K] extends (...args: never[]) => Promise<infer R> ? R : never;
export type ApiRequest<
  C,
  K extends keyof C,
> = C[K] extends (args: infer A) => Promise<unknown> ? A : never;
