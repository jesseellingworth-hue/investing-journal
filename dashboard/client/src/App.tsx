import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { ChartModule, EXTRA_CHART_TOKENS, type ChartToken } from "./ChartModule";
import moonSurface from "./assets/moon-surface.webp";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Row = Dashboard["rows"][number];
type Rights = NonNullable<Row["rights"]>;
type Prices = ApiResponse<typeof api, "getPrices">;

// ---------- formatting ----------

function fmtMoneyM(m: number | null): string {
  if (m == null) return "n.r.";
  if (m >= 1000) return `$${(m / 1000).toFixed(2)}B`;
  if (m >= 100) return `$${m.toFixed(0)}M`;
  if (m >= 10) return `$${m.toFixed(1)}M`;
  return `$${m.toFixed(2)}M`;
}

function fmtPrice(p: number | null): string {
  if (p == null) return "n.r.";
  if (p >= 100) return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  const s = p.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return `$${s}`;
}

function fmtMult(x: number | null): string {
  if (x == null) return "—";
  if (x >= 100) return `${Math.round(x).toLocaleString("en-US")}×`;
  return `${x.toFixed(1)}×`;
}

function fmtPct(x: number | null, digits = 1): string {
  if (x == null) return "n.r.";
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(digits)}%`;
}

// Buyback as a share of revenue: trailing 30d buyback ÷ trailing 30d
// revenue. Null when the buyback is unverified or revenue is missing /
// $0 — shown as "—" rather than a wrong percentage.
function buybackPctOfRevenue(row: Row): number | null {
  if (row.buyback30dM == null || row.rev30dM == null || row.rev30dM <= 0) return null;
  return (row.buyback30dM / row.rev30dM) * 100;
}

function fmtBuybackPct(x: number | null): string {
  if (x == null) return "—";
  if (Math.abs(x - 100) < 0.05) return "100%";
  return `${x.toFixed(1)}%`;
}

function fmtSupply(x: number | null): string {
  if (x == null) return "n.r.";
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}K`;
  return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Buyback cell: null means the protocol is absent from DeFiLlama's
// holders-revenue feed — unverified, which is not the same as $0.
function BuybackCell({ valueM }: { valueM: number | null }) {
  if (valueM == null) {
    return (
      <span className="font-medium" style={{ color: "var(--warn)" }}>
        Unverified
      </span>
    );
  }
  return <>{fmtMoneyM(valueM)}</>;
}

// ---------- detail stats ----------

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--dim)]">{label}</div>
      <div className="num mt-0.5 text-sm text-[var(--text)]">{children}</div>
    </div>
  );
}

// ---------- token-rights radar hexagon ----------

// Axis order is fixed by the spec: Treasury, Revenue, Burns, Equity,
// Value Accrual, Governance — starting at the top, clockwise.
const AXES = ["Treasury", "Revenue", "Burns", "Equity", "Value Accrual", "Governance"] as const;

function axisScores(r: Rights): number[] {
  const s = r.scores;
  return [s.treasury, s.revenue, s.burns, s.equity, s.valueAccrual, s.governance];
}

function RadarHexagon({ scores, symbol }: { scores: number[] | null; symbol: string }) {
  const cx = 170;
  const cy = 148;
  const R = 86;
  const point = (i: number, r: number): [number, number] => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const ring = (frac: number) => AXES.map((_, i) => point(i, R * frac).join(",")).join(" ");
  const dataPoints =
    scores != null
      ? scores.map((s, i) => point(i, R * Math.min(1, Math.max(0, s))).join(",")).join(" ")
      : null;
  const anchors: Array<"middle" | "start" | "end"> = [
    "middle",
    "start",
    "start",
    "middle",
    "end",
    "end",
  ];
  const aria =
    scores != null
      ? `Token rights radar for ${symbol}: ${AXES.map((a, i) => `${a} ${Math.round((scores[i] ?? 0) * 100)}%`).join(", ")}`
      : `Token rights for ${symbol}: unverified — no data`;
  return (
    <svg
      viewBox="0 0 340 300"
      role="img"
      aria-label={aria}
      className="w-full max-w-[320px]"
      style={{ height: "auto" }}
    >
      {[1, 0.66, 0.33].map((f) => (
        <polygon
          key={f}
          points={ring(f)}
          fill="none"
          stroke="var(--border)"
          strokeWidth={f === 1 ? 1.5 : 1}
        />
      ))}
      {AXES.map((_, i) => {
        const [x, y] = point(i, R);
        return (
          <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" strokeWidth={1} />
        );
      })}
      {dataPoints && scores && (
        <>
          <polygon
            points={dataPoints}
            fill="var(--up)"
            fillOpacity={0.22}
            stroke="var(--up)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {scores.map((s, i) => {
            const [x, y] = point(i, R * Math.min(1, Math.max(0, s)));
            return <circle key={i} cx={x} cy={y} r={3} fill="var(--up)" />;
          })}
        </>
      )}
      {scores == null && (
        <text
          x={cx}
          y={cy + 5}
          textAnchor="middle"
          fontSize={14}
          fontWeight={600}
          fill="var(--warn)"
        >
          Unverified
        </text>
      )}
      {AXES.map((label, i) => {
        const [x, y] = point(i, R + 24);
        const dy = i === 0 ? -2 : i === 3 ? 14 : 4;
        if (label === "Value Accrual") {
          return (
            <text
              key={label}
              x={x}
              y={y + dy - 6}
              textAnchor={anchors[i]}
              fontSize={12}
              fontWeight={600}
              fill="var(--dim)"
            >
              <tspan x={x} dy={0}>
                Value
              </tspan>
              <tspan x={x} dy={14}>
                Accrual
              </tspan>
            </text>
          );
        }
        return (
          <text
            key={label}
            x={x}
            y={y + dy}
            textAnchor={anchors[i]}
            fontSize={12}
            fontWeight={600}
            fill="var(--dim)"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}

function RightsSection({ row }: { row: Row }) {
  const r = row.rights;
  return (
    <div className="mt-4 border-t border-[var(--border)] pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-[var(--text)]">Token rights</h3>
        {r?.utr && (
          <span
            className="inline-block px-1.5 py-0.5 text-[11px] font-semibold leading-tight"
            style={{ background: "var(--up)", color: "var(--bg)", borderRadius: 3 }}
          >
            UTR {r.utr}
          </span>
        )}
        <span className="text-[12px] text-[var(--dim)]">
          DeFiLlama token rights{r?.updated ? ` · updated ${fmtDate(r.updated)}` : ""}
        </span>
      </div>

      {!r ? (
        <div className="mt-2 flex flex-col items-center gap-1">
          <RadarHexagon scores={null} symbol={row.symbol} />
          <p className="max-w-md text-center text-[13px] leading-relaxed text-[var(--dim)]">
            No token-rights entry on DeFiLlama for {row.symbol} — no scores are shown
            rather than invented ones.
          </p>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-4 sm:flex-row">
          <div className="flex flex-none justify-center sm:justify-start">
            <RadarHexagon scores={axisScores(r)} symbol={row.symbol} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-[var(--dim)]">
              Primary value accrual
            </div>
            <div className="mt-0.5 text-base font-semibold text-[var(--text)]">
              {r.primaryAccrual}
            </div>
            {r.primaryAccrualDetail && (
              <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)]">
                {r.primaryAccrualDetail}
              </p>
            )}
            {r.utility.length > 0 && (
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-[var(--dim)]">
                  Utility
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {r.utility.map((u) => (
                    <span
                      key={u}
                      className="inline-block border border-[var(--border)] px-2 py-0.5 text-[12px] font-medium text-[var(--text)]"
                      style={{ borderRadius: 999 }}
                    >
                      {u}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              <Stat label="Governance">{r.governanceToken}</Stat>
              <Stat label="Treasury">{r.treasuryToken}</Stat>
              <Stat label="Revenue">{r.revenueToken}</Stat>
              <Stat label="Fee switch">{r.feeSwitch}</Stat>
              <Stat label="Buybacks">{r.buybacks}</Stat>
              <Stat label="Dividends">{r.dividends}</Stat>
              <Stat label="Burns">{r.burns}</Stat>
              <Stat label="Equity rev. capture">{r.equityCapture}</Stat>
              <Stat label="Entities">{r.entities}</Stat>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--dim)]">
              Spike length: Treasury / Revenue / Governance — whether the token
              controls it. Burns — active burns, scaled by pass-through. Equity —
              longest when no separate equity holders capture revenue. Value
              Accrual — holders-revenue share of revenue, trailing 30d.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- detail ----------

function RowDetail({ row }: { row: Row }) {
  const listingText =
    row.listing === "conversion"
      ? "Coinbase — conversion only, no USD order book"
      : row.listing === "quote-currency"
        ? "Coinbase — quote currency (no USD pair)"
        : row.pairLive === false
          ? "Coinbase — USD pair not found in latest check"
          : "Coinbase — USD order book";
  return (
    <div className="border-t border-[var(--border)] bg-[var(--space-surface-alt)] px-3 py-3 sm:px-4">
      {row.description && (
        <p className="text-sm leading-relaxed text-[var(--text)]">{row.description}</p>
      )}
      <p
        className={`${row.description ? "mt-1 " : ""}text-sm leading-relaxed text-[var(--text)]`}
      >
        {row.revenueIs}
      </p>
      <p className="mt-1 text-[13px] text-[var(--dim)]">{row.claimNote}</p>
      <RightsSection row={row} />
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--border)] pt-3 sm:grid-cols-4">
        <Stat label="Revenue, 30d">{fmtMoneyM(row.rev30dM)}</Stat>
        <Stat label="Annualised revenue (30d × 12)">{fmtMoneyM(row.runRateRevM)}</Stat>
        <Stat label="Buyback, 30d">
          <BuybackCell valueM={row.buyback30dM} />
        </Stat>
        <Stat label="Annualised buyback (30d × 12)">
          {row.buybackAnnM == null ? <BuybackCell valueM={null} /> : fmtMoneyM(row.buybackAnnM)}
        </Stat>
        <Stat label="Revenue growth vs prior 30d">{fmtPct(row.growthPct)}</Stat>
        <Stat label="Market cap">{fmtMoneyM(row.marketCapM)}</Stat>
        <Stat label="Fully diluted value">{fmtMoneyM(row.fdvM)}</Stat>
        <Stat label="Tokens outstanding">{fmtSupply(row.circSupply)}</Stat>
        <Stat label="Fully diluted tokens">{fmtSupply(row.totalSupply)}</Stat>
        <Stat label="Fees, 30d (gross)">{fmtMoneyM(row.fees30dM)}</Stat>
        <Stat label="Revenue retained">
          {row.retentionPct == null ? "n.r." : `${row.retentionPct.toFixed(0)}%`}
        </Stat>
        <Stat label="Holders share of revenue">
          {row.holdersPct == null ? "n.r." : `${row.holdersPct.toFixed(0)}%`}
        </Stat>
        <Stat label="Revenue, trailing 12m">{fmtMoneyM(row.ttmRevM)}</Stat>
        <Stat label="P / run-rate revenue (mkt cap)">{fmtMult(row.pRunRate)}</Stat>
        <Stat label="P / annualised buyback (mkt cap)">{fmtMult(row.pBuyback)}</Stat>
        <Stat label="P / revenue (TTM)">{fmtMult(row.pTtm)}</Stat>
        <Stat label="Price change, 24h">{fmtPct(row.priceChange24hPct)}</Stat>
        <Stat label="Listing">{listingText}</Stat>
      </div>
      <div
        className="mt-3 px-3 py-2 text-[13px] leading-relaxed"
        style={{ background: "var(--warn-bg)", color: "var(--text)", borderRadius: 4 }}
      >
        <span className="font-semibold" style={{ color: "var(--warn)" }}>
          Read before the multiple:{" "}
        </span>
        {row.caveat}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--dim)]">
        Buyback = DeFiLlama holders revenue: the slice of protocol revenue that reaches
        holders as buybacks, burns and staker payouts. Hyperliquid is the transparent
        case — verified 15 Nov 2026: its 30-day holders revenue equals its 30-day
        revenue exactly ($69.77M, 100% pass-through). A buyback marked “Unverified”
        means the protocol does not appear in DeFiLlama's holders-revenue feed, so no
        figure is shown rather than a wrong one. Sources: DeFiLlama (revenue, fees,
        holders revenue, token rights, protocol descriptions), CoinGecko (price,
        market cap, supplies), Coinbase Exchange API (listing).
      </p>
    </div>
  );
}

// ---------- sorting ----------

type SortKey =
  | "rank"
  | "symbol"
  | "price"
  | "marketCap"
  | "fdv"
  | "rev7d"
  | "rev30d"
  | "runRate"
  | "buyback30d"
  | "buybackAnn"
  | "buybackPct"
  | "pRunRate"
  | "pBuyback";

type SortDir = "asc" | "desc";

function sortValue(row: Row, key: SortKey): number | string | null {
  switch (key) {
    case "rank":
      return row.rank;
    case "symbol":
      return row.symbol;
    case "price":
      return row.price;
    case "marketCap":
      return row.marketCapM;
    case "fdv":
      return row.fdvM;
    case "rev7d":
      return row.rev7dM;
    case "rev30d":
      return row.rev30dM;
    case "runRate":
      return row.runRateRevM;
    case "buyback30d":
      return row.buyback30dM;
    case "buybackAnn":
      return row.buybackAnnM;
    case "buybackPct":
      return buybackPctOfRevenue(row);
    case "pRunRate":
      return row.pRunRate;
    case "pBuyback":
      return row.pBuyback;
  }
}

function compareRows(a: Row, b: Row, key: SortKey, dir: SortDir): number {
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  // Missing values (incl. unverified buybacks) always sort last.
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  const cmp =
    typeof va === "string" && typeof vb === "string"
      ? va.localeCompare(vb)
      : Number(va) - Number(vb);
  return dir === "asc" ? cmp : -cmp;
}

// ---------- columns (draggable order, persisted) ----------

const COLUMNS: Array<{
  key: SortKey;
  label: string;
  title: string;
  align: "left" | "right";
  // Fixed-layout column width in px. The symbol column's width is
  // its minimum — it flexes to absorb whatever width is left over,
  // in both the frozen header row and the body table, so the two
  // always line up.
  w: number;
}> = [
  { key: "rank", label: "#", title: "Rank by trailing 7-day revenue", align: "left", w: 44 },
  { key: "symbol", label: "Token", title: "Token", align: "left", w: 190 },
  { key: "price", label: "Price", title: "Price", align: "right", w: 96 },
  { key: "marketCap", label: "Mkt cap", title: "Market cap", align: "right", w: 96 },
  { key: "fdv", label: "FDV", title: "Fully diluted market cap", align: "right", w: 96 },
  { key: "rev7d", label: "Rev 7d", title: "Trailing 7-day revenue", align: "right", w: 88 },
  { key: "rev30d", label: "Rev 30d", title: "Trailing 30-day revenue", align: "right", w: 88 },
  { key: "runRate", label: "Ann. rev", title: "Annualised revenue (30d × 12)", align: "right", w: 96 },
  { key: "buyback30d", label: "Buyback 30d", title: "Trailing 30-day buyback", align: "right", w: 108 },
  { key: "buybackAnn", label: "Ann. buyback", title: "Annualised buyback (30d × 12)", align: "right", w: 108 },
  {
    key: "buybackPct",
    label: "Buyback % rev",
    title: "Buyback as % of revenue (30d buyback ÷ 30d revenue)",
    align: "right",
    w: 108,
  },
  {
    key: "pRunRate",
    label: "P / run-rate",
    title: "Market cap ÷ run-rate revenue",
    align: "right",
    w: 96,
  },
  {
    key: "pBuyback",
    label: "P / ann. buyback",
    title: "Market cap ÷ annualised buyback",
    align: "right",
    w: 124,
  },
];

// Total minimum table width: every column at its fixed width with
// the token column at its minimum. The width wrapper inside the
// scroll region enforces it, so narrower viewports scroll sideways
// instead of squeezing columns.
const TABLE_MIN_WIDTH = COLUMNS.reduce((s, c) => s + c.w, 0);

const COL_STORAGE_KEY = "crypto-dash-col-order-v1";

// The saved order is validated against the known columns: unknown keys
// are dropped and any column missing from the save is appended, so a
// stale or corrupt value can never hide a column.
function loadColOrder(): SortKey[] {
  const all = COLUMNS.map((c) => c.key);
  try {
    const raw = localStorage.getItem(COL_STORAGE_KEY);
    if (!raw) return all;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return all;
    const valid = parsed.filter(
      (k): k is SortKey => typeof k === "string" && (all as string[]).includes(k),
    );
    return [...new Set([...valid, ...all.filter((k) => !valid.includes(k))])];
  } catch {
    return all;
  }
}

// ---------- moon dust ----------

// Deterministic pseudo-random particles (seeded, so every render of a
// burst is stable). White dust, with a few pink / cyan motes echoing
// the neon horizon glow in the moon artwork.
interface DustParticle {
  left: number;
  bottom: number;
  size: number;
  color: string;
  dx: number;
  dy: number;
  delay: number;
  duration: number;
  opacity: number;
}

function makeParticles(count: number, seed: number): DustParticle[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const colors = ["#ffffff", "#ffffff", "#ffffff", "#ffd9ec", "#c2f3ff"];
  return Array.from({ length: count }, () => ({
    left: 2 + rnd() * 96,
    bottom: rnd() * 42,
    size: 2 + rnd() * 4,
    color: colors[Math.floor(rnd() * colors.length)] ?? "#ffffff",
    dx: (rnd() - 0.5) * 90,
    dy: -(60 + rnd() * 190),
    delay: rnd() * 0.25,
    duration: 0.75 + rnd() * 0.5,
    opacity: 0.55 + rnd() * 0.45,
  }));
}

function particleStyle(p: DustParticle): CSSProperties {
  return {
    left: `${p.left}%`,
    bottom: `${p.bottom}%`,
    width: p.size,
    height: p.size,
    background: p.color,
    boxShadow: `0 0 ${4 + p.size}px ${Math.max(1, p.size / 2)}px ${p.color}66`,
    animationDelay: `${p.delay}s`,
    animationDuration: `${p.duration}s`,
    ["--dust-dx" as string]: `${p.dx}px`,
    ["--dust-dy" as string]: `${p.dy}px`,
    ["--dust-opacity" as string]: p.opacity,
  } as CSSProperties;
}

// Burst of glowing dust while the table materializes (rising) or
// dissolves (falling back onto the surface).
function DustBurst({ falling }: { falling: boolean }) {
  const parts = useMemo(() => makeParticles(90, falling ? 1237 : 9871), [falling]);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 overflow-hidden"
      style={{ height: "72dvh" }}
    >
      {parts.map((p, i) => (
        <span
          key={i}
          className={`dust-particle ${falling ? "dust-fall" : "dust-rise"}`}
          style={particleStyle(p)}
        />
      ))}
    </div>
  );
}

// Slow ambient motes drifting over the moon while you stand on it.
function AmbientDust() {
  const parts = useMemo(() => makeParticles(26, 4242), []);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      {parts.map((p, i) => (
        <span
          key={i}
          className="dust-particle dust-ambient"
          style={{
            ...particleStyle(p),
            bottom: `${8 + p.bottom}%`,
            animationDelay: `${-p.delay * 24}s`,
            animationDuration: `${6 + p.duration * 6}s`,
          }}
        />
      ))}
    </div>
  );
}

// ---------- main app ----------

export function App() {
  // Moon scene state: the page opens on the moon — no text on it,
  // just the artwork, which has a tiny research outpost painted
  // into the surface itself: mini Jesse, back to the camera, at a
  // terminal, and a smaller chart terminal to his right. Invisible
  // hotspots over the painted terminals fly the camera into them
  // and the table / charting panel materializes out of the dust.
  // Exiting (Escape, click outside, or swipe down on the table)
  // dissolves the panel and zooms back out to the bare moon. Data
  // queries below run regardless of the phase, so prices keep
  // polling and both modules are already live the moment they
  // appear.
  const [phase, setPhase] = useState<
    | "moon"
    | "materializing"
    | "table"
    | "dissolving"
    | "chart-materializing"
    | "chart"
    | "chart-dissolving"
  >("moon");
  // Where the camera zoom is aimed (viewport %, set from the
  // clicked hotspot's on-screen centre — the hotspot sits exactly
  // over its painted terminal, so the backdrop scales up from
  // that terminal and it reads as flying into its screen).
  const [zoomOrigin, setZoomOrigin] = useState({ x: 70, y: 82 });
  const phaseTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const timers = phaseTimersRef.current;
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  const later = (fn: () => void, ms: number) => {
    phaseTimersRef.current.push(window.setTimeout(fn, ms));
  };

  // Aim the camera zoom at the clicked hotspot's centre, in
  // viewport percentages — the backdrop scales up from exactly
  // that point, so it reads as flying into that screen.
  const aimZoomAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setZoomOrigin({
      x: ((r.left + r.width / 2) / window.innerWidth) * 100,
      y: ((r.top + r.height / 2) / window.innerHeight) * 100,
    });
  };

  const revealTable = () => {
    if (phase !== "moon" && phase !== "dissolving") return;
    phaseTimersRef.current.forEach((t) => window.clearTimeout(t));
    phaseTimersRef.current = [];
    setPhase("materializing");
    later(() => setPhase("table"), 720);
  };

  const dissolveTable = () => {
    if (phase !== "table" && phase !== "materializing") return;
    phaseTimersRef.current.forEach((t) => window.clearTimeout(t));
    phaseTimersRef.current = [];
    setPhase("dissolving");
    later(() => setPhase("moon"), 560);
  };

  const openChart = () => {
    if (phase !== "moon") return;
    phaseTimersRef.current.forEach((t) => window.clearTimeout(t));
    phaseTimersRef.current = [];
    setPhase("chart-materializing");
    later(() => setPhase("chart"), 720);
  };

  const closeChart = () => {
    if (phase !== "chart" && phase !== "chart-materializing") return;
    phaseTimersRef.current.forEach((t) => window.clearTimeout(t));
    phaseTimersRef.current = [];
    setPhase("chart-dissolving");
    later(() => setPhase("moon"), 560);
  };

  const onSceneClick = (e: ReactMouseEvent) => {
    // The bare moon itself is inert now — only the two terminals
    // open anything. Clicks outside an open panel close it.
    if (phase === "table") {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-moon-panel]")) dissolveTable();
    }
    if (phase === "chart") {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-moon-panel]")) closeChart();
    }
  };

  // Escape leaves whatever is open: the panel dissolves back into
  // moon dust and the camera zooms back out to the bare moon.
  // Registered without a dependency array so the handler always
  // sees the current phase; the close functions themselves no-op
  // unless their module is up or materializing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (phase === "chart" || phase === "chart-materializing") closeChart();
      else dissolveTable();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [colOrder, setColOrder] = useState<SortKey[]>(loadColOrder);
  const [dragKey, setDragKey] = useState<SortKey | null>(null);
  const [overKey, setOverKey] = useState<SortKey | null>(null);
  const headerRefs = useRef(new Map<SortKey, HTMLElement>());
  const dragRef = useRef<{
    key: SortKey;
    startX: number;
    active: boolean;
    over: SortKey | null;
  } | null>(null);
  const suppressSortAtRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(colOrder));
    } catch {
      // Storage unavailable (private mode): the order just won't persist.
    }
  }, [colOrder]);

  const orderedColumns = useMemo(() => {
    const byKey = new Map(COLUMNS.map((c) => [c.key, c]));
    return colOrder
      .map((k) => byKey.get(k))
      .filter((c): c is (typeof COLUMNS)[number] => c != null);
  }, [colOrder]);

  // Frozen left block: every column from the left edge up to and
  // including the Token column is pinned, in the header and in every
  // row. The map holds each frozen column's sticky `left` offset —
  // the cumulative width of the frozen columns before it. Every
  // column before Token is fixed-width, so the offsets are exact;
  // Token is always the last frozen column, so its own flexible
  // width never feeds an offset. If the user drags Token elsewhere,
  // the columns left of it freeze with it — freeze-panes style.
  const frozenLeft = useMemo(() => {
    const map = new Map<SortKey, number>();
    let acc = 0;
    for (const col of orderedColumns) {
      map.set(col.key, acc);
      acc += col.w;
      if (col.key === "symbol") break;
    }
    return map;
  }, [orderedColumns]);

  const reorderColumns = (from: SortKey, to: SortKey) => {
    setColOrder((prev) => {
      const without = prev.filter((k) => k !== from);
      const idx = without.indexOf(to);
      if (idx < 0) return prev;
      const next = [...without];
      next.splice(idx, 0, from);
      return next;
    });
  };

  // Pointer-based header drag: a press that moves >8px horizontally
  // becomes a column drag; a plain tap/click still sorts. The click
  // that follows a drag is suppressed by timestamp so the two never
  // fire together. touch-action: pan-y (set on the th) keeps vertical
  // page scroll working while horizontal drags reach these handlers.
  const onHeaderPointerDown = (e: ReactPointerEvent, key: SortKey) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragRef.current = { key, startX: e.clientX, active: false, over: null };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active && Math.abs(ev.clientX - d.startX) > 8) {
        d.active = true;
        setDragKey(d.key);
      }
      if (!d.active) return;
      let target: SortKey | null = null;
      for (const k of colOrder) {
        const el = headerRefs.current.get(k);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        target = k;
        if (ev.clientX < r.left + r.width / 2) break;
      }
      d.over = target;
      setOverKey(target);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.active) {
        suppressSortAtRef.current = Date.now();
        if (commit && d.over && d.over !== d.key) reorderColumns(d.key, d.over);
      }
      setDragKey(null);
      setOverKey(null);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  // ---- swipe down to dissolve (mobile exit) ----
  // Two deliberate pull-down gestures, both touch-only (desktop keeps
  // Escape / click-outside):
  //  1. A downward drag that STARTS on the frozen header strip. The
  //     header never scrolls away, so this works no matter how far
  //     the table itself is scrolled — drag down ≥56px from the top
  //     of the table and it dissolves.
  //  2. A pull-down of ≥110px while the list is already at its very
  //     top (overscroll pull). At the top a downward drag cannot be
  //     a normal scroll — there is nothing above to scroll to — so
  //     a long pull there is unambiguously a dismiss gesture.
  // Normal scrolling never triggers either: mid-list drags start on
  // rows (not the header) with the list away from its top.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<{
    y: number;
    x: number;
    fromHeader: boolean;
    atTop: boolean;
    fired: boolean;
  } | null>(null);

  const onPanelTouchStart = (e: ReactTouchEvent) => {
    if (e.touches.length !== 1) {
      swipeRef.current = null;
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    const target = e.target as HTMLElement;
    swipeRef.current = {
      y: t.clientY,
      x: t.clientX,
      fromHeader: !!target.closest("[data-table-header]"),
      atTop: (scrollRef.current?.scrollTop ?? 0) <= 2,
      fired: false,
    };
  };

  const onPanelTouchMove = (e: ReactTouchEvent) => {
    const s = swipeRef.current;
    if (!s || s.fired || phase !== "table") return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - s.y;
    const dx = t.clientX - s.x;
    // Must be a deliberate, predominantly vertical downward pull.
    if (dy <= 0 || dy < Math.abs(dx) * 1.4) return;
    const threshold = s.fromHeader ? 56 : s.atTop ? 110 : Number.POSITIVE_INFINITY;
    if (dy >= threshold) {
      s.fired = true;
      dissolveTable();
    }
  };

  const onPanelTouchEnd = () => {
    swipeRef.current = null;
  };

  const dash = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard({}),
    staleTime: 60_000,
  });

  const prices = useQuery({
    queryKey: ["prices"],
    queryFn: () => api.getPrices({}),
    refetchInterval: 8_000,
    staleTime: 4_000,
  });

  const data = dash.data;

  // Merge live prices into revenue rows; multiples recompute from the
  // live market cap against the stored run-rate revenue and
  // annualised buyback.
  const rows = useMemo(() => {
    if (!data) return [];
    const byId = new Map<string, Prices["prices"][number]>();
    for (const p of prices.data?.prices ?? []) byId.set(p.cgId, p);
    return data.rows.map((r) => {
      const live = byId.get(r.cgId);
      if (!live) return r;
      const marketCapM = live.marketCapM ?? r.marketCapM;
      const fdvM = live.fdvM ?? r.fdvM;
      return {
        ...r,
        price: live.price ?? r.price,
        priceChange24hPct: live.priceChange24hPct ?? r.priceChange24hPct,
        marketCapM,
        fdvM,
        circSupply: live.circSupply ?? r.circSupply,
        totalSupply: live.totalSupply ?? r.totalSupply,
        circPct:
          live.circSupply != null && live.totalSupply != null && live.totalSupply > 0
            ? (live.circSupply / live.totalSupply) * 100
            : r.circPct,
        pRunRate:
          marketCapM != null && r.runRateRevM != null && r.runRateRevM > 0
            ? marketCapM / r.runRateRevM
            : r.pRunRate,
        pRunRateFdv:
          fdvM != null && r.runRateRevM != null && r.runRateRevM > 0
            ? fdvM / r.runRateRevM
            : r.pRunRateFdv,
        pBuyback:
          marketCapM != null && r.buybackAnnM != null && r.buybackAnnM > 0
            ? marketCapM / r.buybackAnnM
            : r.pBuyback,
        pBuybackFdv:
          fdvM != null && r.buybackAnnM != null && r.buybackAnnM > 0
            ? fdvM / r.buybackAnnM
            : r.pBuybackFdv,
      };
    });
  }, [data, prices.data]);

  // No-claim and not-comparable rows are never shown — filtered
  // out, full stop. The server already excludes both before its
  // top-50 slice; this is a defensive second gate so a flagged row
  // can never render even from a stale snapshot.
  const visible = useMemo(() => {
    const filtered = rows.filter((r) => r.hasClaim && r.flag !== "not-comparable");
    return [...filtered].sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [rows, sortKey, sortDir]);

  // Charting universe: every token in the revenue table plus the
  // broader majors list (BTC, ETH, SOL, ZEC, TRX, BNB, USDC, USD…),
  // deduped by CoinGecko id.
  const chartTokens = useMemo<ChartToken[]>(() => {
    const map = new Map<string, ChartToken>();
    for (const t of EXTRA_CHART_TOKENS) map.set(t.cgId, t);
    for (const r of data?.rows ?? []) {
      if (!map.has(r.cgId)) {
        map.set(r.cgId, { cgId: r.cgId, symbol: r.symbol, name: r.project });
      }
    }
    return [...map.values()];
  }, [data]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      // Rank and token read naturally ascending; every figure column
      // reads naturally largest-first.
      setSortDir(key === "rank" || key === "symbol" ? "asc" : "desc");
    }
  };

  // Body cells are DIVs in flex rows, not <td>s. position:sticky on
  // table cells is the form of sticky WebKit ignores — it is why a
  // sticky token <td> never pinned on the phone even though the
  // sticky-div header did. A sticky div cell inside a wide flex row
  // pins reliably on phone and desktop, and the rows share the
  // header's exact flex widths, so the frozen block (every column
  // up to and including Token, at the offsets in `frozenLeft`) lines
  // up with the frozen header while the stats scroll beneath it.
  const renderCell = (row: Row, col: (typeof COLUMNS)[number]) => {
    const key = col.key;
    const frozenAt = frozenLeft.get(key);
    const cellStyle: CSSProperties = {
      flex: key === "symbol" ? "1 1 auto" : `0 0 ${col.w}px`,
      minWidth: key === "symbol" ? col.w : 0,
      ...(frozenAt != null
        ? {
            position: "sticky" as const,
            left: frozenAt,
            zIndex: 5,
            background: "var(--moon-panel-solid)",
            boxShadow:
              key === "symbol" ? "inset -1px 0 0 var(--border)" : undefined,
          }
        : {}),
    };
    const cellNum =
      "num border-b border-[var(--border)] px-2 py-2.5 text-right text-sm text-[var(--text)] whitespace-nowrap overflow-hidden";
    switch (key) {
      case "rank":
        return (
          <div
            key={key}
            role="cell"
            style={cellStyle}
            className="num border-b border-[var(--border)] px-3 py-2.5 text-sm text-[var(--dim)] sm:px-4"
          >
            {row.rank}
          </div>
        );
      case "symbol": {
        const isOpen = expanded === row.symbol;
        return (
          <div
            key={key}
            role="cell"
            style={cellStyle}
            className="border-b border-[var(--border)] px-2 py-1.5"
          >
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={`${row.symbol} ${row.project} details`}
              onClick={() => setExpanded(isOpen ? null : row.symbol)}
              className="flex max-w-44 flex-wrap items-center gap-x-2 gap-y-1 text-left sm:max-w-none"
            >
              <span className="font-semibold text-[var(--text)]">{row.symbol}</span>
              <span className="truncate text-sm text-[var(--dim)]">{row.project}</span>
              <span
                className="inline-flex items-center gap-0.5 text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: isOpen ? "var(--text)" : "var(--dim)" }}
              >
                Details
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                  style={{
                    transform: isOpen ? "rotate(180deg)" : "none",
                    transition: "transform 160ms ease",
                  }}
                >
                  <path
                    d="M6 9l6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>
          </div>
        );
      }
      case "price":
        return (
          <div key={key} role="cell" style={cellStyle} className={cellNum}>
            {fmtPrice(row.price)}
          </div>
        );
      case "marketCap":
        return (
          <div key={key} role="cell" style={cellStyle} className={cellNum}>
            {fmtMoneyM(row.marketCapM)}
          </div>
        );
      case "fdv":
        return (
          <div key={key} role="cell" style={cellStyle} className={cellNum}>
            {fmtMoneyM(row.fdvM)}
          </div>
        );
      case "rev7d":
        return (
          <div key={key} role="cell" style={cellStyle} className={`${cellNum} font-medium`}>
            {fmtMoneyM(row.rev7dM)}
          </div>
        );
      case "rev30d":
        return (
          <div key={key} role="cell" style={cellStyle} className={cellNum}>
            {fmtMoneyM(row.rev30dM)}
          </div>
        );
      case "runRate":
        return (
          <div key={key} role="cell" style={cellStyle} className={cellNum}>
            {fmtMoneyM(row.runRateRevM)}
          </div>
        );
      case "buyback30d":
        return (
          <div key={key} role="cell" style={cellStyle} className={`${cellNum} font-medium`}>
            <BuybackCell valueM={row.buyback30dM} />
          </div>
        );
      case "buybackAnn":
        return (
          <div key={key} role="cell" style={cellStyle} className={cellNum}>
            {row.buybackAnnM == null ? (
              <BuybackCell valueM={null} />
            ) : (
              fmtMoneyM(row.buybackAnnM)
            )}
          </div>
        );
      case "buybackPct":
        return (
          <div key={key} role="cell" style={cellStyle} className={cellNum}>
            {fmtBuybackPct(buybackPctOfRevenue(row))}
          </div>
        );
      case "pRunRate":
        return (
          <div key={key} role="cell" style={cellStyle} className={`${cellNum} font-semibold`}>
            {fmtMult(row.pRunRate)}
          </div>
        );
      case "pBuyback":
        return (
          <div key={key} role="cell" style={cellStyle} className={`${cellNum} font-semibold`}>
            {fmtMult(row.pBuyback)}
          </div>
        );
    }
  };

  const renderRow = (row: Row) => {
    const isOpen = expanded === row.symbol;
    return (
      <Fragment key={row.symbol}>
        <div role="row" className="flex">
          {orderedColumns.map((c) => renderCell(row, c))}
        </div>
        {isOpen && (
          <div className="border-b border-[var(--border)]">
            <RowDetail row={row} />
          </div>
        )}
      </Fragment>
    );
  };

  const tableVisible =
    phase === "materializing" || phase === "table" || phase === "dissolving";
  const panelAnimClass =
    phase === "materializing"
      ? "moon-panel-materializing"
      : phase === "dissolving"
        ? "moon-panel-dissolving"
        : "";
  const chartVisible =
    phase === "chart-materializing" || phase === "chart" || phase === "chart-dissolving";
  const chartAnimClass =
    phase === "chart-materializing"
      ? "moon-panel-materializing"
      : phase === "chart-dissolving"
        ? "moon-panel-dissolving"
        : "";
  // Camera zoom on the moon backdrop: flies into the clicked
  // terminal's screen while a module materializes, holds zoomed
  // while the module is open, flies back out as it dissolves. The
  // origin is the terminal's on-screen centre (zoomOrigin).
  const bgZoomClass =
    phase === "materializing" || phase === "chart-materializing"
      ? "scene-zoom-in"
      : phase === "dissolving" || phase === "chart-dissolving"
        ? "scene-zoom-out"
        : phase === "table" || phase === "chart"
          ? "scene-zoomed"
          : "";
  const bursting =
    phase === "materializing" ||
    phase === "dissolving" ||
    phase === "chart-materializing" ||
    phase === "chart-dissolving";
  const burstFalling = phase === "dissolving" || phase === "chart-dissolving";

  return (
    <div
      className="moon-scene fixed inset-0 overflow-hidden text-[var(--text)]"
      style={{ background: "#04040a" }}
      onClick={onSceneClick}
    >
      {/* Moon backdrop — the layer the camera zoom scales. It holds
          both copies of the artwork plus the ambient dust, so the
          whole scene flies into the terminal screen together. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 ${bgZoomClass}`}
        style={{ transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%` }}
      >
        <img
          src={moonSurface}
          alt=""
          aria-hidden
          draggable={false}
          className="moon-bg pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
        />
        {/* Second, background-image copy of the moon over the <img>:
            background-size: cover fills the layer even in webviews
            where the img box comes up short, so the moon is always
            full-bleed — galaxy on top, surface to the bottom edge. */}
        <div
          aria-hidden
          className="moon-bg-layer pointer-events-none absolute inset-0 select-none"
          style={{ backgroundImage: `url(${moonSurface})` }}
        />
        <AmbientDust />
      </div>
      {/* Safe-area top inset (was the SDK SafeAreaTopScrim): a plain spacer using the CSS env() inset, no SDK. */}
      <div aria-hidden style={{ height: "env(safe-area-inset-top)" }} />
      {bursting && <DustBurst falling={burstFalling} />}

      {phase === "moon" && (
        // Invisible hotspots over the terminals painted into the
        // moon artwork — there is no terminal UI on the moon at
        // all, just the scene itself. The stage box replicates the
        // artwork's cover-fit geometry exactly (see .moon-stage in
        // theme.css), so a hotspot placed at image-fraction
        // coordinates stays glued to its painted terminal at any
        // viewport size and under the phone crop. The buttons
        // render nothing at all — no border, no background, no
        // glow, no label, not even a pointer cursor — so the
        // outpost reads as pure scenery: mini Jesse, back to the
        // camera, at his terminal (opens the token table), and
        // the smaller chart terminal to his right (opens
        // charting). Clicking one aims the camera zoom at the
        // painted terminal's centre (aimZoomAt reads the hotspot's
        // on-screen rect) and the module materializes out of the
        // dust as the backdrop flies in. Hotspot boxes are padded
        // generously around the painted figures so the tiny scene
        // is easy to hit despite being visually small.
        // Painted positions (image fractions, located in the
        // artwork): Jesse + his terminal x 65–74%, y 75–89%;
        // chart terminal x 77–82%, y 83–89%. The outpost sits in
        // the lower-centre-right on purpose: it is inside the
        // visible window of BOTH cover crops — the desktop
        // centred crop and the phone crop biased 80% toward
        // Earth (visible ≈ image x 54–86% on portrait phones) —
        // so the scene and its hotspots are on screen everywhere.
        <div className="moon-stage z-20">
          <button
            type="button"
            aria-label="Open the token revenue table"
            onClick={(e) => {
              e.stopPropagation();
              aimZoomAt(e.currentTarget);
              revealTable();
            }}
            className="absolute cursor-default"
            style={{
              left: "63%",
              top: "71%",
              width: "12%",
              height: "22%",
              background: "transparent",
              border: "none",
              padding: 0,
            }}
          />
          <button
            type="button"
            aria-label="Open charting — token pair charts"
            onClick={(e) => {
              e.stopPropagation();
              aimZoomAt(e.currentTarget);
              openChart();
            }}
            className="absolute cursor-default"
            style={{
              left: "75.5%",
              top: "79%",
              width: "8%",
              height: "14%",
              background: "transparent",
              border: "none",
              padding: 0,
            }}
          />
        </div>
      )}

      {tableVisible && (
        <main
          data-moon-panel
          className={`relative z-10 mx-auto w-full max-w-7xl px-2 pb-3 pt-3 sm:px-4 sm:pt-4 ${panelAnimClass}`}
        >
          {/* Frozen header, third construction — the first two put
              position:sticky on the <th> cells and the header still
              scrolled away in the real client. Now the header is a
              plain sticky DIV (the form of sticky every engine
              honours) at the top of the panel's single scroll
              region, inside a min-width wrapper so it also rides
              the horizontal scroll in lockstep with the rows. The
              body table below uses fixed layout with the same
              column widths; the token column flexes in both, so
              header and rows always line up. */}
          <div
            className="flex flex-col overflow-hidden"
            onTouchStart={onPanelTouchStart}
            onTouchMove={onPanelTouchMove}
            onTouchEnd={onPanelTouchEnd}
            onTouchCancel={onPanelTouchEnd}
            style={{
              background: "var(--moon-panel)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              border: "1px solid rgba(255,255,255,0.45)",
              borderRadius: 14,
              boxShadow:
                "0 24px 70px rgba(0,0,0,0.45), 0 0 42px rgba(255,255,255,0.22)",
              height: "calc(100dvh - 1.5rem)",
              maxHeight: "calc(100dvh - 1.5rem)",
            }}
          >

        {dash.isPending && (
          <p className="px-4 py-16 text-center text-sm text-[var(--dim)] sm:px-0">
            Fetching revenue, buybacks and prices…
          </p>
        )}
        {dash.error && (
          <div className="px-4 py-16 text-center sm:px-0">
            <p className="text-sm text-[var(--down)]">
              The dashboard could not load: {String(dash.error)}
            </p>
            <button
              type="button"
              aria-label="Retry loading the dashboard"
              onClick={() => dash.refetch()}
              className="mt-3 border border-[var(--border)] px-3 py-1.5 text-sm font-medium"
              style={{ borderRadius: 6 }}
            >
              Retry
            </button>
          </div>
        )}

        {data && (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
            <div style={{ minWidth: TABLE_MIN_WIDTH }}>
              <div
                role="row"
                data-table-header
                className="sticky top-0 z-20 flex"
                style={{
                  background: "var(--moon-panel-solid)",
                  boxShadow: "inset 0 -2px 0 var(--text)",
                }}
              >
                {orderedColumns.map((col) => {
                  const active = sortKey === col.key;
                  const isDragged = dragKey === col.key;
                  const isTarget =
                    overKey === col.key && dragKey != null && dragKey !== col.key;
                  const frozenAt = frozenLeft.get(col.key);
                  return (
                    <div
                      key={col.key}
                      ref={(el) => {
                        if (el) headerRefs.current.set(col.key, el);
                        else headerRefs.current.delete(col.key);
                      }}
                      role="columnheader"
                      aria-sort={
                        active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                      }
                      onPointerDown={(e) => onHeaderPointerDown(e, col.key)}
                      className={`py-1.5 text-[11px] uppercase tracking-wide ${
                        col.align === "right" ? "text-right" : "text-left"
                      } ${col.key === "rank" ? "px-3 sm:px-4" : "px-2"}`}
                      style={{
                        touchAction: "pan-y",
                        cursor: "grab",
                        flex:
                          col.key === "symbol"
                            ? "1 1 auto"
                            : `0 0 ${col.w}px`,
                        minWidth: col.key === "symbol" ? col.w : undefined,
                        opacity: isDragged ? 0.45 : undefined,
                        // Frozen-block header cells are the corner
                        // of the two freezes: they ride the sticky-top
                        // header row AND stick to the left at their
                        // frozen offsets, aligned with their body
                        // cells, while the other headers scroll under.
                        position: frozenAt != null ? "sticky" : undefined,
                        left: frozenAt,
                        zIndex: frozenAt != null ? 3 : undefined,
                        background:
                          frozenAt != null
                            ? "var(--moon-panel-solid)"
                            : undefined,
                        boxShadow: isTarget
                          ? "inset 3px 0 0 var(--accent)"
                          : col.key === "symbol"
                            ? "inset -1px 0 0 var(--border)"
                            : undefined,
                        userSelect: dragKey != null ? "none" : undefined,
                      }}
                    >
                      <button
                        type="button"
                        aria-label={`Sort by ${col.title}${active ? `, currently ${sortDir === "asc" ? "ascending" : "descending"}` : ""}. Drag header to reorder.`}
                        onClick={() => {
                          // A drag ends with a click on some browsers —
                          // never let it also sort.
                          if (Date.now() - suppressSortAtRef.current < 400) return;
                          toggleSort(col.key);
                        }}
                        className="whitespace-nowrap font-semibold uppercase tracking-wide"
                        style={{ color: active ? "var(--text)" : "var(--dim)" }}
                      >
                        {col.label}
                        {active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div
                role="table"
                aria-label="Top 50 tokens by trailing 7-day protocol revenue. Every column header sorts ascending and descending when tapped, and can be dragged to reorder the columns."
                className="w-full"
              >
                {visible.map(renderRow)}
              </div>
              {visible.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-[var(--dim)]">
                  No rows to show.
                </p>
              )}
            </div>
          </div>
        )}
          </div>
        </main>
      )}

      {chartVisible && (
        <main
          data-moon-panel
          className={`relative z-10 mx-auto w-full max-w-5xl px-2 pb-3 pt-3 sm:px-4 sm:pt-4 ${chartAnimClass}`}
        >
          <div
            className="overflow-auto"
            style={{
              background: "var(--moon-panel)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              border: "1px solid rgba(255,255,255,0.45)",
              borderRadius: 14,
              boxShadow:
                "0 24px 70px rgba(0,0,0,0.45), 0 0 42px rgba(255,255,255,0.22)",
              maxHeight: "calc(100dvh - 1.5rem)",
            }}
          >
            <ChartModule tokens={chartTokens} onClose={() => closeChart()} />
          </div>
        </main>
      )}
    </div>
  );
}
