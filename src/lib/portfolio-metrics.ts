import { compareAsc, parseISO, isValid } from "date-fns";
import { mean, quantile, sampleStandardDeviation } from "simple-statistics";
import type { NormalizedDataset, PriceRow, TransactionRow } from "./schemas.js";

export interface DailyPoint {
  date: string;
  marketValue: number;
  positions: Record<string, number>;
}

export interface RiskMetricsResult {
  [key: string]: unknown;
  sample: { startDate: string; endDate: string; tradingDays: number };
  returns: {
    dailyMean: number;
    dailyVolatility: number;
    annualizedReturn: number;
    annualizedVolatility: number;
  };
  ratios: {
    sharpeRatio: number | null;
    sortinoRatio: number | null;
    maxDrawdown: number;
    maxDrawdownPct: number;
  };
  varHistorical: {
    confidence: number;
    varDailyReturn: number;
    varDailyPct: number;
    expectedShortfallDaily: number;
    expectedShortfallPct: number;
  };
  concentration: {
    asOfDate: string;
    weights: Record<string, number>;
    hhi: number;
  };
  warnings: string[];
}

function parseTxTime(t: TransactionRow): Date {
  const d = parseISO(t.datetime.replace(" ", "T"));
  if (!isValid(d)) throw new Error(`Invalid transaction datetime: ${t.datetime}`);
  return d;
}

function parsePriceDate(p: PriceRow): string {
  const d = parseISO(p.date.length > 10 ? p.date : `${p.date}T00:00:00Z`);
  if (!isValid(d)) throw new Error(`Invalid price date: ${p.date}`);
  return p.date.slice(0, 10);
}

/** Build price lookup: symbol -> (date -> close) */
function priceLookup(prices: PriceRow[]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const p of prices) {
    const sym = p.symbol.trim();
    const d = parsePriceDate(p);
    if (!m.has(sym)) m.set(sym, new Map());
    m.get(sym)!.set(d, p.close);
  }
  return m;
}

function positionsAsOf(transactions: TransactionRow[], asOf: Date): Record<string, number> {
  const pos: Record<string, number> = {};
  const sorted = [...transactions].sort((a, b) => compareAsc(parseTxTime(a), parseTxTime(b)));
  for (const tx of sorted) {
    if (parseTxTime(tx) > asOf) break;
    const sym = tx.symbol.trim();
    if (tx.side !== "buy" && tx.side !== "sell") continue;
    if (!pos[sym]) pos[sym] = 0;
    if (tx.side === "buy") pos[sym] += tx.quantity;
    else pos[sym] -= tx.quantity;
    if (Math.abs(pos[sym]) < 1e-12) delete pos[sym];
  }
  return pos;
}

function marketValueForDate(
  positions: Record<string, number>,
  dateStr: string,
  px: Map<string, Map<string, number>>
): { mv: number; missing: string[] } {
  let mv = 0;
  const missing: string[] = [];
  for (const [sym, qty] of Object.entries(positions)) {
    if (qty === 0) continue;
    const row = px.get(sym);
    const close = row?.get(dateStr);
    if (close === undefined) {
      missing.push(sym);
      continue;
    }
    mv += qty * close;
  }
  return { mv, missing };
}

export function buildDailySeries(dataset: NormalizedDataset): { series: DailyPoint[]; warnings: string[] } {
  const warnings: string[] = [];
  const px = priceLookup(dataset.prices);
  const dateSet = new Set<string>();
  for (const p of dataset.prices) dateSet.add(parsePriceDate(p));
  const dates = [...dateSet].sort();
  if (dates.length < 2) {
    warnings.push("Need at least two distinct price dates to compute returns.");
    return { series: [], warnings };
  }

  const series: DailyPoint[] = [];
  for (const d of dates) {
    const asOf = parseISO(`${d}T23:59:59Z`);
    const positions = positionsAsOf(dataset.transactions, asOf);
    const { mv, missing } = marketValueForDate(positions, d, px);
    if (missing.length) warnings.push(`Missing prices on ${d} for: ${missing.join(", ")}`);
    series.push({ date: d, marketValue: mv, positions });
  }
  return { series, warnings };
}

function maxDrawdownFromValues(values: number[]): { maxDd: number; maxDdPct: number } {
  if (values.length === 0) return { maxDd: 0, maxDdPct: 0 };
  let peak = values[0];
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = v / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }
  const maxDdPct = maxDd * 100;
  return { maxDd, maxDdPct };
}

function sortinoRatio(dailyReturns: number[], riskFreeDaily: number): number | null {
  if (dailyReturns.length < 2) return null;
  const mar = riskFreeDaily / 252;
  const downs = dailyReturns.map((r) => Math.min(0, r - mar));
  const downsideVar = mean(downs.map((x) => x * x));
  if (downsideVar <= 0) return null;
  const downsideDev = Math.sqrt(downsideVar) * Math.sqrt(252);
  const annExcess = mean(dailyReturns) * 252 - riskFreeDaily;
  if (downsideDev === 0) return null;
  return annExcess / downsideDev;
}

export function computeRiskMetrics(
  dataset: NormalizedDataset,
  opts: { riskFreeAnnual?: number; varConfidence?: number } = {}
): RiskMetricsResult {
  const riskFreeAnnual = opts.riskFreeAnnual ?? 0;
  const confidence = opts.varConfidence ?? 0.95;
  const warnings: string[] = [];

  const { series, warnings: w2 } = buildDailySeries(dataset);
  warnings.push(...w2);

  if (series.length < 2) {
    return {
      sample: { startDate: "", endDate: "", tradingDays: 0 },
      returns: {
        dailyMean: 0,
        dailyVolatility: 0,
        annualizedReturn: 0,
        annualizedVolatility: 0,
      },
      ratios: { sharpeRatio: null, sortinoRatio: null, maxDrawdown: 0, maxDrawdownPct: 0 },
      varHistorical: {
        confidence,
        varDailyReturn: 0,
        varDailyPct: 0,
        expectedShortfallDaily: 0,
        expectedShortfallPct: 0,
      },
      concentration: { asOfDate: "", weights: {}, hhi: 0 },
      warnings,
    };
  }

  const values = series.map((s) => s.marketValue);
  const dailyReturns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (prev <= 0 || cur <= 0) {
      dailyReturns.push(0);
      warnings.push(`Non-positive market value around ${series[i].date}; return set to 0 for that day.`);
    } else {
      dailyReturns.push(cur / prev - 1);
    }
  }

  const dailyMean = mean(dailyReturns);
  const dailyVol = dailyReturns.length >= 2 ? sampleStandardDeviation(dailyReturns) : 0;
  const annualizedReturn = dailyMean * 252;
  const annualizedVolatility = dailyVol * Math.sqrt(252);
  const sharpeRatio =
    annualizedVolatility > 0 ? (annualizedReturn - riskFreeAnnual) / annualizedVolatility : null;

  const { maxDd, maxDdPct } = maxDrawdownFromValues(values);
  const sortino = sortinoRatio(dailyReturns, riskFreeAnnual);

  const alpha = 1 - confidence;
  const q = quantile(dailyReturns, alpha);
  const tail = dailyReturns.filter((r) => r <= q);
  const es = tail.length ? mean(tail) : q;

  const last = series[series.length - 1];
  const weights: Record<string, number> = {};
  const mv = last.marketValue;
  if (mv > 0) {
    for (const [sym, qty] of Object.entries(last.positions)) {
      const close = priceLookup(dataset.prices).get(sym.trim())?.get(last.date);
      if (close === undefined) continue;
      const w = (qty * close) / mv;
      if (Math.abs(w) > 1e-12) weights[sym] = w;
    }
  }
  const hhi = Object.values(weights).reduce((s, w) => s + w * w, 0);

  return {
    sample: {
      startDate: series[0].date,
      endDate: last.date,
      tradingDays: dailyReturns.length,
    },
    returns: {
      dailyMean,
      dailyVolatility: dailyVol,
      annualizedReturn,
      annualizedVolatility,
    },
    ratios: {
      sharpeRatio,
      sortinoRatio: sortino,
      maxDrawdown: maxDd,
      maxDrawdownPct: maxDdPct,
    },
    varHistorical: {
      confidence,
      varDailyReturn: -q,
      varDailyPct: -q * 100,
      expectedShortfallDaily: -es,
      expectedShortfallPct: -es * 100,
    },
    concentration: {
      asOfDate: last.date,
      weights,
      hhi,
    },
    warnings,
  };
}

export function buildTearsheetMarkdown(dataset: NormalizedDataset, metrics: RiskMetricsResult, title: string): string {
  const lines: string[] = [`# ${title}`, "", `**Base currency:** ${dataset.baseCcy}`, ""];
  lines.push("## Sample");
  lines.push(`- **Range:** ${metrics.sample.startDate} → ${metrics.sample.endDate}`);
  lines.push(`- **Trading days (returns):** ${metrics.sample.tradingDays}`);
  lines.push("");
  lines.push("## Returns & volatility");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Annualized return | ${(metrics.returns.annualizedReturn * 100).toFixed(2)}% |`);
  lines.push(`| Annualized volatility | ${(metrics.returns.annualizedVolatility * 100).toFixed(2)}% |`);
  lines.push("");
  lines.push("## Risk ratios");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Sharpe | ${metrics.ratios.sharpeRatio === null ? "n/a" : metrics.ratios.sharpeRatio.toFixed(3)} |`);
  lines.push(`| Sortino | ${metrics.ratios.sortinoRatio === null ? "n/a" : metrics.ratios.sortinoRatio.toFixed(3)} |`);
  lines.push(`| Max drawdown | ${(metrics.ratios.maxDrawdown * 100).toFixed(2)}% |`);
  lines.push("");
  lines.push("## Historical VaR / ES");
  lines.push(`| Confidence | VaR (1d return) | ES (1d return) |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(
    `| ${(metrics.varHistorical.confidence * 100).toFixed(0)}% | ${(metrics.varHistorical.varDailyPct).toFixed(3)}% | ${(metrics.varHistorical.expectedShortfallPct).toFixed(3)}% |`
  );
  lines.push("");
  lines.push("## Concentration (end of sample)");
  lines.push(`- **HHI:** ${metrics.concentration.hhi.toFixed(4)}`);
  lines.push("");
  lines.push("### Weights");
  const w = metrics.concentration.weights;
  const keys = Object.keys(w).sort((a, b) => Math.abs(w[b]) - Math.abs(w[a]));
  for (const k of keys.slice(0, 20)) {
    lines.push(`- **${k}:** ${(w[k] * 100).toFixed(2)}%`);
  }
  if (keys.length > 20) lines.push(`- …and ${keys.length - 20} more`);
  lines.push("");
  if (metrics.warnings.length) {
    lines.push("## Warnings");
    for (const warn of metrics.warnings) lines.push(`- ${warn}`);
  }
  return lines.join("\n");
}
