import { describe, it, expect } from "vitest";
import {
  validateDataset,
  normalizeTransactions,
  computeRiskMetricsTool,
  generateTearsheet,
} from "../src/tools.js";

const sampleTxCsv = `datetime,symbol,asset_type,side,quantity,price,price_ccy
2024-01-02T15:00:00Z,AAPL,equity,buy,10,180,USD
2024-01-10T15:00:00Z,AAPL,equity,sell,3,185,USD`;

const samplePxCsv = `date,symbol,close,ccy
2024-01-01,AAPL,175,USD
2024-01-02,AAPL,180,USD
2024-01-03,AAPL,182,USD
2024-01-04,AAPL,181,USD
2024-01-05,AAPL,183,USD
2024-01-08,AAPL,184,USD
2024-01-09,AAPL,186,USD
2024-01-10,AAPL,185,USD
2024-01-11,AAPL,187,USD`;

describe("validate_dataset", () => {
  it("validates sample CSVs", () => {
    const r = validateDataset({
      transactionsCsv: sampleTxCsv,
      pricesCsv: samplePxCsv,
      baseCcy: "USD",
    });
    expect(r.ok).toBe(true);
    expect(r.transactionCount).toBe(2);
    expect(r.priceCount).toBeGreaterThan(3);
  });
});

describe("normalize_transactions", () => {
  it("normalizes canonical CSV", () => {
    const r = normalizeTransactions(sampleTxCsv);
    expect(r.rowCount).toBe(2);
    expect(r.normalized[0].symbol).toBe("AAPL");
    expect(r.normalized[0].side).toBe("buy");
  });
});

describe("compute_risk_metrics", () => {
  it("computes metrics from normalized data", () => {
    const norm = normalizeTransactions(sampleTxCsv);
    const prices = samplePxCsv
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const [date, symbol, close, ccy] = line.split(",");
        return { date, symbol, close: Number(close), ccy };
      });
    const out = computeRiskMetricsTool({
      transactions: norm.normalized,
      prices,
      baseCcy: "USD",
      riskFreeAnnual: 0,
      varConfidence: 0.95,
    });
    expect(out.datasetFingerprint).toHaveLength(16);
    expect(out.metrics.sample.tradingDays).toBeGreaterThan(0);
    expect(out.metrics.returns.annualizedVolatility).toBeGreaterThanOrEqual(0);
  });
});

describe("generate_tearsheet", () => {
  it("returns markdown and artifacts", () => {
    const norm = normalizeTransactions(sampleTxCsv);
    const prices = samplePxCsv
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const [date, symbol, close, ccy] = line.split(",");
        return { date, symbol, close: Number(close), ccy };
      });
    const r = generateTearsheet({
      transactions: norm.normalized,
      prices,
      title: "Test book",
    });
    expect(r.markdown).toContain("# Test book");
    expect(r.artifacts.some((a) => a.name === "tearsheet.md")).toBe(true);
  });
});
