import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, Bell, Check,
  ChevronDown, Clock3, DatabaseZap, Info, Layers3, ListFilter,
  Sparkles, Star, Target, Volume2, VolumeX,
  RefreshCw, Search, ServerCrash, ShieldCheck, TrendingDown,
  Settings2, TrendingUp, Wifi, WifiOff, X,
} from 'lucide-react';
import {
  getGetElytraAlertsQueryKey,
  getGetElytraDashboardQueryKey,
  getGetElytraHistoryQueryKey,
  getGetElytraListingsQueryKey,
  getGetElytraTransactionsQueryKey,
  useGetElytraAlerts,
  useGetElytraDashboard,
  useGetElytraHistory,
  useGetElytraListings,
  useGetElytraTransactions,
  useAnalyzeElytraMarket,
} from '@workspace/api-client-react';

const CATEGORIES = ['elytra'] as const;
type Category = typeof CATEGORIES[number];
const HISTORY_RANGES = [
  { value: 'five_minutes', label: 'Last 5 minutes' },
  { value: 'hour', label: '1 hour' },
  { value: 'today', label: 'Today' },
  { value: 'seven_days', label: '7 days' },
  { value: 'thirty_days', label: '30 days' },
  { value: 'ninety_days', label: '90 days' },
  { value: 'one_year', label: '1 year' },
  { value: 'all_time', label: 'All time' },
] as const;
type Range = typeof HISTORY_RANGES[number]['value'];
type ListingSort = 'lowest' | 'highest' | 'recent';
type ChartPoint = { timestamp: string; price: number; open: number; high: number; low: number; close: number; priceChange: number | null; sampleSize: number; observationCount: number; category: string };
type MarketStat = { lowest: number | null; highest: number | null; average: number | null; median: number | null; activeListings: number; priceChange: number | null; currency: string };
const SETTINGS_STORAGE_KEYS = {
  median: 'elytra-market-custom-median',
  alertThreshold: 'elytra-market-alert-threshold',
  alertSound: 'elytra-market-alert-sound',
  favorites: 'elytra-market-favorites',
} as const;

const GEMINI_ANALYSIS_LIMIT = 5;

function readStoredNumber(key: string, fallback: number | null) {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function writeStoredNumber(key: string, value: number | null) {
  if (typeof window === 'undefined') return;
  if (value == null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, String(value));
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === 'true';
}

function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, String(value));
}

let alertAudioContext: AudioContext | null = null;

function playAlertSound() {
  if (typeof window === 'undefined') return;
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return;
  alertAudioContext ??= new AudioContextConstructor();
  const context = alertAudioContext;
  const play = () => {
    const now = context.currentTime;
    const chimes = [740, 740, 740];
    chimes.forEach((frequency, index) => {
      const start = now + index * 0.2;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.92, start + 0.16);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.19);
    });
  };
  if (context.state === 'suspended') void context.resume().then(play);
  else play();
}

function readStoredFavorites() {
  if (typeof window === 'undefined') return new Set<string>();
  try {
    const value = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEYS.favorites) || '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function writeStoredFavorites(favorites: Set<string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SETTINGS_STORAGE_KEYS.favorites, JSON.stringify([...favorites]));
}

function parsePriceInput(input: string) {
  const normalized = input.trim().replace(/,/g, '').toUpperCase();
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMBT])?$/);
  if (!match) return null;
  const base = Number(match[1]);
  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 }[match[2] as 'K' | 'M' | 'B' | 'T'] ?? 1;
  const value = base * multiplier;
  return Number.isFinite(value) && value > 0 ? value : null;
}

const categoryName: Record<Category, string> = {
  elytra: 'Elytra',
};
const categoryShort: Record<Category, string> = {
  elytra: 'Elytra',
};

function isCategory(value: string | undefined): value is Category {
  return !!value && (CATEGORIES as readonly string[]).includes(value);
}
function formatNumber(value: number | null | undefined, digits = 0) {
  return value == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}
function formatPrice(value: number | null | undefined, currency = 'coins') {
  return value == null ? '—' : `${formatNumber(value, 0)} ${currency}`;
}
function formatTime(value: string | null | undefined, withDate = false) {
  if (!value) return 'No timestamp';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', withDate ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' }).format(date);
}
function formatRelative(value: string | null | undefined) {
  if (!value) return 'not available';
  const diff = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}
function safeCategory(value: string): Category | null {
  return isCategory(value) ? value : null;
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-[hsl(222_22%_20%)] ${className}`} />;
}

function SectionHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div>
        <p className="mono text-[10px] uppercase tracking-[.2em] text-[hsl(var(--primary))]">{eyebrow}</p>
        <h2 className="display mt-1 text-lg font-bold tracking-tight text-[hsl(var(--foreground))]">{title}</h2>
        {detail && <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{detail}</p>}
      </div>
      {action}
    </div>
  );
}

function SelectControl({ value, onChange, children, label, testId }: { value: string; onChange: (value: string) => void; children: ReactNode; label: string; testId: string }) {
  return (
    <label className="relative flex items-center">
      <span className="sr-only">{label}</span>
      <select data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)} className="appearance-none rounded-lg border border-[hsl(var(--card-border))] bg-[hsl(var(--secondary))] py-2 pl-3 pr-8 text-xs font-semibold text-[hsl(var(--foreground))] outline-none transition-colors hover:border-[hsl(var(--primary)/.55)] focus:border-[hsl(var(--primary))]">
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 text-[hsl(var(--muted-foreground))]" />
    </label>
  );
}

function Delta({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="mono text-[11px] text-[hsl(var(--muted-foreground))]">No change</span>;
  const up = value > 0;
  const flat = value === 0;
  return (
    <span className={`inline-flex items-center gap-1 mono text-[11px] font-medium ${flat ? 'text-[hsl(var(--muted-foreground))]' : up ? 'text-[hsl(var(--destructive))]' : 'text-[hsl(var(--chart-3))]'}`}>
      {flat ? <Activity size={12} /> : up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {flat ? '0.0%' : `${up ? '+' : ''}${value.toFixed(1)}%`}
    </span>
  );
}

function StatusPill({ connected, label }: { connected: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 mono text-[10px] uppercase tracking-wider ${connected ? 'border-[hsl(var(--chart-3)/.28)] bg-[hsl(var(--chart-3)/.08)] text-[hsl(var(--chart-3))]' : 'border-[hsl(var(--destructive)/.3)] bg-[hsl(var(--destructive)/.08)] text-[hsl(var(--destructive))]'}`}>
      <span className={`live-dot h-1.5 w-1.5 rounded-full ${connected ? 'bg-[hsl(var(--chart-3))]' : 'bg-[hsl(var(--destructive))]'}`} />
      {label}
    </span>
  );
}

function ApiBanner({ api, generatedAt, isError, onRetry }: { api?: { connected: boolean; lastUpdated: string | null; requestsInWindow: number; requestLimit: number; message: string }; generatedAt?: string; isError: boolean; onRetry: () => void }) {
  const waiting = !api && !isError;
  const connected = !!api?.connected && !isError;
  const visibleConnected = connected || waiting;
  return (
    <div data-testid="status-api-banner" className={`panel flex flex-col gap-3 rounded-xl px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${visibleConnected ? 'cyan-rule' : 'amber-rule'}`}>
      <div className="flex items-start gap-3">
        {visibleConnected ? <Wifi size={18} className="mt-0.5 text-[hsl(var(--chart-3))]" /> : <WifiOff size={18} className="mt-0.5 text-[hsl(var(--accent))]" />}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold">{waiting ? 'Connecting to market feed' : connected ? 'Live market feed' : 'Feed unavailable'}</p>
            <StatusPill connected={visibleConnected} label={waiting ? 'connecting' : connected ? 'connected' : 'offline'} />
          </div>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{isError ? 'The market endpoint did not respond. Existing observations are not being replaced.' : api?.message || 'Opening the DonutSMP market feed.'}</p>
        </div>
      </div>
      <div className="flex items-center gap-4 sm:justify-end">
        <div className="text-right">
          <p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">last packet</p>
          <p className="mono mt-0.5 text-xs text-[hsl(var(--foreground))]">{formatRelative(api?.lastUpdated || generatedAt)}</p>
        </div>
         {api && <div className="hidden text-right sm:block"><p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">requests / last 60s</p><p className="mono mt-0.5 text-xs text-[hsl(var(--foreground))]">{api.requestsInWindow} / {api.requestLimit}</p></div>}
        {isError && <button type="button" data-testid="button-retry-dashboard" onClick={onRetry} className="rounded-lg border border-[hsl(var(--card-border))] p-2 text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--secondary))]" aria-label="Retry market feed"><RefreshCw size={15} /></button>}
      </div>
    </div>
  );
}

function StatCard({ category, stat, selected, onSelect, benchmarkMedian, hasCustomMedian, onEditMedian }: { category: Category; stat?: MarketStat; selected: boolean; onSelect: () => void; benchmarkMedian: number | null; hasCustomMedian: boolean; onEditMedian: () => void }) {
  const displayedMedian = benchmarkMedian ?? stat?.median;
  return (
    <div className={`panel cyan-rule group relative min-w-0 rounded-xl p-1 transition-all hover:-translate-y-0.5 hover:border-[hsl(var(--primary)/.55)] ${selected ? 'border-[hsl(var(--primary)/.7)] bg-[hsl(var(--primary)/.05)]' : ''}`}>
      <button type="button" data-testid={`button-category-${category}`} onClick={onSelect} className="w-full rounded-lg p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))]">
        <div className="flex items-start justify-between gap-2 pr-10">
          <div><p className="mono text-[10px] uppercase tracking-[.15em] text-[hsl(var(--muted-foreground))]">market</p><h3 className="display mt-1 text-sm font-bold">{categoryName[category]}</h3></div>
        </div>
        <div className="mt-5 flex items-end justify-between">
           <div><p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{hasCustomMedian ? 'your median' : 'cheapest benchmark'}</p><p data-testid={`text-median-${category}`} className="display mt-1 text-2xl font-bold tracking-tight">{displayedMedian != null ? formatPrice(displayedMedian, stat?.currency) : '—'}</p></div>
          <Delta value={stat?.priceChange} />
        </div>
         <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[hsl(var(--card-border))] pt-3 text-xs">
            <div><span className="text-[hsl(var(--muted-foreground))]">low </span><span className="mono">{formatPrice(stat?.lowest, stat?.currency)}</span></div>
            <div className="text-right"><span className="text-[hsl(var(--muted-foreground))]">active </span><span className="mono text-[hsl(var(--primary))]">{formatNumber(stat?.activeListings)}</span></div>
         </div>
      </button>
      <button type="button" data-testid={`button-edit-median-${category}`} onClick={onEditMedian} className={`absolute right-4 top-4 rounded-md p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))] ${selected ? 'bg-[hsl(var(--primary)/.14)] text-[hsl(var(--primary))]' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]'} hover:bg-[hsl(var(--primary)/.18)] hover:text-[hsl(var(--primary))]`} aria-label={`Set median benchmark for ${categoryName[category]}`} title="Set median benchmark">
        <Layers3 size={15} />
      </button>
    </div>
  );
}

function formatChartValue(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 }).format(value);
}

function formatChartAxisTime(timestamp: string, range: Range) {
  const date = new Date(timestamp);
  if (range === 'five_minutes' || range === 'today') {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  if (range === 'one_year' || range === 'all_time') {
    return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(date);
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

function buildSteppedPath(points: Array<{ x: number; y: number }>) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    path += ` L ${next.x} ${current.y} L ${next.x} ${next.y}`;
  }
  return path;
}

type ChartTransform = { scale: number; translateX: number; translateY: number };
const DEFAULT_CHART_TRANSFORM: ChartTransform = { scale: 1, translateX: 0, translateY: 0 };

function HistoryPanel({ points, loading, category, range, onRangeChange, median, onSaveMedian, medianEditorOpen, onCloseMedianEditor }: { points: ChartPoint[]; loading: boolean; category: Category; range: Range; onRangeChange: (range: Range) => void; median: number | null; onSaveMedian: (value: number | null) => void; medianEditorOpen: boolean; onCloseMedianEditor: () => void }) {
  const chartPoints = points.filter((point) => isCategory(point.category) && point.category === category);
  const renderPoints = chartPoints.length > 240
    ? chartPoints.filter((_, index) => index % Math.ceil(chartPoints.length / 240) === 0 || index === chartPoints.length - 1)
    : chartPoints;
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [chartTransform, setChartTransform] = useState<ChartTransform>(DEFAULT_CHART_TRANSFORM);
  const [medianInput, setMedianInput] = useState(median == null ? '' : String(median));
  const [medianInputDirty, setMedianInputDirty] = useState(false);
  const medianInputRef = useRef<HTMLInputElement>(null);
  const chartRef = useRef<SVGSVGElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchStartRef = useRef<{ distance: number; midpoint: { x: number; y: number }; transform: ChartTransform } | null>(null);
  useEffect(() => {
    if (!medianInputDirty) setMedianInput(median == null ? '' : String(median));
  }, [median, medianInputDirty]);
  useEffect(() => {
    if (medianEditorOpen) medianInputRef.current?.focus();
  }, [medianEditorOpen]);
  const saveMedian = () => {
    const value = parsePriceInput(medianInput);
    if (medianInput.trim() === '') {
      onSaveMedian(null);
      setMedianInputDirty(false);
      onCloseMedianEditor();
    } else if (value != null) {
      onSaveMedian(value);
      setMedianInputDirty(false);
      onCloseMedianEditor();
    }
  };
  const chartPrices = renderPoints.flatMap((point) => [point.high, point.low]);
  const dataMax = chartPrices.length ? Math.max(...chartPrices) : 1;
  const dataMin = chartPrices.length ? Math.min(...chartPrices) : 0;
  const dataRange = Math.max(dataMax - dataMin, 1);
  const chartMax = dataMax + dataRange * 0.08;
  const chartMin = Math.max(0, dataMin - dataRange * 0.08);
  const chartRange = Math.max(chartMax - chartMin, Number.EPSILON);
  const plotLeft = 54;
  const plotRight = 930;
  const plotTop = 28;
  const plotBottom = 276;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const priceToY = (price: number) => plotTop + ((chartMax - price) / chartRange) * plotHeight;
  const linePoints = renderPoints.map((point, index) => ({
    x: renderPoints.length === 1 ? plotLeft + plotWidth / 2 : plotLeft + (index / (renderPoints.length - 1)) * plotWidth,
    y: priceToY(point.close),
  }));
  const linePath = buildSteppedPath(linePoints);
  const areaPath = linePath ? `${linePath} L ${linePoints[linePoints.length - 1].x} ${plotBottom} L ${linePoints[0].x} ${plotBottom} Z` : '';
  const hoveredPoint = hoveredIndex == null ? null : renderPoints[hoveredIndex];
  const transformPoint = (point: { x: number; y: number }) => ({
    x: chartTransform.translateX + point.x * chartTransform.scale,
    y: chartTransform.translateY + point.y * chartTransform.scale,
  });
  const hoveredLinePoint = hoveredIndex == null ? null : transformPoint(linePoints[hoveredIndex]);
  const hoveredRatio = hoveredLinePoint == null
    ? 0.5
    : Math.min(1, Math.max(0, (hoveredLinePoint.x - plotLeft) / plotWidth));
  const tooltipAtStart = hoveredRatio < 0.18;
  const tooltipAtEnd = hoveredRatio > 0.82;
  const tooltipPositionClass = tooltipAtStart ? 'left-0' : tooltipAtEnd ? 'right-0' : 'left-1/2 -translate-x-1/2';
  const tooltipPositionStyle = tooltipAtStart || tooltipAtEnd ? undefined : { left: `${hoveredRatio * 100}%` };
  const yLabels = Array.from({ length: 5 }, (_, index) => chartMax - (chartRange * index) / 4);
  const chartIsZoomed = chartTransform.scale > 1.01 || Math.abs(chartTransform.translateX) > 1 || Math.abs(chartTransform.translateY) > 1;
  const toSvgPoint = (event: React.PointerEvent<SVGSVGElement> | React.WheelEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * 1000,
      y: ((event.clientY - bounds.top) / bounds.height) * 340,
    };
  };
  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, toSvgPoint(event));
    if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()];
      pinchStartRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        transform: chartTransform,
      };
      setHoveredIndex(null);
    }
  };
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, toSvgPoint(event));
    if (pointersRef.current.size < 2 || !pinchStartRef.current) return;
    const [first, second] = [...pointersRef.current.values()];
    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const pinchStart = pinchStartRef.current;
    const scale = Math.min(5, Math.max(1, pinchStart.transform.scale * (distance / pinchStart.distance)));
    const anchorX = (pinchStart.midpoint.x - pinchStart.transform.translateX) / pinchStart.transform.scale;
    const anchorY = (pinchStart.midpoint.y - pinchStart.transform.translateY) / pinchStart.transform.scale;
    setChartTransform({
      scale,
      translateX: midpoint.x - anchorX * scale,
      translateY: midpoint.y - anchorY * scale,
    });
  };
  const handlePointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointersRef.current.size < 2) pinchStartRef.current = null;
  };
  const handleWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const anchor = toSvgPoint(event);
    const scale = Math.min(5, Math.max(1, chartTransform.scale * Math.exp(-event.deltaY * 0.01)));
    const contentX = (anchor.x - chartTransform.translateX) / chartTransform.scale;
    const contentY = (anchor.y - chartTransform.translateY) / chartTransform.scale;
    setChartTransform({
      scale,
      translateX: anchor.x - contentX * scale,
      translateY: anchor.y - contentY * scale,
    });
  };
  return (
    <section className="panel relative min-w-0 overflow-hidden rounded-xl">
      <div className="flex flex-col gap-4 border-b border-[hsl(var(--card-border))] p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div>
          <p className="mono text-[10px] uppercase tracking-[.2em] text-[hsl(var(--accent))]">auction house price</p>
          <h2 className="display mt-1 text-lg font-bold tracking-tight">Observed Elytra price</h2>
           <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Showing stepped item value trends · pinch to zoom</p>
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-[hsl(var(--card-border))] bg-[hsl(var(--secondary)/.5)] p-1" role="tablist" aria-label="Price history range">
           {HISTORY_RANGES.map((option) => <button key={option.value} type="button" role="tab" aria-selected={range === option.value} data-testid={`button-history-range-${option.value}`} onClick={() => { setHoveredIndex(null); setChartTransform(DEFAULT_CHART_TRANSFORM); onRangeChange(option.value); }} className={`shrink-0 rounded-md px-2.5 py-1.5 text-[10px] font-semibold transition-colors sm:px-3 ${range === option.value ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm' : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'}`}>{option.label}</button>)}
        </div>
      </div>
      {medianEditorOpen && <div className="absolute right-2 top-2 z-40 flex items-end gap-2 bg-[#12161d] p-2">
        <label className="text-left">
          <span className="mono block text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">median benchmark</span>
          <input ref={medianInputRef} data-testid="input-custom-median" type="text" inputMode="decimal" value={medianInput} onChange={(event) => { setMedianInput(event.target.value); setMedianInputDirty(true); }} placeholder="e.g. 400M" aria-label="Median benchmark price" className="mt-1 w-28 bg-[#1b222c] px-2 py-1.5 text-xs text-[hsl(var(--foreground))] outline-none" />
        </label>
        <button type="button" data-testid="button-save-median" onClick={saveMedian} className="h-[31px] bg-[hsl(var(--primary))] px-2.5 text-[10px] font-bold text-[hsl(var(--primary-foreground))]"><Check size={12} /></button>
        {median != null && <button type="button" data-testid="button-reset-median" onClick={() => { setMedianInput(''); setMedianInputDirty(false); onSaveMedian(null); onCloseMedianEditor(); }} className="h-[31px] bg-[#1b222c] px-2 text-[10px] font-semibold text-[hsl(var(--muted-foreground))]">Reset</button>}
      </div>}
      {loading ? <div className="h-[340px] w-full bg-[#12161d]" /> : renderPoints.length < 1 ? (
        <div data-testid="empty-history" className="flex h-[280px] items-center justify-center bg-[#12161d] text-center text-xs text-[hsl(var(--muted-foreground))]">No price observations</div>
      ) : (
         <div className="relative h-[340px] w-full overflow-hidden bg-[#12161d]">
          {hoveredPoint && <div className={`pointer-events-none absolute top-0 z-30 w-48 bg-[#242b36] px-3 py-2 ${tooltipPositionClass}`} style={tooltipPositionStyle}>
            <p className="mono text-[9px] text-[hsl(var(--muted-foreground))]">{formatTime(hoveredPoint.timestamp, true)}</p>
            <p className="mt-1 text-lg font-bold text-[hsl(var(--foreground))]">{formatChartValue(hoveredPoint.close)} coins</p>
            <p className="mt-1 mono text-[9px] text-[hsl(var(--muted-foreground))]">{formatChartValue(hoveredPoint.observationCount)} observations · low {formatChartValue(hoveredPoint.low)}</p>
          </div>}
           {chartIsZoomed && <button type="button" data-testid="button-reset-chart-zoom" onPointerDown={(event) => event.stopPropagation()} onClick={() => setChartTransform(DEFAULT_CHART_TRANSFORM)} className="absolute right-3 top-3 z-20 inline-flex items-center gap-1 rounded-md border border-[hsl(var(--card-border))] bg-[#1c232d]/90 px-2 py-1.5 text-[10px] font-semibold text-[hsl(var(--foreground))] shadow-lg backdrop-blur-sm hover:border-[hsl(var(--primary)/.65)]" aria-label="Reset chart zoom"><RefreshCw size={11} /> Reset</button>}
           <svg ref={chartRef} viewBox="0 0 1000 340" className="block h-full w-full touch-none select-none text-[hsl(var(--muted-foreground))]" role="img" aria-label={`Stepped Elytra price chart for ${HISTORY_RANGES.find((option) => option.value === range)?.label}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerEnd} onPointerCancel={handlePointerEnd} onWheel={handleWheel}>
            <defs>
              <linearGradient id="history-area-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity=".18" />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
              </linearGradient>
               <clipPath id="history-plot-clip">
                 <rect x={plotLeft} y={plotTop} width={plotWidth} height={plotHeight} />
               </clipPath>
            </defs>
            {yLabels.map((value, index) => {
              const ratio = index / (yLabels.length - 1);
              const y = plotTop + ratio * plotHeight;
              return <g key={`${value}-${index}`}><line x1={plotLeft} x2={plotRight} y1={y} y2={y} stroke="currentColor" strokeDasharray="2 6" strokeOpacity=".22" /><text x="944" y={y + 3} fill="currentColor" fillOpacity=".7" fontFamily="var(--app-font-mono)" fontSize="10">{formatChartValue(value)}</text></g>;
            })}
             <g clipPath="url(#history-plot-clip)" transform={`translate(${chartTransform.translateX} ${chartTransform.translateY}) scale(${chartTransform.scale})`}>
               <path d={areaPath} fill="url(#history-area-fill)" />
               <path d={linePath} fill="none" stroke="hsl(var(--foreground))" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
               {renderPoints.map((point, index) => {
                 const linePoint = linePoints[index];
                 return <g key={`${point.timestamp}-${index}`} onPointerEnter={() => setHoveredIndex(index)} onPointerLeave={() => setHoveredIndex(null)} onFocus={() => setHoveredIndex(index)} onBlur={() => setHoveredIndex(null)}>
                   <rect x={linePoint.x - Math.max(plotWidth / renderPoints.length / 2, 7)} y={plotTop} width={Math.max(plotWidth / renderPoints.length, 14)} height={plotHeight} fill="transparent" tabIndex={0} role="button" aria-label={`${formatTime(point.timestamp, true)} at ${formatChartValue(point.close)}`} />
                   {hoveredIndex === index && <><line x1={linePoint.x} x2={linePoint.x} y1={plotTop} y2={plotBottom} stroke="currentColor" strokeDasharray="2 5" strokeOpacity=".45" /><circle cx={linePoint.x} cy={linePoint.y} r="5" fill="hsl(var(--primary))" stroke="hsl(var(--foreground))" strokeWidth="2" /></>}
                 </g>;
               })}
             </g>
            {[renderPoints[0], renderPoints[Math.floor((renderPoints.length - 1) / 2)], renderPoints[renderPoints.length - 1]].map((point, index) => {
              const x = index === 0 ? plotLeft : index === 1 ? plotLeft + plotWidth / 2 : plotRight;
              return <text key={`${point.timestamp}-${index}`} x={x} y="320" textAnchor={index === 0 ? 'start' : index === 2 ? 'end' : 'middle'} fill="currentColor" fillOpacity=".7" fontFamily="var(--app-font-mono)" fontSize="10">{formatChartAxisTime(point.timestamp, range)}</text>;
            })}
          </svg>
        </div>
      )}
    </section>
  );
}

type MarketAnalysis = {
  recommendation: 'YES' | 'NO';
  confidence: number;
  summary: string;
  reasons: string[];
  risks: string[];
  marketContext: { lowest: number | null; median: number | null; average: number | null; priceChange: number | null; activeListings: number; recentPrices: number[] };
  source: { auctionPages: number[]; historyRange: Range };
  usage: { used: number; remaining: number; limit: number };
};

function PredictionPanel({ range, loading }: { range: Range; loading: boolean }) {
  const marketAnalysis = useAnalyzeElytraMarket();
  const analysis = marketAnalysis.data as MarketAnalysis | undefined;
  const error = marketAnalysis.error as { message?: string; data?: { error?: string } } | null;
  const positive = analysis?.recommendation === 'YES';
  const rangeLabel = HISTORY_RANGES.find((option) => option.value === (analysis?.source.historyRange ?? range))?.label ?? 'selected range';
  const remaining = analysis?.usage.remaining;

  useEffect(() => {
    marketAnalysis.reset();
  }, [range]);

  const askAi = () => {
    marketAnalysis.reset();
    marketAnalysis.mutate({ data: { range } });
  };

  return (
    <section className={`panel min-w-0 rounded-xl p-4 sm:p-5 ${positive ? 'cyan-rule' : 'amber-rule'}`} data-testid="panel-ai-prediction">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="mono text-[10px] uppercase tracking-[.2em] text-[hsl(var(--accent))]">AI prediction</p>
          <h2 className="display mt-1 text-lg font-bold tracking-tight">Should you buy or sell?</h2>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">Gemini reads auction pages 1 + 2 and the selected price graph</p>
        </div>
        <span className="rounded-lg bg-[hsl(var(--primary)/.14)] p-2 text-[hsl(var(--primary))]"><Sparkles size={17} /></span>
      </div>
      {loading ? <div className="mt-6 space-y-3"><Skeleton className="h-14 w-full" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-2 w-full" /></div> : marketAnalysis.isPending ? <div className="mt-6 space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-4 w-11/12" /><Skeleton className="h-2 w-full" /><p className="mono text-[10px] text-[hsl(var(--primary))]">Sending live market context to Gemini…</p></div> : (
        <>
          {analysis ? <div className="mt-6">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">AI recommendation</p>
                <p data-testid="text-ai-recommendation" className={`display mt-1 text-5xl font-bold tracking-[-.06em] ${positive ? 'text-[hsl(var(--chart-3))]' : 'text-[hsl(var(--accent))]'}`}>{analysis.recommendation}</p>
              </div>
              <div className="text-right">
                <p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">confidence</p>
                <p data-testid="text-ai-confidence" className="display mt-1 text-3xl font-bold">{analysis.confidence}%</p>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-2 flex justify-between text-[10px]"><span className="text-[hsl(var(--muted-foreground))]">model confidence</span><span className="mono">{analysis.confidence}%</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--secondary))]"><div className={`h-full rounded-full transition-all ${positive ? 'bg-[hsl(var(--chart-3))]' : 'bg-[hsl(var(--accent))]'}`} style={{ width: `${analysis.confidence}%` }} /></div>
            </div>
            <p className="mt-4 text-sm leading-6">{analysis.summary}</p>
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[hsl(var(--card-border))] pt-4 text-xs">
              <div><span className="text-[hsl(var(--muted-foreground))]">market low </span><span className="mono">{formatPrice(analysis.marketContext.lowest)}</span></div>
              <div className="text-right"><span className="text-[hsl(var(--muted-foreground))]">range </span><span className="mono">{rangeLabel}</span></div>
              {analysis.marketContext.priceChange != null && <div><span className="text-[hsl(var(--muted-foreground))]">graph move </span><span className={analysis.marketContext.priceChange >= 0 ? 'text-[hsl(var(--destructive))]' : 'text-[hsl(var(--chart-3))]'}>{analysis.marketContext.priceChange >= 0 ? '+' : ''}{analysis.marketContext.priceChange.toFixed(1)}%</span></div>}
              <div className="text-right"><span className="text-[hsl(var(--muted-foreground))]">AI uses left </span><span className="mono">{analysis.usage.remaining}/{analysis.usage.limit}</span></div>
            </div>
            <div className="mt-4 grid gap-2 text-[10px] leading-4 text-[hsl(var(--muted-foreground))] sm:grid-cols-2">
              <p><span className="text-[hsl(var(--chart-3))]">Why: </span>{analysis.reasons[0] ?? 'The model found mixed evidence.'}</p>
              <p><span className="text-[hsl(var(--accent))]">Risk: </span>{analysis.risks[0] ?? 'Market conditions can change quickly.'}</p>
            </div>
          </div> : <div className="mt-6 rounded-lg border border-dashed border-[hsl(var(--card-border))] p-4 text-center"><Target size={20} className="mx-auto text-[hsl(var(--primary))]" /><p className="mt-2 text-sm font-semibold">Ask the AI for the market call</p><p className="mt-1 text-xs leading-5 text-[hsl(var(--muted-foreground))]">It will compare live auction pages 1 and 2 with the {HISTORY_RANGES.find((option) => option.value === range)?.label.toLowerCase()} graph and return only YES or NO.</p></div>}
          {error && <div data-testid="error-ai-prediction" className="mt-4 rounded-lg border border-[hsl(var(--destructive)/.3)] bg-[hsl(var(--destructive)/.08)] p-3 text-xs"><p className="font-bold">AI prediction unavailable</p><p className="mt-1 text-[hsl(var(--muted-foreground))]">{error.data?.error ?? error.message ?? 'Gemini could not complete the market analysis.'}</p></div>}
          <button type="button" data-testid="button-ask-ai" onClick={askAi} disabled={marketAnalysis.isPending || remaining === 0} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-4 py-2.5 text-xs font-bold text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"><Sparkles size={14} />{remaining === 0 ? 'Hourly AI limit reached' : analysis ? 'Ask AI again' : 'Ask AI: buy or sell?'}</button>
          <p className="mt-3 flex items-start gap-2 text-[10px] leading-4 text-[hsl(var(--muted-foreground))]"><Info size={13} className="mt-0.5 shrink-0 text-[hsl(var(--primary))]" /> AI output is a market signal, not a guarantee. Five analyses are available per rolling hour.</p>
        </>
      )}
    </section>
  );
}

type GeminiAnalysis = {
  listing: any;
  recommendation: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  summary: string;
  reasons: string[];
  risks: string[];
  marketContext: { lowest: number | null; median: number | null; average: number | null; priceChange: number | null; activeListings: number; recentPrices: number[] };
  usage: { used: number; remaining: number; limit: number };
};

function ListingAnalysisDialog({ analysis, loading, error, onClose }: { analysis: GeminiAnalysis | null; loading: boolean; error: string | null; onClose: () => void }) {
  if (!analysis && !loading && !error) return null;
  const positive = analysis?.recommendation === 'BUY';
  const negative = analysis?.recommendation === 'SELL';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 p-3 backdrop-blur-sm sm:items-center">
      <div role="dialog" aria-modal="true" aria-labelledby="gemini-analysis-title" className={`panel max-h-[90dvh] w-full max-w-lg overflow-auto rounded-2xl p-5 ${positive ? 'cyan-rule' : negative ? 'amber-rule' : 'border-[hsl(var(--primary)/.35)]'}`}>
        <div className="flex items-start justify-between gap-4">
          <div><p className="mono text-[10px] uppercase tracking-[.2em] text-[hsl(var(--primary))]">Gemini market read</p><h2 id="gemini-analysis-title" className="display mt-1 text-xl font-bold">Should you buy or sell?</h2><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">One of five available analyses · not financial advice</p></div>
          <button type="button" onClick={onClose} aria-label="Close Gemini analysis" className="rounded-md p-1.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))]"><X size={16} /></button>
        </div>
        {loading ? <div className="mt-6 space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-20 w-full" /></div> : error ? <div className="mt-6 rounded-lg border border-[hsl(var(--destructive)/.3)] bg-[hsl(var(--destructive)/.08)] p-4 text-sm"><p className="font-bold">Analysis unavailable</p><p className="mt-1 text-xs leading-5 text-[hsl(var(--muted-foreground))]">{error}</p></div> : analysis && (
          <>
            <div className="mt-6 flex items-end justify-between gap-3"><div><p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">recommendation</p><p data-testid="text-gemini-recommendation" className={`display mt-1 text-4xl font-bold ${positive ? 'text-[hsl(var(--chart-3))]' : negative ? 'text-[hsl(var(--accent))]' : 'text-[hsl(var(--muted-foreground))]'}`}>{analysis.recommendation}</p></div><div className="text-right"><p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">confidence</p><p data-testid="text-gemini-confidence" className="display mt-1 text-2xl font-bold">{analysis.confidence}%</p></div></div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-[hsl(var(--secondary))]"><div className={`h-full rounded-full ${positive ? 'bg-[hsl(var(--chart-3))]' : negative ? 'bg-[hsl(var(--accent))]' : 'bg-[hsl(var(--primary))]'}`} style={{ width: `${analysis.confidence}%` }} /></div>
            <p className="mt-4 text-sm leading-6">{analysis.summary}</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2"><div><p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Why</p><ul className="mt-2 space-y-2 text-xs leading-5">{analysis.reasons.map((reason) => <li key={reason} className="flex gap-2"><span className="text-[hsl(var(--chart-3))]">+</span>{reason}</li>)}</ul></div><div><p className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Risks</p><ul className="mt-2 space-y-2 text-xs leading-5">{analysis.risks.map((risk) => <li key={risk} className="flex gap-2"><span className="text-[hsl(var(--accent))]">!</span>{risk}</li>)}</ul></div></div>
            <div className="mt-5 grid grid-cols-2 gap-2 border-t border-[hsl(var(--card-border))] pt-4 text-xs"><div><span className="text-[hsl(var(--muted-foreground))]">listing price </span><span className="mono">{formatPrice(analysis.listing.price)}</span></div><div className="text-right"><span className="text-[hsl(var(--muted-foreground))]">market low </span><span className="mono">{formatPrice(analysis.marketContext.lowest)}</span></div></div>
            <p className="mt-4 text-[10px] text-[hsl(var(--muted-foreground))]">Gemini analyses used: {analysis.usage.used}/{analysis.usage.limit}. Confidence is an estimate, not a guarantee.</p>
          </>
        )}
      </div>
    </div>
  );
}

function ListingsPanel({ listings, loading, category, sort, setSort }: { listings: any[]; loading: boolean; category: Category; sort: ListingSort; setSort: (value: ListingSort) => void }) {
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(() => readStoredFavorites());
  const [analysis, setAnalysis] = useState<GeminiAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisUses, setAnalysisUses] = useState(0);
  const filtered = listings.filter((listing) => {
    const valid = safeCategory(listing.category);
    return valid === category && `${listing.displayName} ${listing.seller}`.toLowerCase().includes(search.toLowerCase());
  });
  const toggleFavorite = (listingId: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(listingId)) next.delete(listingId);
      else next.add(listingId);
      writeStoredFavorites(next);
      return next;
    });
  };
  const askGemini = async (listing: any) => {
    if (analysisLoading || analysisUses >= GEMINI_ANALYSIS_LIMIT) return;
    setAnalysisLoading(true);
    setAnalysis(null);
    setAnalysisError(null);
    try {
      const response = await fetch('/api/elytra/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId: listing.id }) });
      const payload = await response.json() as GeminiAnalysis & { error?: string; usage?: { used: number } };
      if (!response.ok) throw new Error(payload.error || 'Gemini could not complete the analysis.');
      setAnalysis(payload);
      setAnalysisUses(payload.usage.used);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'Gemini could not complete the analysis.');
    } finally {
      setAnalysisLoading(false);
    }
  };
  return (
    <section className="panel min-w-0 rounded-xl p-4 sm:p-5">
      <SectionHeading eyebrow="live inventory" title="Current listings" detail="Elytras returned by the DonutSMP Auction House search" action={<div className="flex items-center gap-2"><span className="mono rounded-md bg-[hsl(var(--secondary))] px-2 py-1 text-[10px] text-[hsl(var(--primary))]">{filtered.length} shown</span><span className="mono rounded-md bg-[hsl(var(--secondary))] px-2 py-1 text-[10px] text-[hsl(var(--muted-foreground))]">Gemini {analysisUses}/{GEMINI_ANALYSIS_LIMIT}</span></div>} />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1"><Search size={14} className="absolute left-3 top-2.5 text-[hsl(var(--muted-foreground))]" /><input data-testid="input-listing-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search seller or item ID" className="w-full rounded-lg border border-[hsl(var(--card-border))] bg-[hsl(var(--secondary))] py-2 pl-9 pr-3 text-xs outline-none placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))]" /></label>
        <SelectControl value={sort} onChange={(value) => setSort(value as ListingSort)} label="Listing sort" testId="select-listing-sort"><option value="recent">Recent</option><option value="lowest">Lowest</option><option value="highest">Highest</option></SelectControl>
      </div>
       <div className="scrollbar-thin max-h-[345px] overflow-auto">
          {loading ? <div className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : filtered.length === 0 ? <div data-testid="empty-listings" className="rounded-lg border border-dashed border-[hsl(var(--card-border))] px-4 py-9 text-center"><ListFilter size={20} className="mx-auto text-[hsl(var(--muted-foreground))]" /><p className="mt-2 text-sm font-semibold">{search ? 'No matching listings' : 'No active listings'}</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">The endpoint returned no direct Elytra listings for this filter.</p></div> : <div className="space-y-1.5">{filtered.map((listing) => <div data-testid={`row-listing-${listing.id}`} key={listing.id} className="group grid grid-cols-[1fr_auto] gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-[hsl(var(--card-border))] hover:bg-[hsl(var(--secondary)/.55)] sm:grid-cols-[1.25fr_.8fr_auto]">
           <div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-xs font-bold">{listing.displayName || 'Elytra'}</p><span className="hidden rounded bg-[hsl(var(--primary)/.1)] px-1.5 py-0.5 mono text-[9px] text-[hsl(var(--primary))] sm:inline">{categoryShort[safeCategory(listing.category) || 'elytra']}</span></div><p className="mt-1 truncate text-[10px] text-[hsl(var(--muted-foreground))]">{listing.seller} · {listing.quantity} unit{listing.quantity === 1 ? '' : 's'}{listing.timeRemaining ? ` · ${listing.timeRemaining}` : ''}</p></div>
          <p className="mono self-center text-right text-sm font-bold">{formatPrice(listing.price)}</p>
            <div className="col-start-1 flex items-center gap-1 sm:col-auto sm:self-center sm:justify-end"><p className="mr-auto text-[10px] text-[hsl(var(--muted-foreground))] sm:mr-2">{formatTime(listing.collectedAt)}</p><button type="button" data-testid={`button-favorite-${listing.id}`} onClick={() => toggleFavorite(listing.id)} aria-label={favorites.has(listing.id) ? `Unfavorite ${listing.displayName}` : `Favorite ${listing.displayName}`} className={`rounded-md p-1.5 transition-colors ${favorites.has(listing.id) ? 'text-[hsl(var(--accent))]' : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--accent))]'}`}><Star size={15} fill={favorites.has(listing.id) ? 'currentColor' : 'none'} /></button><button type="button" data-testid={`button-ask-gemini-${listing.id}`} disabled={analysisLoading || analysisUses >= GEMINI_ANALYSIS_LIMIT} onClick={() => void askGemini(listing)} aria-label={`Ask Gemini about ${listing.displayName}`} title={analysisUses >= GEMINI_ANALYSIS_LIMIT ? 'Gemini analysis limit reached' : 'Ask Gemini'} className="rounded-md bg-[hsl(var(--primary)/.12)] p-1.5 text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--primary)/.22)] disabled:cursor-not-allowed disabled:opacity-40"><Sparkles size={15} /></button></div>
        </div>)}</div>}
      </div>
      <ListingAnalysisDialog analysis={analysis} loading={analysisLoading} error={analysisError} onClose={() => { setAnalysis(null); setAnalysisError(null); }} />
    </section>
  );
}

function TransactionsPanel({ transactions, loading, category }: { transactions: any[]; loading: boolean; category: Category }) {
  const filtered = transactions.filter((item) => safeCategory(item.category) === category);
  return (
    <section className="panel min-w-0 rounded-xl p-4 sm:p-5">
      <SectionHeading eyebrow="recent prints" title="Recent market activity" detail="New Elytras observed by the tracker" action={<span className="mono rounded-md bg-[hsl(var(--secondary))] px-2 py-1 text-[10px] text-[hsl(var(--primary))]">Elytra</span>} />
       <div className="scrollbar-thin max-h-[340px] overflow-auto">
         {loading ? <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : filtered.length === 0 ? <div data-testid="empty-transactions" className="rounded-lg border border-dashed border-[hsl(var(--card-border))] px-4 py-9 text-center"><Clock3 size={20} className="mx-auto text-[hsl(var(--muted-foreground))]" /><p className="mt-2 text-sm font-semibold">No recent activity</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">No new Elytra listings have been observed yet.</p></div> : <div className="space-y-1.5">{filtered.map((item) => <div data-testid={`row-transaction-${item.id}`} key={item.id} className="grid grid-cols-[1fr_auto] gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-[hsl(var(--card-border)/.55)] hover:bg-[hsl(var(--secondary)/.55)]"><div><p className="text-xs font-bold">{item.seller}</p><p className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">{categoryShort[safeCategory(item.category) || 'elytra']} · {item.quantity} unit{item.quantity === 1 ? '' : 's'} · {formatTime(item.timestamp)}</p></div><p className="mono self-center text-sm font-bold">{formatPrice(item.price)}</p></div>)}</div>}
      </div>
    </section>
  );
}

function AlertsPanel({ alerts, loading, threshold, soundEnabled, onSaveThreshold, onSoundEnabledChange }: { alerts: any[]; loading: boolean; threshold: number; soundEnabled: boolean; onSaveThreshold: (value: number) => void; onSoundEnabledChange: (enabled: boolean) => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [thresholdInput, setThresholdInput] = useState(String(threshold));
  useEffect(() => {
    setThresholdInput(String(threshold));
  }, [threshold]);
  const valid = alerts.filter((alert) => safeCategory(alert.category));
  const saveThreshold = () => {
    const value = Math.floor(Number(thresholdInput));
    if (Number.isFinite(value) && value >= 1 && value <= 100) {
      onSaveThreshold(value);
      setSettingsOpen(false);
    }
  };
  return (
    <section className="panel min-w-0 rounded-xl p-4 sm:p-5">
       <SectionHeading eyebrow="market watch" title="Detected alerts" detail={`Buy and sell activity affecting ${threshold}+ units`} action={<div className="flex items-center gap-2"><button type="button" data-testid="button-alert-settings" onClick={() => setSettingsOpen((open) => !open)} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-bold transition-colors ${settingsOpen ? 'border-[hsl(var(--accent)/.5)] bg-[hsl(var(--accent)/.1)] text-[hsl(var(--accent))]' : 'border-[hsl(var(--card-border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'}`}><Settings2 size={13} /> Settings</button><Bell size={17} className="text-[hsl(var(--accent))]" /></div>} />
       {settingsOpen && <div data-testid="alert-settings" className="mb-4 rounded-lg border border-[hsl(var(--accent)/.3)] bg-[hsl(var(--accent)/.06)] p-3"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold">Alert sensitivity</p><p className="mt-1 text-[10px] leading-4 text-[hsl(var(--muted-foreground))]">Show alerts when at least this many units are added or removed.</p></div><button type="button" onClick={() => setSettingsOpen(false)} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]" aria-label="Close alert settings"><X size={14} /></button></div><div className="mt-3 flex items-end gap-2"><label className="flex-1"><span className="mono block text-[9px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">minimum units</span><input data-testid="input-alert-threshold" type="number" min="1" max="100" step="1" value={thresholdInput} onChange={(event) => setThresholdInput(event.target.value)} className="mt-1 w-full rounded-md border border-[hsl(var(--card-border))] bg-[hsl(var(--secondary)/.72)] px-2 py-1.5 text-xs outline-none focus:border-[hsl(var(--accent))]" /></label><button type="button" data-testid="button-save-alert-settings" onClick={saveThreshold} className="inline-flex h-[31px] items-center gap-1.5 rounded-md bg-[hsl(var(--accent))] px-2.5 text-[10px] font-bold text-[hsl(var(--accent-foreground))] hover:opacity-85"><Check size={12} /> Save</button></div><div className="mt-3 flex items-center justify-between gap-3 border-t border-[hsl(var(--accent)/.18)] pt-3"><div><p className="text-xs font-bold">Alert sound</p><p className="mt-1 text-[10px] leading-4 text-[hsl(var(--muted-foreground))]">Play a chime when a new alert is detected.</p></div><div className="flex shrink-0 items-center gap-1.5"><button type="button" data-testid="button-test-alert-sound" onClick={() => playAlertSound()} className="rounded-md border border-[hsl(var(--card-border))] px-2 py-1.5 text-[10px] font-bold text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">Test</button><button type="button" data-testid="button-toggle-alert-sound" aria-pressed={soundEnabled} onClick={() => onSoundEnabledChange(!soundEnabled)} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-bold transition-colors ${soundEnabled ? 'border-[hsl(var(--primary)/.45)] bg-[hsl(var(--primary)/.1)] text-[hsl(var(--primary))]' : 'border-[hsl(var(--card-border))] text-[hsl(var(--muted-foreground))]'}`}>{soundEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />} {soundEnabled ? 'On' : 'Off'}</button></div></div></div>}
      {loading ? <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div> : valid.length === 0 ? <div data-testid="empty-alerts" className="rounded-lg border border-dashed border-[hsl(var(--card-border))] px-4 py-9 text-center"><ShieldCheck size={20} className="mx-auto text-[hsl(var(--chart-3))]" /><p className="mt-2 text-sm font-semibold">No market alerts</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">No material activity has been detected in the current alert window.</p></div> : <div className="space-y-2">{valid.map((alert) => { const buy = alert.type === 'massive_buy'; return <div data-testid={`row-alert-${alert.id}`} key={alert.id} className={`rounded-lg border p-3 ${buy ? 'border-[hsl(var(--chart-3)/.22)] bg-[hsl(var(--chart-3)/.05)]' : 'border-[hsl(var(--accent)/.22)] bg-[hsl(var(--accent)/.05)]'}`}><div className="flex items-start gap-3"><span className={`mt-0.5 rounded-md p-1.5 ${buy ? 'bg-[hsl(var(--chart-3)/.12)] text-[hsl(var(--chart-3))]' : 'bg-[hsl(var(--accent)/.12)] text-[hsl(var(--accent))]'}`}>{buy ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}</span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="text-xs font-bold">{buy ? 'Massive buy' : 'Massive sell'} · {categoryShort[safeCategory(alert.category) || 'elytra']}</p><span className="mono text-[10px] text-[hsl(var(--muted-foreground))]">{formatRelative(alert.detectedAt)}</span></div><p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">{formatNumber(alert.affectedQuantity)} units affected{alert.estimatedValue != null ? ` · estimated ${formatPrice(alert.estimatedValue)}` : ''}</p>{alert.percentageChange != null && <div className="mt-2 flex gap-3 text-[10px]"><span className={buy ? 'text-[hsl(var(--chart-3))]' : 'text-[hsl(var(--accent))]'}>{buy ? 'Demand signal' : 'Supply signal'} {alert.percentageChange > 0 ? '+' : ''}{alert.percentageChange.toFixed(1)}%</span>{alert.previousPrice != null && alert.currentPrice != null && <span className="text-[hsl(var(--muted-foreground))]">{formatPrice(alert.previousPrice)} → {formatPrice(alert.currentPrice)}</span>}</div>}</div></div></div>; })}</div>}
    </section>
  );
}

export default function Dashboard() {
  const [category, setCategory] = useState<Category>(CATEGORIES[0]);
   const [historyRange, setHistoryRange] = useState<Range>('hour');
  const [listingCategory] = useState<Category>(CATEGORIES[0]);
  const [transactionCategory] = useState<Category>(CATEGORIES[0]);
  const [listingSort, setListingSort] = useState<ListingSort>('recent');
  const [medianEditorOpen, setMedianEditorOpen] = useState(false);
  const [customMedian, setCustomMedian] = useState<number | null>(() => readStoredNumber(SETTINGS_STORAGE_KEYS.median, null));
  const [alertThreshold, setAlertThreshold] = useState(() => Math.floor(readStoredNumber(SETTINGS_STORAGE_KEYS.alertThreshold, 10) ?? 10));
   const [alertSoundEnabled, setAlertSoundEnabled] = useState(() => readStoredBoolean(SETTINGS_STORAGE_KEYS.alertSound, true));
   const seenAlertIds = useRef<Set<string> | null>(null);

   const historyParams = useMemo(() => ({ range: historyRange, category }), [category, historyRange]);
  const listingParams = useMemo(() => ({ sort: listingSort, category: listingCategory }), [listingCategory, listingSort]);
  const transactionParams = useMemo(() => ({ category: transactionCategory }), [transactionCategory]);
  const alertParams = useMemo(() => ({ limit: 8, threshold: alertThreshold }), [alertThreshold]);

  const liveQueryOptions = { refetchInterval: 5000, refetchIntervalInBackground: true, staleTime: 1000 };
  const dashboardQuery = useGetElytraDashboard({ query: { queryKey: getGetElytraDashboardQueryKey(), ...liveQueryOptions } });
  const historyQuery = useGetElytraHistory(historyParams, { query: { queryKey: getGetElytraHistoryQueryKey(historyParams), ...liveQueryOptions } });
  const listingsQuery = useGetElytraListings(listingParams, { query: { queryKey: getGetElytraListingsQueryKey(listingParams), ...liveQueryOptions } });
  const transactionsQuery = useGetElytraTransactions(transactionParams, { query: { queryKey: getGetElytraTransactionsQueryKey(transactionParams), ...liveQueryOptions } });
  const alertsQuery = useGetElytraAlerts(alertParams, { query: { queryKey: getGetElytraAlertsQueryKey(alertParams), ...liveQueryOptions } });

  const dashboard = dashboardQuery.data;
  const stats = useMemo(() => (dashboard?.stats || []).filter((stat) => isCategory(stat.category)), [dashboard?.stats]);
  const history = useMemo(() => (historyQuery.data || []).filter((point) => isCategory(point.category)) as ChartPoint[], [historyQuery.data]);
  const listings = useMemo(() => listingsQuery.data || [], [listingsQuery.data]);
  const transactions = useMemo(() => transactionsQuery.data || [], [transactionsQuery.data]);
  const alerts = useMemo(() => alertsQuery.data || [], [alertsQuery.data]);
   useEffect(() => {
     if (!alertsQuery.isSuccess) return;
     const currentAlertIds = alerts
       .filter((alert) => safeCategory(alert.category) && alert.id != null)
       .map((alert) => String(alert.id));
     if (seenAlertIds.current === null) {
       seenAlertIds.current = new Set(currentAlertIds);
       return;
     }
     const isNewAlert = currentAlertIds.some((id) => !seenAlertIds.current?.has(id));
     currentAlertIds.forEach((id) => seenAlertIds.current?.add(id));
     if (isNewAlert && alertSoundEnabled) playAlertSound();
   }, [alertSoundEnabled, alerts, alertsQuery.isSuccess]);
  const selectedStat = stats.find((stat) => stat.category === category);
  const benchmarkMedian = customMedian ?? selectedStat?.lowest ?? null;
  const saveMedian = (value: number | null) => {
    setCustomMedian(value);
    writeStoredNumber(SETTINGS_STORAGE_KEYS.median, value);
  };
  const saveAlertThreshold = (value: number) => {
    setAlertThreshold(value);
    writeStoredNumber(SETTINGS_STORAGE_KEYS.alertThreshold, value);
  };
   const updateAlertSoundEnabled = (enabled: boolean) => {
     setAlertSoundEnabled(enabled);
     writeStoredBoolean(SETTINGS_STORAGE_KEYS.alertSound, enabled);
   };
  const refetchAll = () => { void dashboardQuery.refetch(); void historyQuery.refetch(); void listingsQuery.refetch(); void transactionsQuery.refetch(); void alertsQuery.refetch(); };

  return (
    <main className="min-h-[100dvh] shell-grid">
      <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--background)/.86)] backdrop-blur-md">
        <div className="mx-auto flex max-w-[1560px] items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl border border-[hsl(var(--primary)/.35)] bg-[hsl(var(--primary)/.1)]"><img src="/elytra-logo.png" alt="" className="h-full w-full object-contain" /></div><div><p className="display text-base font-bold tracking-tight">DonutSMP <span className="text-[hsl(var(--primary))]">/ Elytra</span></p><p className="mono text-[9px] uppercase tracking-[.2em] text-[hsl(var(--muted-foreground))]">market instrument panel</p></div></div>
           <div className="flex items-center gap-2 sm:gap-5"><div className="hidden items-center gap-2 text-right sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--chart-3))]" /><span className="mono text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">1 upstream call / 5s · lowest-price page</span></div><button type="button" data-testid="button-refresh-all" onClick={refetchAll} className="inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--card-border))] bg-[hsl(var(--secondary)/.6)] px-3 py-2 text-xs font-bold text-[hsl(var(--foreground))] transition-colors hover:border-[hsl(var(--primary)/.55)] hover:text-[hsl(var(--primary))]"><RefreshCw size={14} className={dashboardQuery.isFetching ? 'animate-spin' : ''} /><span className="hidden sm:inline">Refresh</span></button></div>
        </div>
      </header>
      <div className="mx-auto max-w-[1560px] px-4 pb-10 pt-6 sm:px-6 lg:px-8">
        <div className="fade-up"><ApiBanner api={dashboard?.api} generatedAt={dashboard?.generatedAt} isError={!!dashboardQuery.isError} onRetry={refetchAll} /></div>
         <div className="fade-up-delay mt-7 flex flex-col justify-between gap-4 md:flex-row md:items-end"><div><p className="mono text-[10px] uppercase tracking-[.24em] text-[hsl(var(--accent))]">live inventory monitor</p><h1 className="display mt-2 text-3xl font-bold tracking-[-.04em] sm:text-4xl">The Elytra market read.</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[hsl(var(--muted-foreground))]">A clean view of what the market is reporting now. Direct Elytra listings only, with no enchantment filter and no synthetic trend lines.</p></div><div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]"><DatabaseZap size={14} className="text-[hsl(var(--primary))]" /><span className="mono">{dashboard ? `${formatNumber(dashboard.qualifyingListings)} active units` : 'awaiting inventory count'}</span></div></div>
            {dashboardQuery.isLoading ? <div className="mt-6 grid gap-3 md:grid-cols-1"><Skeleton className="h-48 rounded-xl" /></div> : dashboardQuery.isError && !dashboard ? <div data-testid="error-dashboard" className="panel amber-rule mt-6 rounded-xl p-8 text-center"><ServerCrash size={25} className="mx-auto text-[hsl(var(--accent))]" /><h2 className="display mt-3 text-lg font-bold">Market snapshot unavailable</h2><p className="mx-auto mt-2 max-w-md text-sm text-[hsl(var(--muted-foreground))]">The dashboard endpoint is offline. Nothing is being inferred from missing data.</p><button type="button" data-testid="button-retry-dashboard-empty" onClick={refetchAll} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))]"><RefreshCw size={14} /> Retry connection</button></div> : <><div className="fade-up-delay-2 mt-6 grid gap-3">{CATEGORIES.map((item) => <StatCard key={item} category={item} stat={stats.find((stat) => stat.category === item)} benchmarkMedian={customMedian ?? stats.find((stat) => stat.category === item)?.lowest ?? null} hasCustomMedian={customMedian != null} selected={category === item} onSelect={() => setCategory(item)} onEditMedian={() => setMedianEditorOpen(true)} />)}</div><div className="mt-6 grid items-start gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,.8fr)]"><HistoryPanel points={history} loading={historyQuery.isLoading} category={category} range={historyRange} onRangeChange={setHistoryRange} median={benchmarkMedian} onSaveMedian={saveMedian} medianEditorOpen={medianEditorOpen} onCloseMedianEditor={() => setMedianEditorOpen(false)} /><div className="grid gap-4"><PredictionPanel range={historyRange} loading={historyQuery.isLoading} /><AlertsPanel alerts={alerts} loading={alertsQuery.isLoading} threshold={alertThreshold} soundEnabled={alertSoundEnabled} onSaveThreshold={saveAlertThreshold} onSoundEnabledChange={updateAlertSoundEnabled} /></div></div><div className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_1fr]"><ListingsPanel listings={listings} loading={listingsQuery.isLoading} category={listingCategory} sort={listingSort} setSort={setListingSort} /><TransactionsPanel transactions={transactions} loading={transactionsQuery.isLoading} category={transactionCategory} /></div></>}
          <footer className="mt-7 flex flex-col gap-2 border-t border-[hsl(var(--border))] pt-4 text-[10px] text-[hsl(var(--muted-foreground))] sm:flex-row sm:items-center sm:justify-between"><span className="inline-flex items-center gap-2"><Check size={13} className="text-[hsl(var(--chart-3))]" /> Live scope locked to DonutSMP Elytra search</span><span className="mono">{dashboard?.generatedAt ? `snapshot generated ${formatTime(dashboard.generatedAt, true)}` : 'snapshot time unavailable'}</span></footer>
      </div>
    </main>
  );
}