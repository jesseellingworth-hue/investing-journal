// Charting module — opened by tapping Earth on the moon. Daily pair
// charts (base ÷ quote) from the getPairSeries action (DeFiLlama
// daily USD closes, full history back to each token's first trade).
// Interactions: drag to pan, mouse wheel / + − buttons to zoom the
// date axis, two-finger pinch to zoom (horizontal finger spread
// zooms the dates, vertical spread zooms the price axis — otherwise
// the price axis re-fits the visible window on every zoom and pan),
// 5Y and Max ranges for the full available history, a regression
// Trend overlay, and a Draw mode: press on a snapped daily close,
// drag while holding to preview the line snapping to the next
// close, release to place it; lines extend across the whole chart.
// Plain black-on-white line, direct labels, source on the chart.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface ChartToken {
  cgId: string;
  symbol: string;
  name: string;
}

// Broader charting universe beyond the revenue table: the majors and
// other widely held tokens, plus USD as a pseudo-token (the server
// treats the id "usd" as the constant 1).
export const EXTRA_CHART_TOKENS: ChartToken[] = [
  { cgId: "usd", symbol: "USD", name: "US Dollar" },
  { cgId: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { cgId: "ethereum", symbol: "ETH", name: "Ethereum" },
  { cgId: "solana", symbol: "SOL", name: "Solana" },
  { cgId: "binancecoin", symbol: "BNB", name: "BNB" },
  { cgId: "zcash", symbol: "ZEC", name: "Zcash" },
  { cgId: "tron", symbol: "TRX", name: "TRON" },
  { cgId: "usd-coin", symbol: "USDC", name: "USD Coin" },
  { cgId: "tether", symbol: "USDT", name: "Tether" },
  { cgId: "ripple", symbol: "XRP", name: "XRP" },
  { cgId: "cardano", symbol: "ADA", name: "Cardano" },
  { cgId: "dogecoin", symbol: "DOGE", name: "Dogecoin" },
  { cgId: "avalanche-2", symbol: "AVAX", name: "Avalanche" },
  { cgId: "polkadot", symbol: "DOT", name: "Polkadot" },
  { cgId: "cosmos", symbol: "ATOM", name: "Cosmos" },
  { cgId: "litecoin", symbol: "LTC", name: "Litecoin" },
  { cgId: "stellar", symbol: "XLM", name: "Stellar" },
  { cgId: "hedera-hashgraph", symbol: "HBAR", name: "Hedera" },
  { cgId: "near", symbol: "NEAR", name: "NEAR Protocol" },
  { cgId: "sui", symbol: "SUI", name: "Sui" },
  { cgId: "arbitrum", symbol: "ARB", name: "Arbitrum" },
  { cgId: "internet-computer", symbol: "ICP", name: "Internet Computer" },
  { cgId: "bitcoin-cash", symbol: "BCH", name: "Bitcoin Cash" },
  { cgId: "chainlink", symbol: "LINK", name: "Chainlink" },
  { cgId: "polygon-ecosystem-token", symbol: "POL", name: "Polygon" },
  { cgId: "hyperliquid", symbol: "HYPE", name: "Hyperliquid" },
];

const RANGES = [
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "2Y", days: 730 },
  { label: "5Y", days: 1825 },
  // Far beyond any token's history: the server returns everything
  // it has, so Max is each pair's full available history.
  { label: "Max", days: 36500 },
] as const;

type Pt = { t: number; v: number };
type DrawnLine = { t1: number; v1: number; t2: number; v2: number };

const DAY_MS = 86_400_000;
const DRAW_COLOR = "#d6336c";

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  if (a >= 0.01) return v.toFixed(4);
  const exp = Math.floor(Math.log10(a));
  return v.toFixed(Math.min(12, -exp + 2));
}

function fmtPct(x: number): string {
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(1)}%`;
}

function fmtDateFull(t: number): string {
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtDateShort(t: number): string {
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export function ChartModule({
  tokens,
  onClose,
}: {
  tokens: ChartToken[];
  onClose: () => void;
}) {
  const [baseId, setBaseId] = useState("hyperliquid");
  const [quoteId, setQuoteId] = useState("bitcoin");
  const [days, setDays] = useState<number>(730);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  // Price-axis zoom from a vertical pinch. Null = the price axis
  // auto-fits the visible window, as it always has.
  const [yZoom, setYZoom] = useState<[number, number] | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [lines, setLines] = useState<DrawnLine[]>([]);
  const [pending, setPending] = useState<Pt | null>(null);
  const [showTrend, setShowTrend] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [drawHover, setDrawHover] = useState<Pt | null>(null);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{
    startPx: number;
    startPy: number;
    origMin: number;
    origMax: number;
    origYMin: number;
    origYMax: number;
  } | null>(null);
  // Every finger / pointer currently on the plot, in svg coords —
  // two of them make a pinch.
  const pointersRef = useRef(new Map<number, { px: number; py: number }>());
  const pinchRef = useRef<{
    anchorT: number;
    anchorV: number;
    startSpanX: number;
    startSpanY: number;
    startDx: number;
    startDy: number;
  } | null>(null);
  // A draw press in progress: the line's start anchor, held until
  // the press is released on a different snapped close.
  const drawDragRef = useRef<{ pointerId: number; anchor: Pt } | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(680);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const options = useMemo(
    () => [...tokens].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [tokens],
  );
  const baseSym = tokens.find((t) => t.cgId === baseId)?.symbol ?? baseId;
  const quoteSym = tokens.find((t) => t.cgId === quoteId)?.symbol ?? quoteId;
  const sameToken = baseId === quoteId;

  const series = useQuery({
    queryKey: ["pair-series", baseId, quoteId, days],
    queryFn: () => api.getPairSeries({ baseId, quoteId, days }),
    enabled: !sameToken,
    staleTime: 10 * 60_000,
  });
  const points = useMemo<Pt[]>(() => series.data?.points ?? [], [series.data]);

  // A new pair or range invalidates the view state — drawn lines are
  // in the old pair's coordinates and mean nothing carried over.
  useEffect(() => {
    setZoom(null);
    setYZoom(null);
    setLines([]);
    setPending(null);
    setHoverIdx(null);
    setDrawHover(null);
    panRef.current = null;
    pinchRef.current = null;
    drawDragRef.current = null;
    pointersRef.current.clear();
    setPanning(false);
  }, [baseId, quoteId, days]);

  const visible = useMemo<Pt[]>(() => {
    if (!zoom) return points;
    const f = points.filter((p) => p.t >= zoom[0] && p.t <= zoom[1]);
    return f.length >= 2 ? f : points;
  }, [points, zoom]);

  // ---- geometry ----
  const W = Math.max(300, width);
  const H = Math.min(440, Math.max(250, Math.round(W * 0.52)));
  const ML = 10;
  const MR = 60;
  const MT = 12;
  const MB = 26;
  const plotW = W - ML - MR;
  const plotH = H - MT - MB;

  const first = visible[0];
  const last = visible[visible.length - 1];
  const hasChart = visible.length >= 2 && first != null && last != null;

  let xMin = 0;
  let xMax = 1;
  let yMin = 0;
  let yMax = 1;
  if (hasChart) {
    xMin = first.t;
    xMax = last.t;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of visible) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    const pad = (hi - lo) * 0.08 || hi * 0.05 || 1;
    // Ratios and prices are never negative — don't let the padding
    // push the axis below zero into a meaningless negative tick.
    yMin = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
    yMax = hi + pad;
  }
  // A vertical pinch overrides the auto-fit until Reset.
  if (hasChart && yZoom) {
    yMin = yZoom[0];
    yMax = yZoom[1];
  }
  const x = (t: number) =>
    xMax > xMin ? ML + ((t - xMin) / (xMax - xMin)) * plotW : ML + plotW / 2;
  const y = (v: number) =>
    yMax > yMin ? MT + (1 - (v - yMin) / (yMax - yMin)) * plotH : MT + plotH / 2;
  const tAt = (px: number) => xMin + ((px - ML) / plotW) * (xMax - xMin);
  const vAt = (py: number) =>
    yMax > yMin ? yMax - ((py - MT) / plotH) * (yMax - yMin) : yMax;

  const geomRef = useRef({ xMin, xMax, ML, plotW, fullMin: 0, fullMax: 0 });
  geomRef.current = {
    xMin,
    xMax,
    ML,
    plotW,
    fullMin: points[0]?.t ?? 0,
    fullMax: points[points.length - 1]?.t ?? 0,
  };

  const applyZoom = (nMin: number, nMax: number) => {
    const fMin = points[0]?.t;
    const fMax = points[points.length - 1]?.t;
    if (fMin == null || fMax == null) return;
    let span = nMax - nMin;
    const fullSpan = fMax - fMin;
    span = Math.max(7 * DAY_MS, Math.min(fullSpan, span));
    let lo = nMin;
    let hi = lo + span;
    if (lo < fMin) {
      lo = fMin;
      hi = lo + span;
    }
    if (hi > fMax) {
      hi = fMax;
      lo = hi - span;
    }
    if (lo <= fMin && hi >= fMax) setZoom(null);
    else setZoom([lo, hi]);
  };

  // Price-axis zoom (vertical pinch / vertical pan while zoomed).
  // Clamped to the pair's full value range plus a small margin;
  // zooming back out to the whole range returns to auto-fit.
  const applyYZoom = (nMin: number, nMax: number) => {
    if (points.length === 0) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const fullSpan = hi - lo || Math.abs(hi) * 0.1 || 1;
    const span = Math.max(fullSpan * 0.02, Math.min(fullSpan, nMax - nMin));
    if (span >= fullSpan * 0.999) {
      setYZoom(null);
      return;
    }
    const pad = fullSpan * 0.1;
    let a = nMin;
    let b = a + span;
    if (a < lo - pad) {
      a = lo - pad;
      b = a + span;
    }
    if (b > hi + pad) {
      b = hi + pad;
      a = b - span;
    }
    setYZoom([a, b]);
  };

  const zoomBy = (factor: number) => {
    if (!hasChart) return;
    const center = (xMin + xMax) / 2;
    const span = (xMax - xMin) * factor;
    applyZoom(center - span / 2, center + span / 2);
  };

  // Mouse-wheel zoom around the cursor (desktop). Attached natively
  // so preventDefault can stop the panel scrolling under the chart.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      const g = geomRef.current;
      if (g.fullMax <= g.fullMin || g.plotW <= 0) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (W / rect.width);
      const frac = Math.min(1, Math.max(0, (px - g.ML) / g.plotW));
      const center = g.xMin + frac * (g.xMax - g.xMin);
      const span = (g.xMax - g.xMin) * (e.deltaY > 0 ? 1.25 : 0.8);
      applyZoom(center - frac * span, center + (1 - frac) * span);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  });

  // ---- derived chart data ----
  const linePath = hasChart
    ? visible
        .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
        .join(" ")
    : "";
  const areaPath =
    hasChart && first && last
      ? `${linePath} L${x(last.t).toFixed(1)},${(MT + plotH).toFixed(1)} L${x(first.t).toFixed(1)},${(MT + plotH).toFixed(1)} Z`
      : "";

  const yTicks = hasChart
    ? Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4)
    : [];
  const xTickIdx = hasChart
    ? Array.from({ length: 5 }, (_, i) =>
        Math.round(((visible.length - 1) * i) / 4),
      )
    : [];

  const stats = useMemo(() => {
    if (!hasChart || !first || !last) return null;
    let hi = first;
    let lo = first;
    for (const p of visible) {
      if (p.v > hi.v) hi = p;
      if (p.v < lo.v) lo = p;
    }
    return {
      change: (last.v / first.v - 1) * 100,
      hi,
      lo,
    };
  }, [hasChart, first, last, visible]);

  const trend = useMemo(() => {
    if (!showTrend || !hasChart) return null;
    const n = visible.length;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += visible[i]?.v ?? 0;
    }
    const mx = sx / n;
    const my = sy / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - mx) * ((visible[i]?.v ?? 0) - my);
      den += (i - mx) * (i - mx);
    }
    if (den === 0) return null;
    const slope = num / den;
    const intercept = my - slope * mx;
    const v0 = intercept;
    const v1 = intercept + slope * (n - 1);
    return {
      v0,
      v1,
      pct: v0 !== 0 ? (v1 / v0 - 1) * 100 : 0,
    };
  }, [showTrend, hasChart, visible]);

  // ---- pointer interactions ----
  const svgPoint = (e: React.PointerEvent): { px: number; py: number } => {
    const svg = svgRef.current;
    if (!svg) return { px: 0, py: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      px: (e.clientX - rect.left) * (W / rect.width),
      py: (e.clientY - rect.top) * (H / rect.height),
    };
  };

  const nearestIdx = (px: number): number => {
    const t = tAt(px);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < visible.length; i++) {
      const p = visible[i];
      if (!p) continue;
      const d = Math.abs(p.t - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  // Draw-mode snap: the closest daily close to the pointer in
  // on-screen distance, so a tap lands on the point it looks like
  // it lands on, not just the nearest date.
  const nearestPointPx = (px: number, py: number): Pt | undefined => {
    let best: Pt | undefined;
    let bestD = Infinity;
    for (const p of visible) {
      const dx = x(p.t) - px;
      const dy = y(p.v) - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  // A drawn line is not just the segment between its two anchors:
  // it extends across the whole visible window, evaluated at the
  // window's edge dates (the SVG clips it to the plot area). It is
  // recomputed from the stored anchors on every render, so it stays
  // extended correctly through zooms and pans.
  const extendLine = (ln: DrawnLine) => {
    if (!hasChart || ln.t2 === ln.t1) return null;
    const slope = (ln.v2 - ln.v1) / (ln.t2 - ln.t1);
    return {
      x1: x(xMin),
      y1: y(ln.v1 + slope * (xMin - ln.t1)),
      x2: x(xMax),
      y2: y(ln.v1 + slope * (xMax - ln.t1)),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasChart) return;
    const { px, py } = svgPoint(e);
    pointersRef.current.set(e.pointerId, { px, py });
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety; the gestures still work without it.
    }
    if (pointersRef.current.size === 2) {
      // Second finger down: pinch takes over from pan / draw. The
      // data point under the fingers' midpoint is the anchor both
      // axes zoom around.
      const [a, b] = [...pointersRef.current.values()];
      if (a && b) {
        pinchRef.current = {
          anchorT: tAt((a.px + b.px) / 2),
          anchorV: vAt((a.py + b.py) / 2),
          startSpanX: xMax - xMin,
          startSpanY: yMax - yMin,
          startDx: Math.abs(a.px - b.px),
          startDy: Math.abs(a.py - b.py),
        };
      }
      panRef.current = null;
      setPanning(false);
      drawDragRef.current = null;
      setDrawHover(null);
      return;
    }
    if (pointersRef.current.size > 2) return;
    if (drawMode) {
      // Press-and-hold draw: the press lands on the snapped daily
      // close under the finger and becomes the line's start. The
      // line itself is placed on release (see onPointerUp); a plain
      // tap leaves the anchor pending so a second press can still
      // finish the line tap-tap style.
      const snapped = nearestPointPx(px, py);
      if (!snapped) return;
      if (!pending) setPending(snapped);
      drawDragRef.current = { pointerId: e.pointerId, anchor: pending ?? snapped };
      setDrawHover(snapped);
      return;
    }
    // Dragging pans — but only when zoomed in on either axis; at
    // the full range there is nowhere to pan to.
    if (!zoom && !yZoom) return;
    panRef.current = {
      startPx: px,
      startPy: py,
      origMin: xMin,
      origMax: xMax,
      origYMin: yMin,
      origYMax: yMax,
    };
    setPanning(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!hasChart) return;
    const { px, py } = svgPoint(e);
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { px, py });
    }
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      if (a && b) {
        const midPx = (a.px + b.px) / 2;
        const midPy = (a.py + b.py) / 2;
        // Horizontal finger spread zooms the date axis, vertical
        // spread zooms the price axis, independently; the anchored
        // data point stays under the fingers' midpoint. The 24px
        // floor keeps a nearly-vertical (or horizontal) pinch from
        // exploding the other axis' ratio.
        const spanX =
          pinch.startSpanX *
          (Math.max(24, pinch.startDx) / Math.max(24, Math.abs(a.px - b.px)));
        const fracX = Math.min(1, Math.max(0, (midPx - ML) / plotW));
        applyZoom(pinch.anchorT - fracX * spanX, pinch.anchorT + (1 - fracX) * spanX);
        const spanY =
          pinch.startSpanY *
          (Math.max(24, pinch.startDy) / Math.max(24, Math.abs(a.py - b.py)));
        const fracY = Math.min(1, Math.max(0, (midPy - MT) / plotH));
        const nYMax = pinch.anchorV + fracY * spanY;
        applyYZoom(nYMax - spanY, nYMax);
      }
      return;
    }
    const pan = panRef.current;
    if (pan) {
      // Shift the window by the drag distance; applyZoom clamps it
      // inside the loaded range, and the price axis re-fits the new
      // window's points automatically — unless it was pinch-zoomed,
      // in which case the drag pans it vertically too.
      const dt = -((px - pan.startPx) / plotW) * (pan.origMax - pan.origMin);
      applyZoom(pan.origMin + dt, pan.origMax + dt);
      if (yZoom) {
        const dv = ((py - pan.startPy) / plotH) * (pan.origYMax - pan.origYMin);
        applyYZoom(pan.origYMin + dv, pan.origYMax + dv);
      }
      return;
    }
    if (drawMode) {
      setDrawHover(nearestPointPx(px, py) ?? null);
    } else {
      setHoverIdx(nearestIdx(px));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pinchRef.current && pointersRef.current.size < 2) {
      pinchRef.current = null;
    }
    const dd = drawDragRef.current;
    if (dd && dd.pointerId === e.pointerId) {
      // Release places the line: it ends at the snapped daily close
      // under the finger right now. Releasing on the anchor itself
      // (a plain tap) leaves it pending instead of drawing a
      // zero-length line.
      if (hasChart) {
        const { px, py } = svgPoint(e);
        const end = nearestPointPx(px, py);
        if (end && (end.t !== dd.anchor.t || end.v !== dd.anchor.v)) {
          setLines((prev) => [
            ...prev,
            { t1: dd.anchor.t, v1: dd.anchor.v, t2: end.t, v2: end.v },
          ]);
          setPending(null);
        }
      }
      drawDragRef.current = null;
    }
    panRef.current = null;
    setPanning(false);
  };

  const hoverPt = hoverIdx != null ? visible[hoverIdx] : undefined;
  const readoutPt = hoverPt ?? last;

  const selectClass =
    "border border-[var(--border)] bg-[var(--moon-panel-solid)] px-2 py-1.5 text-sm font-semibold text-[var(--text)]";
  const btnClass =
    "border border-[var(--border)] bg-[var(--moon-panel-solid)] px-2.5 py-1.5 text-[13px] font-semibold text-[var(--text)]";
  const activeBtnStyle = { background: "var(--accent)", color: "var(--bg)" } as const;

  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold leading-tight text-[var(--text)]">
            {baseSym} / {quoteSym}
          </h2>
          <p className="text-[13px] text-[var(--dim)]">
            Daily pair ratio · {RANGES.find((r) => r.days === days)?.label ?? ""} ·{" "}
            {points.length > 0 && points[0]
              ? `${fmtDateFull(points[0].t)} – ${fmtDateFull(points[points.length - 1]?.t ?? points[0].t)}`
              : "daily closes"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close charting — back to the moon"
          onClick={onClose}
          className="flex-none border border-[var(--border)] px-2.5 py-1 text-sm font-semibold text-[var(--dim)]"
          style={{ borderRadius: 999, background: "var(--moon-panel-solid)" }}
        >
          ✕
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--dim)]">
          Base
          <select
            aria-label="Base token"
            value={baseId}
            onChange={(e) => setBaseId(e.target.value)}
            className={selectClass}
            style={{ borderRadius: 8 }}
          >
            {options.map((t) => (
              <option key={t.cgId} value={t.cgId}>
                {t.symbol} — {t.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label="Swap base and quote tokens"
          onClick={() => {
            setBaseId(quoteId);
            setQuoteId(baseId);
          }}
          className={btnClass}
          style={{ borderRadius: 8 }}
        >
          ⇄
        </button>
        <label className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--dim)]">
          Quote
          <select
            aria-label="Quote token"
            value={quoteId}
            onChange={(e) => setQuoteId(e.target.value)}
            className={selectClass}
            style={{ borderRadius: 8 }}
          >
            {options.map((t) => (
              <option key={t.cgId} value={t.cgId}>
                {t.symbol} — {t.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              aria-pressed={days === r.days}
              aria-label={`Show ${r.label} of history`}
              onClick={() => setDays(r.days)}
              className={btnClass}
              style={days === r.days ? { ...activeBtnStyle, borderRadius: 8 } : { borderRadius: 8 }}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomBy(0.6)}
            className={btnClass}
            style={{ borderRadius: 8 }}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomBy(1.6)}
            className={btnClass}
            style={{ borderRadius: 8 }}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Reset zoom to the full range"
            onClick={() => {
              setZoom(null);
              setYZoom(null);
            }}
            disabled={!zoom && !yZoom}
            className={btnClass}
            style={{ borderRadius: 8, opacity: zoom || yZoom ? 1 : 0.45 }}
          >
            Reset
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={showTrend}
            aria-label="Toggle regression trend line"
            onClick={() => setShowTrend(!showTrend)}
            className={btnClass}
            style={showTrend ? { ...activeBtnStyle, borderRadius: 8 } : { borderRadius: 8 }}
          >
            Trend
          </button>
          <button
            type="button"
            aria-pressed={drawMode}
            aria-label="Toggle draw mode — press a point, drag to another point, release to draw a line"
            onClick={() => {
              setDrawMode(!drawMode);
              setPending(null);
              drawDragRef.current = null;
            }}
            className={btnClass}
            style={drawMode ? { ...activeBtnStyle, borderRadius: 8 } : { borderRadius: 8 }}
          >
            Draw
          </button>
          {lines.length > 0 && (
            <button
              type="button"
              aria-label="Clear drawn lines"
              onClick={() => {
                setLines([]);
                setPending(null);
              }}
              className={btnClass}
              style={{ borderRadius: 8 }}
            >
              Clear lines
            </button>
          )}
        </div>
      </div>

      <div className="num mt-3 flex min-h-6 flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] text-[var(--dim)]">
        {sameToken ? (
          <span>Pick two different tokens to chart their ratio.</span>
        ) : series.isPending ? (
          <span>Loading daily price history…</span>
        ) : series.error ? (
          <span style={{ color: "var(--down)" }}>
            Price history could not load.{" "}
            <button
              type="button"
              aria-label="Retry loading price history"
              onClick={() => series.refetch()}
              className="font-semibold underline"
            >
              Retry
            </button>
          </span>
        ) : !hasChart ? (
          <span>
            No overlapping daily history for {baseSym} / {quoteSym} in this window.
          </span>
        ) : (
          readoutPt && (
            <>
              <span className="font-semibold text-[var(--text)]">
                {fmtDateFull(readoutPt.t)}
              </span>
              <span>
                {baseSym}/{quoteSym} {fmtVal(readoutPt.v)}
              </span>
              {first && (
                <span>
                  {fmtPct((readoutPt.v / first.v - 1) * 100)} vs window start
                </span>
              )}
              {stats && (
                <>
                  <span>Window {fmtPct(stats.change)}</span>
                  <span>
                    High {fmtVal(stats.hi.v)} · {fmtDateShort(stats.hi.t)}
                  </span>
                  <span>
                    Low {fmtVal(stats.lo.v)} · {fmtDateShort(stats.lo.t)}
                  </span>
                </>
              )}
              {trend && <span>Trend {fmtPct(trend.pct)} (regression)</span>}
              {drawMode && (
                <span>
                  {pending
                    ? "Drag to a second daily close and release to finish the line — it extends across the whole chart."
                    : "Press a daily close, drag to another close, and release to draw. Lines snap to closes, one at a time."}
                </span>
              )}
            </>
          )
        )}
      </div>

      <div ref={wrapRef} className="mt-1 w-full">
        {hasChart && (
          <svg
            ref={svgRef}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${baseSym} to ${quoteSym} daily ratio chart, ${fmtDateFull(first?.t ?? 0)} to ${fmtDateFull(last?.t ?? 0)}`}
            style={{
              touchAction: "none",
              display: "block",
              maxWidth: "100%",
              cursor: drawMode ? "crosshair" : panning ? "grabbing" : zoom ? "grab" : "default",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              // With pointer capture a press keeps its move/up events
              // even off the edge; only clear hover state when no
              // press is in flight.
              if (pointersRef.current.size > 0) return;
              setHoverIdx(null);
              setDrawHover(null);
              panRef.current = null;
              setPanning(false);
            }}
          >
            <defs>
              <clipPath id="chart-plot-clip">
                <rect x={ML} y={MT} width={plotW} height={plotH} />
              </clipPath>
            </defs>
            {yTicks.map((tv, i) => (
              <g key={i}>
                <line
                  x1={ML}
                  x2={ML + plotW}
                  y1={y(tv)}
                  y2={y(tv)}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <text
                  x={ML + plotW + 6}
                  y={y(tv) + 4}
                  fontSize={11}
                  fill="var(--dim)"
                  className="num"
                >
                  {fmtVal(tv)}
                </text>
              </g>
            ))}
            {xTickIdx.map((idx, i) => {
              const p = visible[idx];
              if (!p) return null;
              // Edge ticks anchor inward so their labels never clip
              // off the sides of the plot.
              const anchor =
                i === 0 ? "start" : i === xTickIdx.length - 1 ? "end" : "middle";
              return (
                <text
                  key={i}
                  x={x(p.t)}
                  y={H - 6}
                  textAnchor={anchor}
                  fontSize={11}
                  fill="var(--dim)"
                  className="num"
                >
                  {fmtDateShort(p.t)}
                </text>
              );
            })}
            <g clipPath="url(#chart-plot-clip)">
              <path d={areaPath} fill="var(--accent)" opacity={0.07} />
              <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={1.8} />
              {trend && first && last && (
                <line
                  x1={x(first.t)}
                  x2={x(last.t)}
                  y1={y(trend.v0)}
                  y2={y(trend.v1)}
                  stroke="var(--dim)"
                  strokeWidth={1.4}
                  strokeDasharray="5 4"
                />
              )}
              {lines.map((ln, i) => {
                const ext = extendLine(ln);
                if (!ext) return null;
                return (
                  <g key={i} stroke={DRAW_COLOR}>
                    <line
                      x1={ext.x1}
                      x2={ext.x2}
                      y1={ext.y1}
                      y2={ext.y2}
                      strokeWidth={1.6}
                    />
                    <circle cx={x(ln.t1)} cy={y(ln.v1)} r={3} fill={DRAW_COLOR} stroke="none" />
                    <circle cx={x(ln.t2)} cy={y(ln.v2)} r={3} fill={DRAW_COLOR} stroke="none" />
                  </g>
                );
              })}
              {pending &&
                drawHover &&
                (drawHover.t !== pending.t || drawHover.v !== pending.v) &&
                (() => {
                  const ext = extendLine({
                    t1: pending.t,
                    v1: pending.v,
                    t2: drawHover.t,
                    v2: drawHover.v,
                  });
                  return ext ? (
                    <line
                      x1={ext.x1}
                      x2={ext.x2}
                      y1={ext.y1}
                      y2={ext.y2}
                      stroke={DRAW_COLOR}
                      strokeWidth={1.4}
                      strokeDasharray="5 4"
                      opacity={0.75}
                    />
                  ) : null;
                })()}
            </g>
            {pending && (
              <circle cx={x(pending.t)} cy={y(pending.v)} r={4} fill={DRAW_COLOR} />
            )}
            {drawMode && drawHover && (
              <circle
                cx={x(drawHover.t)}
                cy={y(drawHover.v)}
                r={4}
                fill="none"
                stroke={DRAW_COLOR}
                strokeWidth={1.6}
              />
            )}
            {hoverPt && !panning && (
              <g>
                <line
                  x1={x(hoverPt.t)}
                  x2={x(hoverPt.t)}
                  y1={MT}
                  y2={MT + plotH}
                  stroke="var(--dim)"
                  strokeWidth={1}
                  opacity={0.55}
                />
                <circle
                  cx={x(hoverPt.t)}
                  cy={y(hoverPt.v)}
                  r={3.5}
                  fill="var(--bg)"
                  stroke="var(--accent)"
                  strokeWidth={2}
                />
              </g>
            )}
            {last && (
              <circle cx={x(last.t)} cy={y(last.v)} r={3} fill="var(--accent)" />
            )}
          </svg>
        )}
      </div>

      <p className="mt-2 text-[12px] leading-relaxed text-[var(--dim)]">
        Daily closes in USD · DeFiLlama coins API · Ratio = base ÷ quote. Pinch with two
        fingers to zoom — spread horizontally for dates, vertically for price. Drag to
        pan, scroll or use + / − to zoom the dates; the price axis re-fits the window as
        you move unless you have pinch-zoomed it (Reset restores it). Max shows the
        pair's full available history. Escape or a tap outside returns to the moon.
      </p>
    </div>
  );
}
